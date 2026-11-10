// End-to-end settlement on a local EVM (hardhat node). Skips when contracts/node_modules is absent.
// Run: node --test router/test/chain.test.mjs   (after: cd contracts && npm install)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { sealTo } from "../seal.mjs";
import { ContractFactory, JsonRpcProvider, NonceManager, Wallet, parseEther } from "ethers";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hardhatCli = join(root, "contracts", "node_modules", "hardhat", "internal", "cli", "cli.js");
const have = existsSync(hardhatCli) && existsSync(join(root, "contracts", "artifacts", "ElyraEscrow.json"));
const J = { "content-type": "application/json" };
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // public hardhat account #0

describe("on-chain settlement (local EVM)", { skip: !have && "contracts/node_modules missing" }, () => {
  const procs = [], dirs = [];
  const RPC_PORT = 18555, A = 18565, B = 18566, STUB = 18567, RPC = `http://127.0.0.1:${RPC_PORT}`;
  const spawnNode = (args, cwd) => { const p = spawn(process.execPath, args, { cwd, stdio: "pipe" }); procs.push(p); return p; };
  const until = async (fn, ms = 20000) => { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 150)); } };
  const call = (port) => async (p, method = "GET", body) => { const r = await fetch(`http://localhost:${port}${p}`, { method, headers: J, body: body && JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
  const a = call(A), b = call(B);
  let escrow, provider, deployer, tokenAddr, art;

  const stub = createServer((req, res) => {
    if (req.url.endsWith("/models")) return res.setHeader("content-type", "application/json"), res.end(JSON.stringify({ data: [{ id: "stub-1" }] }));
    req.resume();
    req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "x".repeat(32000) } }], usage: { prompt_tokens: 12, completion_tokens: 8000 } })); });
  });

  before(async () => {
    spawnNode([hardhatCli, "node", "--port", String(RPC_PORT)], join(root, "contracts"));
    provider = new JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
    await until(() => provider.getNetwork());
    deployer = new NonceManager(new Wallet(DEV_KEY, provider));
    art = (n) => JSON.parse(readFileSync(join(root, "contracts", "artifacts", n + ".json"), "utf8"));
    const tok = await new ContractFactory(art("MockUSDG").abi, art("MockUSDG").bytecode, deployer).deploy();
    await tok.waitForDeployment();
    const c = await new ContractFactory(art("ElyraEscrow").abi, art("ElyraEscrow").bytecode, deployer).deploy(await tok.getAddress());
    await c.waitForDeployment();
    escrow = await c.getAddress();
    tokenAddr = await tok.getAddress();

    await new Promise((r) => stub.listen(STUB, r));
    for (const [port, name] of [[A, "consumer"], [B, "provider"]]) {
      const dir = mkdtempSync(join(tmpdir(), "vpr-chain-")); dirs.push(dir);
      spawnNode([join(root, "router", "server.mjs"), "--port", String(port), "--data", dir, "--name", name, "--no-demo"]);
      await until(async () => (await fetch(`http://localhost:${port}/p2p/hello`)).ok);
    }
  });
  after(() => { stub.close(); procs.forEach((p) => p.kill()); setTimeout(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })), 500); });

  const chat = () => fetch(`http://localhost:${A}/v1/chat/completions`, { method: "POST", headers: J, body: JSON.stringify({ model: "stub-1", messages: [{ role: "user", content: "ping" }] }) });

  test("consumer in chain mode refuses a provider that still settles off-chain", async () => {
    const up = await b("/api/upstreams", "POST", { name: "stub", baseUrl: `http://localhost:${STUB}/v1` });
    await b("/api/provide", "PUT", { enabled: true, upstreamId: up.id, price: 30, autoRedeem: false, creditUsd: 1 }); // $30 / MTok × 8012 tokens = $0.24036; manual settle so the test controls when redeem happens
    await a("/api/peers", "POST", { url: `http://localhost:${B}` });
    const cfg = { network: "local", rpcUrl: RPC, chainId: 31337, escrow };
    await a("/api/chain", "PUT", cfg);
    assert.equal((await chat()).status, 404, "mismatched settlement modes must not route");
    await b("/api/chain", "PUT", cfg);
    await a("/api/peers/refresh", "POST", {});
  });

  test("mint → deposit → request → voucher → provider redeems exactly the owed USDG", async () => {
    const ia = await a("/api/chain"), ib = await b("/api/chain");
    assert.equal(ia.mode, "chain");
    for (const addr of [ia.address, ib.address]) await (await deployer.sendTransaction({ to: addr, value: parseEther("1") })).wait(); // ETH for gas
    await a("/api/chain/mint", "POST", { usd: 50 });
    const dep = await a("/api/chain/deposit", "POST", { usd: 20 });
    assert.equal(dep.txs.length, 2, "approve + deposit");
    const after0 = await a("/api/chain");
    assert.equal(after0.tokenSymbol, "USDG");
    assert.equal(after0.tokenDecimals, 6);
    assert.equal(after0.depositUsd, 20);
    await until(async () => (await a("/api/chain")).balanceUsd > 0);

    const r = await chat();
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    const expectedUnits = 240_360n; // (12 + 8000) tokens × $30/MTok = $0.24036 = 240,360 USDG units

    const out = (await a("/api/chain")).vouchersOut[0];
    assert.equal(BigInt(out.cumulativeUnits), expectedUnits, "consumer voucher covers exactly the receipt");
    const inn = await until(async () => { const v = (await b("/api/chain")).vouchersIn[0]; return v && BigInt(v.cumulativeUnits) === expectedUnits ? v : null; });
    assert.equal(BigInt(inn.owedUnits), expectedUnits);

    const before = (await b("/api/chain")).tokenUnits;
    const { batches } = await b("/api/ledger/settle", "POST");
    assert.equal(batches.length, 1);
    assert.match(batches[0].tx, /^0x[0-9a-f]{64}$/);
    assert.equal(BigInt(batches[0].paidUnits), expectedUnits);
    const after = (await b("/api/chain")).tokenUnits;
    assert.equal(BigInt(after) - BigInt(before), expectedUnits, "provider received exactly the voucher amount in USDG (gas is paid in ETH, separately)");
    await until(async () => (await a("/api/chain")).depositUsd === 19.75964, 25000); // consumer escrow dropped by exactly $6 (reads are cached up to 8 s)
    const earn = (await b("/api/ledger")).entries.find((e) => e.type === "earn");
    assert.equal(earn.settled, true);
    assert.equal((await b("/api/ledger/settle", "POST")).batches.length, 0, "second settle has nothing to redeem");
  });

  test("vouchers must come sealed with proof of wallet control: claiming someone else's wallet or forging a signature does not raise what the provider can claim", async () => {
    const before = (await b("/api/chain")).vouchersIn[0];
    const ia = await a("/api/chain");
    const hello = await (await fetch(`http://localhost:${B}/p2p/hello`)).json();
    const attacker = Wallet.createRandom();
    const push = async (consumer, cumulative, sig, sealed = true) => {
      const body = sealed ? { from: "x", sealed: sealTo(hello.box.pub, { consumer, cumulative, sig }).envelope } : { consumer, cumulative, sig };
      const r = await fetch(`http://localhost:${B}/p2p/voucher`, { method: "POST", headers: J, body: JSON.stringify(body) });
      return { status: r.status, ...(await r.json()) };
    };
    const id = (await a("/api/status")).node.id;
    const forgedSig = await attacker.signMessage("nope");
    // victim's wallet claimed by an attacker: the binding proof is signed by the wrong key
    assert.equal((await push({ id, wallet: ia.address, walletProof: await attacker.signMessage(`elyra-wallet-binding:${id}:${ia.address.toLowerCase()}`) }, String(10n ** 18n), forgedSig)).status, 402);
    // plaintext (unsealed) pushes are refused outright
    assert.equal((await push({ id, wallet: ia.address }, "1", forgedSig, false)).status, 400);
    // attacker with its own valid proof but no funded session at this provider
    assert.equal((await push({ id: "deadbeefdeadbeef", wallet: attacker.address, walletProof: await attacker.signMessage(`elyra-wallet-binding:deadbeefdeadbeef:${attacker.address.toLowerCase()}`) }, "1", forgedSig)).status, 404);
    assert.equal((await b("/api/chain")).vouchersIn[0].cumulativeUnits, before.cumulativeUnits);
  });

  test("switching to another escrow resets every channel: a stale cumulative must never be paid out of the new contract", async () => {
    const c2 = await new ContractFactory(art("ElyraEscrow").abi, art("ElyraEscrow").bytecode, deployer).deploy(tokenAddr);
    await c2.waitForDeployment();
    const escrow2 = await c2.getAddress();
    for (const n of [a, b]) await n("/api/chain", "PUT", { escrow: escrow2 });
    await a("/api/peers/refresh", "POST", {});
    await a("/api/chain/deposit", "POST", { usd: 5 });
    await until(async () => (await a("/api/chain")).balanceUsd > 0);
    assert.equal((await a("/api/chain")).vouchersOut.length, 0, "old-escrow vouchers are not shown or used");
    assert.equal((await chat()).status, 200);
    const out0 = await until(async () => (await a("/api/chain")).vouchersOut[0] ?? null); // the voucher is stored just after the reply (found flaky on CI)
    assert.equal(BigInt(out0.cumulativeUnits), 240_360n, "only this request, no carry-over from the previous escrow");
    const inn = await until(async () => { const v = (await b("/api/chain")).vouchersIn[0]; return v && BigInt(v.cumulativeUnits) === 240_360n ? v : null; });
    assert.equal(BigInt(inn.owedUnits), 240_360n);
  });

  test("earnings are swept to the seller's payout address after redeem (so an ephemeral TEE wallet never keeps money)", async () => {
    const { Contract } = await import("ethers");
    const payout = Wallet.createRandom().address;
    const tk = new Contract(tokenAddr, ["function balanceOf(address) view returns (uint256)"], provider);
    await b("/api/provide", "PUT", { payout });
    const ib = await b("/api/chain");
    const walletBefore = BigInt(ib.tokenUnits);
    assert.equal((await chat()).status, 200);
    await until(async () => { const v = (await b("/api/chain")).vouchersIn[0]; return v && BigInt(v.cumulativeUnits) === 480_720n ? v : null; });
    const { batches } = await b("/api/ledger/settle", "POST");
    assert.equal(batches.length, 1);
    assert.ok(batches[0].swept?.tx, JSON.stringify(batches[0]));
    assert.equal(await tk.balanceOf(payout), BigInt(batches[0].paidUnits), "exactly what this redeem paid moved to the payout address");
    assert.equal(BigInt(batches[0].paidUnits), 480_720n, "the previous test left one unredeemed request on this escrow, plus this one");
    assert.equal(BigInt((await b("/api/chain")).tokenUnits), walletBefore, "the node wallet keeps nothing");
  });
});
