// Pay-per-use from a browser session wallet, end to end on a local EVM (hardhat): the visitor's session key signs, the gateway node only relays,
// the seller is paid by the escrow. Skips when contracts/node_modules is absent. Run: node --test router/test/session-pay.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { Contract, ContractFactory, JsonRpcProvider, NonceManager, Wallet, parseEther } from "ethers";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const hardhatCli = join(root, "contracts", "node_modules", "hardhat", "internal", "cli", "cli.js");
const have = existsSync(hardhatCli) && existsSync(join(root, "contracts", "artifacts", "ElyraEscrow.json"));
const J = { "content-type": "application/json" };
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // public hardhat account #0
const ADMIN = "admin.elyra.test", TOKEN = "s".repeat(10) + "correct-horse-battery-staple-7";
const TYPES = { Voucher: [{ name: "consumer", type: "address" }, { name: "provider", type: "address" }, { name: "cumulative", type: "uint256" }] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("pay from a browser session wallet (local EVM)", { skip: !have && "contracts/node_modules missing" }, () => {
  const procs = [], dirs = [];
  const RPC_PORT = 18855, G = 18865, S = 18866, STUB = 18867, RPC = `http://127.0.0.1:${RPC_PORT}`;
  const PRICE = 1000; // $ per million tokens: 18 tokens = $0.018 = 18,000 units
  let escrow, token, art, provider, deployer, gatewayId, sellerWallet, domain;
  const art_ = (n) => JSON.parse(readFileSync(join(root, "contracts", "artifacts", n + ".json"), "utf8"));
  const spawnNode = (args, cwd, env = {}) => { const p = spawn(process.execPath, args, { cwd, stdio: "pipe", env: { ...process.env, ...env } }); procs.push(p); return p; };
  const until = async (fn, ms = 25000) => { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t > ms) throw new Error("timeout"); await sleep(150); } };
  const api = (port) => async (p, method = "GET", body) => { const r = await fetch(`http://localhost:${port}${p}`, { method, headers: J, body: body && JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
  const g = api(G), s = api(S);
  /** a visitor's request to the gateway's public surface (Host = the admin host, no login) */
  const pub = (method, path, body) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: G, method, path, headers: { host: ADMIN, ...(body ? J : {}) } }, (res) => { let d = ""; res.setEncoding("utf8"); res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: d })); });
    req.on("error", reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
  const sse = (text) => { const out = { text: "", pay: null, error: null, done: false }; for (const blk of text.split("\n\n")) { const ev = /^event: (\w+)/m.exec(blk)?.[1], data = /^data: (.*)$/m.exec(blk)?.[1]; if (!data) continue; if (data === "[DONE]") { out.done = true; continue; } if (ev === "pay") out.pay = JSON.parse(data); else if (ev === "error") out.error = JSON.parse(data); else { try { out.text += JSON.parse(data).choices?.[0]?.delta?.content ?? ""; } catch { /* ignore */ } } } return out; };
  const newSession = async () => { const w = Wallet.createRandom(); return { w, session: { wallet: w.address, proof: await w.signMessage(`elyra-wallet-binding:${gatewayId}:${w.address.toLowerCase()}`) } }; };
  const fund = async (addr, units) => { await (await new Contract(token, art_("MockUSDG").abi, deployer).mint(deployer.address ?? (await deployer.getAddress()), units)).wait(); await (await new Contract(token, art_("MockUSDG").abi, deployer).approve(escrow, units)).wait(); await (await new Contract(escrow, art_("ElyraEscrow").abi, deployer).depositFor(addr, units)).wait(); };
  const chat = (b) => pub("POST", "/pub/paid-chat", { model: "stub-1", maxPrice: PRICE * 2, messages: [{ role: "user", content: "ping" }], ...b });
  const signVoucher = (w, providerWallet, cumulative) => w.signTypedData(domain, TYPES, { consumer: w.address, provider: providerWallet, cumulative: BigInt(cumulative) });

  const stub = createServer((req, res) => {
    if (req.url.endsWith("/models")) return res.setHeader("content-type", "application/json"), res.end(JSON.stringify({ data: [{ id: "stub-1" }] }));
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "pong " } }] })}\n\n`); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "pong" } }], usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 } })}\n\n`); res.end("data: [DONE]\n\n");
    });
  });

  before(async () => {
    spawnNode([hardhatCli, "node", "--port", String(RPC_PORT)], join(root, "contracts"));
    provider = new JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
    await until(() => provider.getNetwork());
    deployer = new NonceManager(new Wallet(DEV_KEY, provider)); deployer.address = new Wallet(DEV_KEY).address;
    art = (n) => art_(n);
    const tok = await new ContractFactory(art("MockUSDG").abi, art("MockUSDG").bytecode, deployer).deploy(); await tok.waitForDeployment();
    const esc = await new ContractFactory(art("ElyraEscrow").abi, art("ElyraEscrow").bytecode, deployer).deploy(await tok.getAddress()); await esc.waitForDeployment();
    escrow = await esc.getAddress(); token = await tok.getAddress();
    domain = { name: "ElyraEscrow", version: "1", chainId: 31337, verifyingContract: escrow };
    await new Promise((r) => stub.listen(STUB, r));
    const dirG = mkdtempSync(join(tmpdir(), "vpr-sp-g-")), dirS = mkdtempSync(join(tmpdir(), "vpr-sp-s-")); dirs.push(dirG, dirS);
    spawnNode([join(root, "router", "server.mjs"), "--port", String(S), "--data", dirS, "--name", "seller", "--no-demo"]);
    spawnNode([join(root, "router", "server.mjs"), "--port", String(G), "--data", dirG, "--name", "gateway", "--no-demo"], root, { ELYRA_ADMIN_HOST: ADMIN, ELYRA_ADMIN_TOKEN: TOKEN, ELYRA_PUBLIC_TRY: "1", ELYRA_PUBLIC_PAY: "1" });
    for (const p of [S, G]) await until(async () => (await fetch(`http://localhost:${p}/p2p/hello`)).ok);
    const cfg = { network: "local", rpcUrl: RPC, chainId: 31337, escrow };
    await g("/api/chain", "PUT", cfg); await s("/api/chain", "PUT", cfg);
    const up = await s("/api/upstreams", "POST", { name: "stub", baseUrl: `http://localhost:${STUB}/v1` });
    await s("/api/provide", "PUT", { enabled: true, upstreamId: up.id, price: PRICE, autoRedeem: false, creditUsd: 1 });
    const si = await s("/api/chain"); sellerWallet = si.address;
    await (await deployer.sendTransaction({ to: sellerWallet, value: parseEther("1") })).wait(); // gas for the seller's redeem
    gatewayId = (await g("/api/status")).node.id;
    await g("/api/peers", "POST", { url: `http://localhost:${S}` }); await g("/api/peers/refresh", "POST", {});
    await until(async () => (await g("/api/peers")).peers.some((p) => p.online && p.providing && p.models?.length));
  });
  after(() => { stub.close(); procs.forEach((p) => p.kill()); setTimeout(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })), 500); });

  test("the gateway announces that paying is on and exposes only public chain facts", async () => {
    const c = JSON.parse((await pub("GET", "/pub/chain")).body);
    assert.equal(c.enabled, true); assert.equal(c.pay, true); assert.equal(c.escrow, escrow); assert.equal(JSON.stringify(c).includes(sellerWallet), false);
  });

  let W, session, voucher1, claimed0;
  test("a session with a deposit pays per use: answer streams, the receipt amount comes back, the session key signs the voucher, the seller accepts it", async () => {
    ({ w: W, session } = await newSession());
    await fund(W.address, 1_000_000n);
    const pos = JSON.parse((await pub("GET", `/pub/session?wallet=${W.address}`)).body); assert.equal(pos.depositUnits, "1000000");
    const r = await chat({ session });
    assert.equal(r.status, 200, r.body); const o = sse(r.body);
    assert.equal(o.text.trim(), "pong pong"); assert.equal(o.done, true); assert.equal(o.error, null);
    assert.equal(o.pay.amountUnits, "18000", "(7 + 11) tokens x $1000 per million"); assert.equal(o.pay.providerWallet.toLowerCase(), sellerWallet.toLowerCase());
    claimed0 = BigInt(o.pay.claimedUnits); assert.equal(claimed0, 0n);
    const cumulative = (claimed0 + BigInt(o.pay.amountUnits)).toString();
    voucher1 = { cumulative, sig: await signVoucher(W, o.pay.providerWallet, cumulative), providerId: o.pay.providerId };
    const v = await pub("POST", "/pub/voucher", { session, providerId: voucher1.providerId, cumulative, sig: voucher1.sig });
    assert.equal(JSON.parse(v.body).accepted, true, v.body);
    assert.equal(JSON.parse((await pub("POST", "/pub/voucher", { session, providerId: voucher1.providerId, cumulative, sig: voucher1.sig })).body).accepted, false, "the same voucher twice is not a new voucher");
  });

  test("the next chat carries the voucher; after two chats the seller redeems exactly what the session signed, out of the session's own deposit", async () => {
    const providerWallet = sellerWallet.toLowerCase();
    const r = await chat({ session, vouchers: { [providerWallet]: { cumulative: voucher1.cumulative, sig: voucher1.sig } } });
    assert.equal(r.status, 200, r.body); const o = sse(r.body); assert.equal(o.pay.amountUnits, "18000");
    const cumulative = (BigInt(voucher1.cumulative) + 18000n).toString();
    const sig = await signVoucher(W, o.pay.providerWallet, cumulative);
    assert.equal(JSON.parse((await pub("POST", "/pub/voucher", { session, providerId: o.pay.providerId, cumulative, sig })).body).accepted, true);
    const tk = new Contract(token, art_("MockUSDG").abi, provider), es = new Contract(escrow, art_("ElyraEscrow").abi, provider);
    const before = await tk.balanceOf(sellerWallet);
    const { batches } = await s("/api/ledger/settle", "POST"); assert.equal(batches.length, 1); assert.equal(BigInt(batches[0].paidUnits), 36000n);
    assert.equal((await tk.balanceOf(sellerWallet)) - before, 36000n, "the seller received exactly the two vouchers");
    assert.equal(await es.deposits(W.address), 1_000_000n - 36000n, "taken from the session's deposit");
  });

  test("the gateway never holds money or a signing key for the visitor: its own wallet has no deposit and signed no voucher", async () => {
    const gi = await g("/api/chain"); assert.equal(gi.depositUsd, 0); assert.deepEqual(gi.vouchersOut ?? [], []);
    const es = new Contract(escrow, art_("ElyraEscrow").abi, provider); assert.equal(await es.deposits(gi.address), 0n);
  });

  test("a session that does not prove control is refused: wrong key, someone else's address, another node's binding", async () => {
    const other = Wallet.createRandom();
    const forged = { wallet: W.address, proof: await other.signMessage(`elyra-wallet-binding:${gatewayId}:${W.address.toLowerCase()}`) };
    const wrongNode = { wallet: W.address, proof: await W.signMessage(`elyra-wallet-binding:0123456789abcdef:${W.address.toLowerCase()}`) };
    for (const [name, sess] of [["forged", forged], ["wrong node id", wrongNode], ["missing", undefined], ["no proof", { wallet: W.address }], ["not an address", { wallet: "0x12", proof: "0x" }]]) {
      const r = await chat({ session: sess }); assert.equal(r.status, 400, name + ": " + r.body);
    }
    const v = await pub("POST", "/pub/voucher", { session: forged, providerId: voucher1.providerId, cumulative: "99999999", sig: voucher1.sig }); assert.equal(v.status, 400);
  });

  test("a voucher the contract would not accept never reaches the seller: wrong signer, wrong amount, wrong provider, garbage", async () => {
    const o = sse((await chat({ session })).body); const pw = o.pay.providerWallet, next = (BigInt(voucher1.cumulative) + 18000n * 2n + 18000n).toString();
    const good = await signVoucher(W, pw, next);
    const intruder = Wallet.createRandom();
    const cases = { "signed by another key": await signVoucher(intruder, pw, next), "amount changed after signing": good.replace(/.$/, good.endsWith("0") ? "1" : "0"), "for another provider": await signVoucher(W, Wallet.createRandom().address, next), "garbage": "0x1234", "a different amount": await signVoucher(W, pw, "5") };
    for (const [name, sig] of Object.entries(cases)) {
      const r = await pub("POST", "/pub/voucher", { session, providerId: o.pay.providerId, cumulative: next, sig }); assert.equal(r.status, 400, name + ": " + r.body);
    }
    for (const bad of ["-5", "1.5", "abc", "", "9".repeat(40)]) assert.equal((await pub("POST", "/pub/voucher", { session, providerId: o.pay.providerId, cumulative: bad, sig: good })).status, 400, "cumulative " + bad);
    assert.equal((await pub("POST", "/pub/voucher", { session, providerId: "nope", cumulative: next, sig: good })).status, 404);
  });

  test("an unfunded session cannot start a chat (402), and nothing is sent to the seller", async () => {
    const { session: empty } = await newSession(); const earnBefore = (await s("/api/ledger")).entries.filter((e) => e.type === "earn").length;
    const r = await chat({ session: empty }); assert.equal(r.status, 402, r.body); assert.match(JSON.parse(r.body).error.message, /Add funds/);
    assert.equal((await s("/api/ledger")).entries.filter((e) => e.type === "earn").length, earnBefore);
  });

  test("a price above what the visitor accepts finds no seller; one session runs one chat at a time; bad shapes are refused", async () => {
    assert.equal((await chat({ session, maxPrice: 1 })).status, 404);
    const a = chat({ session }), b = chat({ session }); const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual([ra.status, rb.status].sort(), [200, 429], "the second request of the same session is refused while the first runs");
    for (const bad of [{ messages: [] }, { messages: [{ role: "system", content: "x" }] }, { messages: [{ role: "user", content: "" }] }, { maxPrice: "abc" }, { model: "" }]) assert.equal((await chat({ session, ...bad })).status, 400, JSON.stringify(bad));
    const r = await pub("POST", "/pub/paid-chat", { session }); assert.equal(r.status, 400);
  });

  test("the surface is closed to cross-site pages and other methods", async () => {
    const x = await new Promise((resolve, reject) => { const req = request({ host: "127.0.0.1", port: G, method: "POST", path: "/pub/paid-chat", headers: { host: ADMIN, origin: "https://evil.example", ...J } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }); req.on("error", reject); req.end("{}"); });
    assert.equal(x, 403); assert.equal((await pub("GET", "/pub/paid-chat")).status, 405); assert.equal((await pub("POST", "/pub/session")).status, 405);
    assert.equal((await pub("GET", "/pub/session?wallet=nope")).status, 400);
  });
});
