// Per-wallet deposit cap (B5, mainnet readiness): default $20 USDG, configurable via /api/provide, /api/chain or
// ELYRA_MAX_DEPOSIT_USD, enforced by the seller's credit gate, node deposit API, session-pay gateway and wallet fund flow.
// Run: node --test router/test/deposit-cap.test.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Wallet } from "ethers";
import { DEFAULT_MAX_DEPOSIT_USD } from "../core/limits.mjs";
import { createNode } from "../core/node.mjs";
import { createCreditGate } from "../core/provider/credit.mjs";
import { createSessionPay } from "../core/consumer/session-pay.mjs";
import { createApi } from "../http/api.mjs";
import { createPublicTry } from "../http/public.mjs";
import { canon, sha } from "../lib/canon.mjs";
import { sealTo } from "../seal.mjs";
import { deposit as walletDeposit } from "../../tools/wallet/src/fund.mjs";

describe("B5: per-wallet deposit cap default and configuration", () => {
  test("DEFAULT_MAX_DEPOSIT_USD is 20 and fresh node exposes it on /api/provide, /api/chain, /pub/chain and /p2p/hello", async () => {
    assert.equal(DEFAULT_MAX_DEPOSIT_USD, 20);
    const dir = mkdtempSync(join(tmpdir(), "vpr-cap-"));
    const node = await createNode({ dataDir: dir, port: 18981, host: "127.0.0.1", demoNetwork: false });
    const api = createApi(node);
    const call = async (method, path, body) => {
      let code, out;
      const req = { method, headers: { "content-type": "application/json" }, [Symbol.asyncIterator]: async function* () { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
      const res = { writeHead(c) { code = c; }, end(b) { out = JSON.parse(b); } };
      await api(req, res, path, new URLSearchParams());
      return { code, out };
    };
    try {
      const pr0 = (await call("GET", "/api/provide")).out;
      assert.equal(pr0.maxDepositUsd, 20);
      const ch0 = (await call("GET", "/api/chain")).out;
      assert.equal(ch0.maxDepositUsd, 20);

      for (const bad of [0, -1, -20, null, true, false, "", "abc", 10001, Infinity]) {
        await assert.rejects(() => call("PUT", "/api/provide", { maxDepositUsd: bad }), /bad deposit cap/, `provide rejects ${JSON.stringify(bad)}`);
        await assert.rejects(() => call("PUT", "/api/chain", { maxDepositUsd: bad }), /bad deposit cap/, `chain rejects ${JSON.stringify(bad)}`);
      }

      const pr1 = (await call("PUT", "/api/provide", { maxDepositUsd: 35 })).out;
      assert.equal(pr1.maxDepositUsd, 35);
      assert.equal((await call("GET", "/api/chain")).out.maxDepositUsd, 35);

      const ch1 = (await call("PUT", "/api/chain", { escrow: "0x" + "11".repeat(20), maxDepositUsd: 12.5 })).out;
      assert.equal(ch1.maxDepositUsd, 12.5);
      assert.equal((await call("GET", "/api/provide")).out.maxDepositUsd, 12.5);
      assert.equal(node.helloInfo().chain?.maxDepositUsd, 12.5);

      const pub = createPublicTry(
        { ...node, chain: { ...node.chain, configured: () => true, info: async () => ({ chainId: 46630, networkName: "Testnet", rpcUrl: "https://rpc.example", explorer: "https://ex.example", real: false, escrow: "0x" + "11".repeat(20), token: "0x" + "22".repeat(20), tokenSymbol: "USDG", tokenDecimals: 6, isMock: true }) } },
        { staticFile: async () => {}, env: { ELYRA_PUBLIC_TRY: "1" } },
      );
      let pubChain;
      await pub.handle({ method: "GET", headers: {}, socket: {} }, { setHeader() {}, writeHead() {}, end(b) { pubChain = JSON.parse(b); } }, "/pub/chain");
      assert.equal(pubChain.maxDepositUsd, 12.5);
    } finally {
      node.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("B5: seller credit gate enforces per-wallet deposit cap", () => {
  const w = Wallet.createRandom();
  const cid = "0123456789abcdef";
  const mkGate = (depositUnits, maxDepositUsd = 20, creditUsd = 1) => {
    const state = { provide: { creditUsd, maxDepositUsd, autoRedeem: false }, vouchersIn: {} };
    const chain = {
      address: "0x" + "99".repeat(20),
      isAddress: (a) => /^0x[0-9a-fA-F]{40}$/.test(a),
      verifyBinding: () => true,
      usdToUnits: (u) => BigInt(Math.round(u * 1e6)),
      unitsToUsd: (u) => Number(BigInt(u)) / 1e6,
      consumerPosition: async () => ({ deposit: BigInt(depositUnits), claimed: 0n }),
    };
    const gate = createCreditGate({ state, chain, escrowId: () => "local:0x1" }, { acceptVoucher: () => false, redeemEntry: async () => {} });
    return { gate, state };
  };

  test("admits a wallet at or below the cap (20 USDG = 20,000,000 units) and rejects 1 unit above it before creating state", async () => {
    const { gate: okGate, state: okState } = mkGate(20_000_000n, 20);
    const res = await okGate({ consumer: { id: cid, wallet: w.address, walletProof: "0x1" }, voucher: null, m: { price: 1 }, maxOut: 100, promptEst: 100 });
    assert.ok(res.inv);
    assert.equal(Object.keys(okState.vouchersIn).length, 1);

    const { gate: overGate, state: overState } = mkGate(20_000_001n, 20);
    await assert.rejects(
      () => overGate({ consumer: { id: cid, wallet: w.address, walletProof: "0x1" }, voucher: null, m: { price: 1 }, maxOut: 100, promptEst: 100 }),
      (e) => e.status === 402 && e.type === "deposit_cap_exceeded" && /\$20 per-wallet cap/.test(e.message),
    );
    assert.equal(Object.keys(overState.vouchersIn).length, 0, "over-cap wallet must not allocate vouchersIn state");
  });

  test("respects custom maxDepositUsd (lower and higher caps)", async () => {
    const { gate: lowGate } = mkGate(10_000_001n, 10);
    await assert.rejects(
      () => lowGate({ consumer: { id: cid, wallet: w.address, walletProof: "0x1" }, voucher: null, m: { price: 1 }, maxOut: 100, promptEst: 100 }),
      (e) => e.status === 402 && /\$10 per-wallet cap/.test(e.message),
    );
    const { gate: highGate } = mkGate(35_000_000n, 50);
    const ok = await highGate({ consumer: { id: cid, wallet: w.address, walletProof: "0x1" }, voucher: null, m: { price: 1 }, maxOut: 100, promptEst: 100 });
    assert.ok(ok.inv);
  });

  test("end-to-end /p2p/infer refuses over-capped wallet before calling upstream", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vpr-cap-e2e-"));
    const node = await createNode({ dataDir: dir, port: 18982, host: "127.0.0.1", demoNetwork: false });
    let upstreamCalled = 0;
    try {
      node.state.upstreams.push({ id: "u1", name: "local", kind: "openai", baseUrl: "http://127.0.0.1:11434/v1", models: ["m1"] });
      node.state.provide = { ...node.state.provide, enabled: true, upstreamId: "u1", price: 0.1, creditUsd: 1, maxDepositUsd: 20 };
      node.state.chain.escrow = "0x" + "11".repeat(20);
      let depUnits = 25_000_000n;
      node.chain.consumerPosition = async () => ({ deposit: depUnits, claimed: 0n });
      const origExec = node.execLocal;
      node.execLocal = async (...a) => { upstreamCalled++; return origExec(...a); };

      const cKey = crypto.generateKeyPairSync("ed25519");
      const cpub = cKey.publicKey.export({ type: "spki", format: "der" }).toString("base64");
      const consumerId = sha(Buffer.from(cpub, "base64")).slice(0, 16);
      const cw = Wallet.createRandom();
      const proof = await cw.signMessage(`elyra-wallet-binding:${consumerId}:${cw.address.toLowerCase()}`);
      const hello = node.helloInfo();
      const mkWire = () => {
        const body = { messages: [{ role: "user", content: "hi" }] }, ts = Date.now(), nonce = crypto.randomBytes(8).toString("hex");
        const payload = {
          consumer: { id: consumerId, pub: cpub, wallet: cw.address, walletProof: proof },
          model: "m1", maxPrice: 1, body,
          auth: { ts, nonce, sig: crypto.sign(null, Buffer.from(canon({ provider: hello.id, ts, nonce, model: "m1", bodyHash: sha(canon(body)) })), cKey.privateKey).toString("base64") },
        };
        return { from: consumerId, sealed: sealTo(hello.box.pub, payload).envelope };
      };

      await assert.rejects(
        () => node.serve(mkWire(), { head() {}, json() {} }, new AbortController()),
        (e) => e.status === 402 && e.type === "deposit_cap_exceeded",
      );
      assert.equal(upstreamCalled, 0, "upstream must not be called when deposit exceeds cap");
    } finally {
      node.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("B5: node deposit API, session-pay gateway and wallet fund helper enforce cap", () => {
  test("POST /api/chain/deposit enforces both single-tx and cumulative per-wallet cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vpr-cap-dep-"));
    const node = await createNode({ dataDir: dir, port: 18983, host: "127.0.0.1", demoNetwork: false });
    node.state.chain.escrow = "0x" + "11".repeat(20);
    let currentDep = 15_000_000n;
    let depositedUsd = [];
    node.chain.consumerPosition = async () => ({ deposit: currentDep, claimed: 0n });
    node.chain.deposit = async (usd) => { depositedUsd.push(usd); currentDep += BigInt(Math.round(usd * 1e6)); return { hash: "0x" + "aa".repeat(32), txs: [], gasUsed: "1" }; };
    const api = createApi(node);
    const call = async (method, path, body) => {
      let code, out;
      const req = { method, headers: { "content-type": "application/json" }, [Symbol.asyncIterator]: async function* () { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
      const res = { writeHead(c) { code = c; }, end(b) { out = JSON.parse(b); } };
      await api(req, res, path, new URLSearchParams());
      return { code, out };
    };
    try {
      await assert.rejects(() => call("POST", "/api/chain/deposit", { usd: 25 }), /\$20 per-wallet cap/);
      await assert.rejects(() => call("POST", "/api/chain/deposit", { usd: 6 }), /\$20 per-wallet cap/);
      assert.equal(depositedUsd.length, 0);
      const ok = await call("POST", "/api/chain/deposit", { usd: 5 });
      assert.equal(ok.code, 200);
      assert.deepEqual(depositedUsd, [5]);
      await assert.rejects(() => call("POST", "/api/chain/deposit", { usd: 0.01 }), /\$20 per-wallet cap/);
    } finally {
      node.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session-pay position returns maxDepositUsd and paid-chat refuses an over-capped session wallet", async () => {
    const sw = Wallet.createRandom();
    const nodeId = "fedcba9876543210";
    const proof = await sw.signMessage(`elyra-wallet-binding:${nodeId}:${sw.address.toLowerCase()}`);
    let dep = 20_000_001n, peerCalls = 0;
    const sp = createSessionPay(
      {
        state: { provide: { maxDepositUsd: 20 }, peers: { p1: { id: "p1", name: "seller", wallet: "0x" + "33".repeat(20), chain: { maxDepositUsd: 20 } } } },
        identity: { id: nodeId },
        chain: {
          configured: () => true,
          isAddress: (a) => /^0x[0-9a-fA-F]{40}$/.test(a),
          verifyBinding: () => true,
          verifyVoucher: () => true,
          usdToUnits: (u) => BigInt(Math.round(u * 1e6)),
          unitsToUsd: (u) => Number(BigInt(u)) / 1e6,
          consumerPosition: async () => ({ deposit: dep, claimed: 0n }),
        },
      },
      {
        plan: () => [{ kind: "peer", sourceId: "p1", peerName: "seller", model: "m1", price: 1, simulated: false, key: "peer:p1:m1" }],
        execPeer: async () => { peerCalls++; throw new Error("should not be called"); },
        record() {},
      },
    );
    const pos = await sp.position(sw.address);
    assert.equal(pos.maxDepositUsd, 20);
    await assert.rejects(
      () => sp.chat({ session: { wallet: sw.address, proof }, model: "m1", maxPrice: 2, messages: [{ role: "user", content: "hi" }] }, { head() {}, write() {}, end() {} }, new AbortController()),
      (e) => e.status === 402 && e.type === "deposit_cap_exceeded" && /\$20 per-wallet cap/.test(e.message),
    );
    assert.equal(peerCalls, 0);
  });

  test("tools/wallet/src/fund.mjs deposit enforces per-wallet cap before approve or depositFor", async () => {
    const { spawn } = await import("node:child_process");
    const { existsSync, readFileSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { ContractFactory, JsonRpcProvider, NonceManager, parseEther } = await import("ethers");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const hardhatCli = join(root, "contracts", "node_modules", "hardhat", "internal", "cli", "cli.js");
    if (!existsSync(hardhatCli)) return;
    const PORT = 18984, RPC = `http://127.0.0.1:${PORT}`;
    const proc = spawn(process.execPath, [hardhatCli, "node", "--port", String(PORT)], { cwd: join(root, "contracts"), stdio: "pipe" });
    try {
      const provider = new JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
      for (let i = 0; i < 100; i++) { try { await provider.getNetwork(); break; } catch { await new Promise((r) => setTimeout(r, 150)); } }
      const deployer = new NonceManager(new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", provider));
      const art = (n) => JSON.parse(readFileSync(join(root, "contracts", "artifacts", n + ".json"), "utf8"));
      const tok = await new ContractFactory(art("MockUSDG").abi, art("MockUSDG").bytecode, deployer).deploy(); await tok.waitForDeployment();
      const esc = await new ContractFactory(art("ElyraEscrow").abi, art("ElyraEscrow").bytecode, deployer).deploy(await tok.getAddress()); await esc.waitForDeployment();
      const user = new NonceManager(Wallet.createRandom().connect(provider));
      const nodeAddr = Wallet.createRandom().address;
      await (await deployer.sendTransaction({ to: await user.getAddress(), value: parseEther("1") })).wait();
      await (await tok.mint(await user.getAddress(), 100_000_000n)).wait();
      const cfg = { token: await tok.getAddress(), escrow: await esc.getAddress(), node: nodeAddr, decimals: 6, maxDepositUsd: 20 };

      const steps = [];
      await assert.rejects(() => walletDeposit(user, cfg, "20.01", (s) => steps.push(s)), /\$20 per-wallet cap/);
      assert.deepEqual(steps, [], "must not approve or deposit when over cap");

      await walletDeposit(user, cfg, "15");
      await assert.rejects(() => walletDeposit(user, cfg, "5.01", (s) => steps.push(s)), /\$20 per-wallet cap/);
      assert.deepEqual(steps, [], "cumulative deposit over cap is rejected before approve");

      await walletDeposit(user, cfg, "5");
      assert.equal(await esc.deposits(nodeAddr), 20_000_000n);
    } finally {
      proc.kill();
    }
  });
});
