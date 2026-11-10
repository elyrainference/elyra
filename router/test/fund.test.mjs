// "Fund from your wallet": the wallet pays, the NODE address is credited via escrow.depositFor. Runs on a local EVM (hardhat node);
// skips when contracts/node_modules is absent. Also covers the Reown project-id gate on /api/chain.
// Run: node --test router/test/fund.test.mjs   (after: cd contracts && npm install)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { ContractFactory, JsonRpcProvider, NonceManager, Wallet, parseEther } from "ethers";
import { balances, deposit, mintTest, toUnits } from "../../tools/wallet/src/fund.mjs";
import { reownProjectId } from "../http/api-chain.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hardhatCli = join(root, "contracts", "node_modules", "hardhat", "internal", "cli", "cli.js");
const have = existsSync(hardhatCli) && existsSync(join(root, "contracts", "artifacts", "ElyraEscrow.json"));
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // public hardhat account #0

describe("amount parsing and the project-id gate (no chain needed)", () => {
  test("toUnits is strict: decimals, no signs, no zero, no exponent", () => {
    assert.equal(toUnits("10"), 10_000_000n);
    assert.equal(toUnits("2.5"), 2_500_000n);
    assert.equal(toUnits("0.000001"), 1n);
    for (const bad of ["", "0", "0.0", "-1", "1e3", "abc", "1,5", "1.0000000", " "]) assert.throws(() => toUnits(bad), /amount|Enter/i, JSON.stringify(bad));
  });
  test("only a 32-hex project id enables wallet connect", () => {
    assert.equal(reownProjectId({ ELYRA_REOWN_PROJECT_ID: "0123456789abcdef0123456789abcdef" }), "0123456789abcdef0123456789abcdef");
    for (const bad of [undefined, "", "short", "g".repeat(32), "0123456789abcdef0123456789abcdef0", "x https://evil"]) assert.equal(reownProjectId({ ELYRA_REOWN_PROJECT_ID: bad }), null, String(bad));
  });
});

describe("fund from wallet (local EVM)", { skip: !have && "contracts/node_modules missing" }, () => {
  const PORT = 18575, RPC = `http://127.0.0.1:${PORT}`;
  const procs = [];
  let provider, deployer, token, escrow, cfg, user, node;
  const art = (n) => JSON.parse(readFileSync(join(root, "contracts", "artifacts", n + ".json"), "utf8"));
  const until = async (fn, ms = 20000) => { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 150)); } };

  before(async () => {
    procs.push(spawn(process.execPath, [hardhatCli, "node", "--port", String(PORT)], { cwd: join(root, "contracts"), stdio: "pipe" }));
    provider = new JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
    await until(() => provider.getNetwork());
    deployer = new NonceManager(new Wallet(DEV_KEY, provider));
    const tok = await new ContractFactory(art("MockUSDG").abi, art("MockUSDG").bytecode, deployer).deploy(); await tok.waitForDeployment();
    const esc = await new ContractFactory(art("ElyraEscrow").abi, art("ElyraEscrow").bytecode, deployer).deploy(await tok.getAddress()); await esc.waitForDeployment();
    token = await tok.getAddress(); escrow = await esc.getAddress();
    user = new NonceManager(Wallet.createRandom().connect(provider)); // the visitor's wallet
    node = Wallet.createRandom().address;                              // the node's own address (never signs here)
    await (await deployer.sendTransaction({ to: await user.getAddress(), value: parseEther("1") })).wait();
    cfg = { token, escrow, node, decimals: 6 };
  });
  after(() => procs.forEach((p) => p.kill()));

  test("mintTest credits the visitor's wallet; balances reads it", async () => {
    await mintTest(user, cfg, "25");
    const b = await balances(user, cfg);
    assert.equal(b.usd, 25);
    assert.equal(b.nodeDepositUsd, 0);
  });

  test("deposit = approve + depositFor: the NODE address is credited, the visitor is debited", async () => {
    const steps = [];
    const r = await deposit(user, cfg, "10", (s) => steps.push(s));
    assert.deepEqual(steps, ["approve", "deposit"]);
    assert.equal(r.hashes.length, 2);
    const b = await balances(user, cfg);
    assert.equal(b.usd, 15, "visitor paid");
    assert.equal(b.nodeDepositUsd, 10, "node credited");
    const { Contract } = await import("ethers");
    const e = new Contract(escrow, ["function deposits(address) view returns (uint256)"], provider);
    assert.equal(await e.deposits(await user.getAddress()), 0n, "nothing is credited to the visitor's own address");
  });

  test("a second deposit reuses the allowance only when it is enough", async () => {
    const steps = [];
    await deposit(user, cfg, "5", (s) => steps.push(s));
    assert.deepEqual(steps, ["approve", "deposit"], "allowance was spent by the first deposit, so it approves again");
    assert.equal((await balances(user, cfg)).nodeDepositUsd, 15);
  });

  test("refuses more than the wallet holds, and refuses to touch anything before failing", async () => {
    const before = await balances(user, cfg);
    await assert.rejects(() => deposit(user, cfg, "1000"), /does not hold enough/);
    const after = await balances(user, cfg);
    assert.equal(after.usd, before.usd); assert.equal(after.nodeDepositUsd, before.nodeDepositUsd);
  });

  test("bad node config is rejected before any transaction", async () => {
    await assert.rejects(() => deposit(user, { ...cfg, node: "nope" }, "1"), /node address/);
    await assert.rejects(() => deposit(user, { ...cfg, escrow: undefined }, "1"), /escrow address/);
    await assert.rejects(() => deposit(user, cfg, "-5"), /Enter an amount/);
  });
});
