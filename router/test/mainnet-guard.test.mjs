// Mainnet beta safety: the deposit cap setting can only tighten or loosen explicitly, never silently disappear.
// Run: node --test router/test/mainnet-guard.test.mjs
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { depositCapUsd } from "../chain.mjs";

describe("mainnet beta deposit cap", () => {
  test("defaults to $20 (the one cap concept: same as DEFAULT_MAX_DEPOSIT_USD) and honours an explicit value, including 0", () => {
    assert.equal(depositCapUsd(undefined), 20);
    assert.equal(depositCapUsd("100"), 100);
    assert.equal(depositCapUsd("0"), 0);
  });
  test("garbage, negative or non-finite values fall back to the default instead of removing the cap", () => {
    for (const bad of ["", "abc", "-5", "Infinity", "NaN"]) assert.equal(depositCapUsd(bad), 20, bad);
  });
});

describe("the node's own deposit path enforces the one per-wallet cap (local EVM)", () => {
  test("chain.deposit refuses what would push the escrow over the owner's cap, cumulatively, before any approve/deposit transaction", async (t) => {
    const { spawn } = await import("node:child_process");
    const { existsSync, mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { ContractFactory, JsonRpcProvider, NonceManager, Wallet, parseEther } = await import("ethers");
    const { createChain } = await import("../chain.mjs");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const hardhatCli = join(root, "contracts", "node_modules", "hardhat", "internal", "cli", "cli.js");
    if (!existsSync(hardhatCli)) return t.skip("contracts/node_modules missing");
    const PORT = 18986, RPC = `http://127.0.0.1:${PORT}`;
    const proc = spawn(process.execPath, [hardhatCli, "node", "--port", String(PORT)], { cwd: join(root, "contracts"), stdio: "pipe" });
    const dir = mkdtempSync(join(tmpdir(), "vpr-nodecap-"));
    try {
      const provider = new JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
      for (let i = 0; i < 100; i++) { try { await provider.getNetwork(); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
      const deployer = new NonceManager(new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", provider));
      const art = (n) => JSON.parse(readFileSync(join(root, "contracts", "artifacts", n + ".json"), "utf8"));
      const tok = await new ContractFactory(art("MockUSDG").abi, art("MockUSDG").bytecode, deployer).deploy(); await tok.waitForDeployment();
      const esc = await new ContractFactory(art("ElyraEscrow").abi, art("ElyraEscrow").bytecode, deployer).deploy(await tok.getAddress()); await esc.waitForDeployment();
      let cap = 20;
      const chain = await createChain({ dataDir: dir, getConfig: () => ({ network: "local", rpcUrl: RPC, chainId: 31337, escrow: esc.target }), getDepositCapUsd: () => cap });
      await (await deployer.sendTransaction({ to: chain.address, value: parseEther("1") })).wait();
      await chain.mint(100);
      await assert.rejects(() => chain.deposit(20.01), /deposit cap/);
      assert.equal(await esc.deposits(chain.address), 0n, "nothing moved");
      await chain.deposit(15);
      await assert.rejects(() => chain.deposit(5.01), /deposit cap/, "cumulative");
      await chain.deposit(5);
      assert.equal(await esc.deposits(chain.address), 20_000_000n);
      cap = 30; await chain.deposit(10); // the owner raised the cap: allowed (test network: no mainnet ceiling)
      assert.equal(await esc.deposits(chain.address), 30_000_000n);
    } finally { proc.kill(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  });
});
