// On-chain provider registry end to end on a local EVM (hardhat node): a buyer with NO seed finds sellers only through
// ElyraRegistry logs and re-verifies every announcement against the seller's signed hello. Skips without contracts/node_modules.
// Run: node --test router/test/registry.test.mjs   (after: cd contracts && npm install)
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { Contract, ContractFactory, JsonRpcProvider, NonceManager, Wallet, ethers, parseEther } from "ethers";
import { boxKeyOf, metaHashOf, nodeIdOf } from "../core/registry.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hardhatCli = join(root, "contracts", "node_modules", "hardhat", "internal", "cli", "cli.js");
const have = existsSync(hardhatCli) && existsSync(join(root, "contracts", "artifacts", "ElyraRegistry.json"));
const J = { "content-type": "application/json" };
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // public hardhat account #0
const DEV_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // public hardhat account #1

test("metaHash commitment is the documented canonical-JSON sha-256 (docs/PROTOCOL.md)", () => {
  const want = "0x" + crypto.createHash("sha256").update('{"box":"BOX","pub":"PUB","t":"elyra-registry-meta-v1","url":"http://x.example","wallet":"0xabcdef"}').digest("hex");
  assert.equal(metaHashOf({ pub: "PUB", box: "BOX", wallet: "0xABCDEF", url: "http://x.example" }), want);
  assert.equal(nodeIdOf("AAAA").length, 66);
  assert.notEqual(boxKeyOf("AAAA"), nodeIdOf("BBBB"));
});

describe("on-chain registry discovery (local EVM)", { skip: !have && "contracts/node_modules missing" }, () => {
  const procs = [], dirs = [];
  const RPC_PORT = 19101, RPC = `http://127.0.0.1:${RPC_PORT}`;
  const spawnProc = (args, cwd, env) => { const p = spawn(process.execPath, args, { cwd, stdio: "pipe", env: { ...process.env, ...env } }); procs.push(p); return p; };
  const until = async (fn, ms = 25000, what = "condition") => { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t > ms) throw new Error("timeout: " + what); await new Promise((r) => setTimeout(r, 200)); } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let provider, deployer, escrow, registry, registryBlock, regAbi, hh;

  const api = (port) => async (p, method = "GET", body) => { const r = await fetch(`http://localhost:${port}${p}`, { method, headers: J, body: body && JSON.stringify(body) }); return r.json(); };
  /** start a VPR node, point it at the local chain + registry; returns handles */
  async function startNode(name, port, { privatePeers, dir, seller } = {}) {
    dir ??= mkdtempSync(join(tmpdir(), "vpr-reg-")); if (!dirs.includes(dir)) dirs.push(dir);
    const args = [join(root, "router", "server.mjs"), "--port", String(port), "--data", dir, "--name", name, "--no-demo", "--public-url", `http://localhost:${port}`, ...(privatePeers ? ["--allow-private-peers"] : [])];
    const proc = spawnProc(args, root, { ELYRA_REGISTRY_POLL_MS: "1000", ELYRA_REGISTRY_DISCOVER: seller ? "0" : "1" }); // sellers do not read the registry: they would meet the buyers and gossip each other around
    await until(async () => (await fetch(`http://localhost:${port}/p2p/hello`)).ok, 20000, "node up");
    const a = api(port);
    await a("/api/chain", "PUT", { network: "local", rpcUrl: RPC, chainId: 31337, escrow, registry, registryBlock });
    const hello = await (await fetch(`http://localhost:${port}/p2p/hello`)).json();
    return { name, port, dir, proc, a, hello, url: `http://localhost:${port}`, wallet: () => new Wallet(JSON.parse(readFileSync(join(dir, "wallet.json"), "utf8")).privateKey, provider) };
  }
  const peerIds = async (n) => (await n.a("/api/peers")).peers.map((p) => p.id);
  const fund = async (addr) => { await (await deployer.sendTransaction({ to: addr, value: parseEther("1") })).wait(); };
  /** announce on behalf of a node's wallet with arbitrary fields (the test owns the data dir, so it has the key) */
  const announceAs = async (signer, n, over = {}, ttl = 0) => {
    const f = { nodeId: nodeIdOf(n.hello.pub), boxKey: boxKeyOf(n.hello.box.pub), url: n.url, metaHash: metaHashOf({ pub: n.hello.pub, box: n.hello.box.pub, wallet: signer.address, url: n.url }), ...over };
    const c = new Contract(registry, regAbi, new NonceManager(signer));
    await (await c.announce(f.nodeId, f.boxKey, f.url, f.metaHash, ttl)).wait();
    return f;
  };
  const pendingFor = async (buyer, walletAddr) => (await buyer.a("/api/registry")).pending.find((e) => e.wallet === walletAddr.toLowerCase());
  const stop = (n) => new Promise((r) => { n.proc.once("exit", r); n.proc.kill(); });

  before(async () => {
    hh = spawnProc([hardhatCli, "node", "--port", String(RPC_PORT)], join(root, "contracts"));
    provider = new JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
    await until(() => provider.getNetwork(), 30000, "hardhat");
    deployer = new NonceManager(new Wallet(DEV_KEY, provider));
    const art = (n) => JSON.parse(readFileSync(join(root, "contracts", "artifacts", n + ".json"), "utf8"));
    const tok = await new ContractFactory(art("MockUSDG").abi, art("MockUSDG").bytecode, deployer).deploy(); await tok.waitForDeployment();
    const esc = await new ContractFactory(art("ElyraEscrow").abi, art("ElyraEscrow").bytecode, deployer).deploy(await tok.getAddress()); await esc.waitForDeployment();
    regAbi = art("ElyraRegistry").abi;
    const reg = await new ContractFactory(regAbi, art("ElyraRegistry").bytecode, deployer).deploy(ethers.ZeroAddress, 0); await reg.waitForDeployment();
    escrow = await esc.getAddress(); registry = await reg.getAddress();
    registryBlock = (await reg.deploymentTransaction().wait()).blockNumber;
  });
  after(() => { procs.forEach((p) => p.kill()); provider?.destroy(); setTimeout(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })), 800); });

  let S, B1, B2, S2;

  test("a buyer with no seed discovers a seller only through the registry; the seller announces itself (no gas = a warning, never a failed boot)", async () => {
    S = await startNode("seller", 19111, { privatePeers: true, seller: true });
    await S.a("/api/provide", "PUT", { enabled: true });
    await S.a("/api/settings", "PUT", { registryAnnounce: true });
    B1 = await startNode("buyer-1", 19112, { privatePeers: true }); // test-only flag: the seller lives on localhost; NO seed, NO peer added
    assert.deepEqual(await peerIds(B1), []);

    const gasMsg = await until(async () => (await S.a("/api/registry")).announceError, 15000, "seller gas warning");
    assert.match(gasMsg, /gas/i);
    assert.equal((await fetch(`http://localhost:${S.port}/p2p/hello`)).ok, true); // still serving
    await sleep(2500);
    assert.deepEqual(await peerIds(B1), [], "nothing is listed before the seller can pay gas");

    await fund((await S.a("/api/status")).node.address);
    await until(async () => (await S.a("/api/registry")).listed, 20000, "seller listed");
    const found = await until(async () => (await B1.a("/api/peers")).peers.find((p) => p.id === S.hello.id), 25000, "buyer found seller via registry");
    assert.equal(found.viaRegistry, true);
    assert.equal(found.url, S.url);
    assert.deepEqual((await B1.a("/api/peers")).peers.length, 1);
  });

  test("registry URLs pass the same public-host guard as gossip: a localhost seller is refused without --allow-private-peers", async () => {
    B2 = await startNode("buyer-2", 19113, {});
    const e = await until(async () => (await B2.a("/api/registry")).pending.find((x) => x.url === S.url && x.error), 20000, "B2 rejection");
    assert.match(e.error, /private/i);
    assert.deepEqual(await peerIds(B2), []);
    // a private-range literal announced by a third wallet is refused the same way
    const w1 = new Wallet(DEV_KEY_1, provider);
    await new Contract(registry, regAbi, new NonceManager(w1)).announce(H("n"), H("b"), "http://10.0.0.5:9", H("m"), 0).then((t) => t.wait());
    const p = await until(async () => pendingFor(B2, w1.address).then((x) => x?.error && x), 20000, "private literal rejected");
    assert.match(p.error, /private/i);
    assert.deepEqual(await peerIds(B2), []);
  });
  const H = (s) => ethers.id(s);

  test("every announced field is checked against the signed hello: wrong metaHash, node id, box key and an announcing wallet that is not the node's wallet are rejected; the exact announcement is accepted", async () => {
    S2 = await startNode("seller-2", 19114, { privatePeers: true, seller: true });
    const w = S2.wallet();
    await fund(w.address);

    await announceAs(w, S2, { metaHash: H("wrong-meta") });
    assert.match((await until(async () => pendingFor(B1, w.address).then((x) => x?.error && x), 20000, "metaHash")).error, /metaHash/);
    await announceAs(w, S2, { nodeId: H("some-other-node") });
    assert.match((await until(async () => pendingFor(B1, w.address).then((x) => x?.error && /node id/.test(x.error) && x), 20000, "node id")).error, /node id/);
    await announceAs(w, S2, { boxKey: H("some-other-box") });
    assert.match((await until(async () => pendingFor(B1, w.address).then((x) => x?.error && /box key/.test(x.error) && x), 20000, "box key")).error, /box key/);
    assert.ok(!(await peerIds(B1)).includes(S2.hello.id), "no mismatching announcement ever created a peer");

    // somebody else's wallet announcing the real node's exact fields (copying its metaHash) cannot list it
    const w1 = new Wallet(DEV_KEY_1, provider);
    await announceAs(w1, S2, { metaHash: metaHashOf({ pub: S2.hello.pub, box: S2.hello.box.pub, wallet: w.address, url: S2.url }) });
    assert.match((await until(async () => pendingFor(B1, w1.address).then((x) => x?.error && /wallet/.test(x.error) && x), 20000, "wallet")).error, /wallet/);
    assert.ok(!(await peerIds(B1)).includes(S2.hello.id));

    await announceAs(w, S2); // the honest announcement replaces the bad ones (latest per wallet wins)
    const p = await until(async () => (await B1.a("/api/peers")).peers.find((x) => x.id === S2.hello.id), 25000, "honest announcement accepted");
    assert.equal(p.viaRegistry, true);
  });

  test("expired and revoked entries are ignored by a buyer that reads them from history; live ones are still found", async () => {
    await B1.a("/api/settings", "PUT", { registryDiscover: false }); // B1 must not learn S3 live: gossip would carry it to B3 and hide what this test checks
    await sleep(1500);
    const S3 = await startNode("seller-3", 19115, { privatePeers: true, seller: true }), S4 = await startNode("seller-4", 19116, { privatePeers: true, seller: true });
    const w3 = S3.wallet(), w4 = S4.wallet();
    await fund(w3.address); await fund(w4.address);
    await announceAs(w3, S3, {}, 3600); // lives one hour on chain time
    await announceAs(w4, S4);
    await new Contract(registry, regAbi, new NonceManager(w4)).revoke().then((t) => t.wait());
    await provider.send("evm_increaseTime", [2 * 3600]); await provider.send("evm_mine", []); // S3's hour is over; S (7 d) and S2 (7 d) are not

    const B3 = await startNode("buyer-3", 19117, { privatePeers: true });
    await until(async () => { const ids = await peerIds(B3); return ids.includes(S.hello.id) && ids.includes(S2.hello.id); }, 30000, "control sellers found");
    await sleep(3000);
    const ids = await peerIds(B3);
    assert.ok(!ids.includes(S3.hello.id), "expired entry ignored");
    assert.ok(!ids.includes(S4.hello.id), "revoked entry ignored");
    const pend = (await B3.a("/api/registry")).pending.map((e) => e.wallet);
    assert.ok(!pend.includes(w3.address.toLowerCase()) && !pend.includes(w4.address.toLowerCase()));
    await stop(S3); await stop(S4); await stop(B3);
  });

  test("the block cursor persists across a restart: no re-read from the deploy block, discovery continues", async () => {
    await B1.a("/api/settings", "PUT", { registryDiscover: true });
    for (let i = 0; i < 40; i++) await provider.send("evm_mine", []);
    const before = await until(async () => { const s = await B1.a("/api/registry"); const head = await provider.getBlockNumber(); return s.cursor > head && s; }, 20000, "B1 caught up");
    assert.ok(before.cursor > registryBlock + 40);
    await sleep(2500); // state.json is flushed every 1.5 s (a killed process gets no shutdown flush)
    await stop(B1);
    const B1b = await startNode("buyer-1", 19112, { privatePeers: true, dir: B1.dir });
    const s = await until(async () => { const x = await B1b.a("/api/registry"); return x.lastScan && x; }, 20000, "scan after restart");
    assert.ok(s.lastScan.from >= before.cursor - 12 && s.lastScan.from > registryBlock + 40, `resumed at ${s.lastScan.from}, cursor was ${before.cursor}`);
    assert.ok((await peerIds(B1b)).includes(S.hello.id), "known peers survive the restart");

    const S5 = await startNode("seller-5", 19118, { privatePeers: true, seller: true });
    await fund(S5.wallet().address);
    await announceAs(S5.wallet(), S5);
    await until(async () => (await peerIds(B1b)).includes(S5.hello.id), 25000, "new seller found after restart");
    assert.ok((await B1b.a("/api/registry")).lastScan.from > registryBlock + 40);
  });

  test("with discovery switched off the registry is not read and creates no peers", async () => {
    const B4 = await startNode("buyer-4", 19119, { privatePeers: true });
    await B4.a("/api/settings", "PUT", { registryDiscover: false });
    await sleep(3500);
    const s = await B4.a("/api/registry");
    assert.equal(s.discover, false);
    assert.equal(s.lastScan, null);
    assert.deepEqual(await peerIds(B4), []);
  });

  test("an unreachable chain fails closed: no peers, an error is reported", async () => {
    const B5 = await startNode("buyer-5", 19120, { privatePeers: true });
    await B5.a("/api/chain", "PUT", { rpcUrl: "http://127.0.0.1:1" });
    await sleep(3500);
    const s = await B5.a("/api/registry");
    assert.ok(s.lastError, "read error surfaced");
    assert.deepEqual(await peerIds(B5), []);
  });
});
