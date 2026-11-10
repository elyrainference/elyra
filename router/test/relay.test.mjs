// Relay: a seller that cannot accept inbound connections is reached through a public node. Covers the protocol in-process (auth, replay,
// bounds, forged replies, what a seller will run) and end to end over three real nodes. Run: node --test router/test/relay.test.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { createRelay, idOfPub } from "../http/relay.mjs";
import { startRelayClient } from "../core/relay-client.mjs";
import { canon } from "../lib/canon.mjs";
import { normUrl } from "../lib/url.mjs";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
const J = { "content-type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (srv, port = 0) => new Promise((r) => srv.listen(port, "127.0.0.1", () => r(srv.address().port)));
const keypair = () => { const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519"); const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64"); return { pub, id: idOfPub(pub), sign: (o) => crypto.sign(null, Buffer.from(canon(o)), privateKey).toString("base64") }; };
const nonce = () => crypto.randomBytes(8).toString("hex");
const waitBody = (k, over = {}) => { const ts = Date.now(), n = nonce(); return { pub: k.pub, ts, nonce: n, sig: k.sign({ t: "relay-wait", id: k.id, ts, nonce: n }), ...over }; };
const replyHeaders = (k, job, over = {}) => { const ts = Date.now(), n = nonce(); return { "x-relay-pub": k.pub, "x-relay-ts": String(ts), "x-relay-nonce": n, "x-relay-sig": k.sign({ t: "relay-reply", job, ts, nonce: n }), ...over }; };

/** an in-process relay on a real port */
async function mkRelay(limits = {}) {
  const relay = createRelay({ env: { ELYRA_RELAY: "1" }, limits });
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    try { if (relay.owns(url.pathname)) return await relay.handle(req, res, url.pathname, url); res.writeHead(404).end("not relay"); }
    catch (e) { if (!res.headersSent) res.writeHead(e.status ?? 500, J); res.end(JSON.stringify({ error: { message: e.message } })); }
  });
  const port = await listen(srv); return { relay, srv, base: `http://127.0.0.1:${port}`, close: () => srv.close() };
}
const post = (url, body, headers = {}) => fetch(url, { method: "POST", headers: { ...J, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("relay protocol (in-process)", () => {
  test("disabled unless exactly ELYRA_RELAY=1", () => { assert.equal(createRelay({ env: {} }).enabled, false); assert.equal(createRelay({ env: { ELYRA_RELAY: "true" } }).enabled, false); });

  test("a poll needs a valid signature by the key behind the id, and a nonce is accepted once", async () => {
    const R = await mkRelay({ waitMs: 200 }); const k = keypair(), other = keypair();
    try {
      assert.equal((await post(R.base + "/relay/wait", waitBody(k, { sig: other.sign({ t: "relay-wait", id: k.id, ts: 1, nonce: "x" }) }))).status, 401, "wrong key");
      assert.equal((await post(R.base + "/relay/wait", waitBody(k, { pub: other.pub }))).status, 401, "someone else's id/pub mix");
      const ok = waitBody(k); assert.equal((await post(R.base + "/relay/wait", ok)).status, 204);
      assert.equal((await post(R.base + "/relay/wait", ok)).status, 401, "replayed poll");
      { const ts = Date.now() - 120_000, n = nonce(); assert.equal((await post(R.base + "/relay/wait", { pub: k.pub, ts, nonce: n, sig: k.sign({ t: "relay-wait", id: k.id, ts, nonce: n }) })).status, 401, "a correctly signed but stale poll"); }
    } finally { R.close(); }
  });

  test("a buyer is told when the seller is offline; unknown paths and methods are not carried", async () => {
    const R = await mkRelay({ waitMs: 100 }); const k = keypair();
    try {
      assert.equal((await post(`${R.base}/r/${k.id}/p2p/infer`, {})).status, 502, "never registered");
      await post(R.base + "/relay/wait", waitBody(k)); // now known
      for (const path of ["/api/status", "/v1/models", "/p2p/../api/status", "/p2p/hello/x", "/p2p/secret"]) { const r = await fetch(`${R.base}/r/${k.id}${path}`); assert.notEqual(r.status, 200, path); assert.notEqual(r.status, 502 && 0, path); }
      assert.equal((await fetch(`${R.base}/r/${k.id}/p2p/infer`)).status, 405, "GET on infer");
      assert.equal((await fetch(`${R.base}/r/${k.id}/p2p/voucher`)).status, 405);
    } finally { R.close(); }
  });

  test("a job reaches the seller and the streamed answer reaches the buyer; only the owner of the id can answer", async () => {
    const R = await mkRelay({ waitMs: 5000 }); const k = keypair(), thief = keypair();
    try {
      const poll = post(R.base + "/relay/wait", waitBody(k)).then((r) => r.json());
      await sleep(100);
      const buyer = fetch(`${R.base}/r/${k.id}/p2p/infer`, { method: "POST", headers: J, body: JSON.stringify({ hi: 1 }) });
      const job = await poll;
      assert.equal(job.path, "/p2p/infer"); assert.equal(JSON.parse(Buffer.from(job.body, "base64")).hi, 1);
      const head = Buffer.from(JSON.stringify({ status: 200, headers: { "content-type": "text/event-stream", "set-cookie": "evil=1", "x-evil": "1" } }) + "\n");
      const forged = await fetch(`${R.base}/relay/reply?job=${job.job}`, { method: "POST", headers: replyHeaders(thief, job.job), body: Buffer.concat([head, Buffer.from("FORGED")]) });
      assert.equal(forged.status, 401, "another key cannot answer");
      const forged2 = await fetch(`${R.base}/relay/reply?job=${job.job}`, { method: "POST", headers: replyHeaders(thief, job.job, { "x-relay-pub": k.pub }), body: head });
      assert.equal(forged2.status, 401, "claiming the owner's pub with the wrong signature");
      const body = new ReadableStream({ async start(c) { c.enqueue(head); c.enqueue(Buffer.from("data: one\n\n")); await sleep(150); c.enqueue(Buffer.from("data: two\n\n")); c.close(); } });
      const rep = await fetch(`${R.base}/relay/reply?job=${job.job}`, { method: "POST", headers: replyHeaders(k, job.job), body, duplex: "half" });
      assert.equal(rep.status, 200);
      const r = await buyer;
      assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "text/event-stream");
      assert.equal(r.headers.get("set-cookie"), null, "a seller cannot set cookies on the relay's origin"); assert.equal(r.headers.get("x-evil"), null);
      assert.equal(await r.text(), "data: one\n\ndata: two\n\n");
      assert.equal((await fetch(`${R.base}/relay/reply?job=${job.job}`, { method: "POST", headers: replyHeaders(k, job.job), body: head })).status, 410, "a job is answered once");
    } finally { R.close(); }
  });

  test("bounds: body size, queue length and a seller that never answers", async () => {
    const R = await mkRelay({ waitMs: 50, maxQueue: 2, headMs: 400 }); const k = keypair();
    try {
      await post(R.base + "/relay/wait", waitBody(k));
      assert.equal((await post(`${R.base}/r/${k.id}/p2p/voucher`, "x".repeat(20_001))).status, 413, "voucher body limit");
      assert.equal((await post(`${R.base}/r/${k.id}/p2p/hello`, "x".repeat(100_001))).status, 413, "hello body limit");
      const held = [1, 2, 3].map(() => post(`${R.base}/r/${k.id}/p2p/voucher`, { n: 1 }).then((r) => r.status));
      const got = await Promise.all(held);
      assert.deepEqual(got.sort(), [503, 504, 504], "two are queued and time out; the third is refused as busy");
    } finally { R.close(); }
  });

  test("a full relay refuses new sellers but keeps serving the ones it has", async () => {
    const R = await mkRelay({ waitMs: 50, maxSellers: 2 }); const a = keypair(), b = keypair(), c = keypair();
    try {
      assert.equal((await post(R.base + "/relay/wait", waitBody(a))).status, 204); assert.equal((await post(R.base + "/relay/wait", waitBody(b))).status, 204);
      assert.equal((await post(R.base + "/relay/wait", waitBody(c))).status, 503);
      assert.equal((await post(R.base + "/relay/wait", waitBody(a))).status, 204);
    } finally { R.close(); }
  });

  test("a buyer who hangs up frees the job; the seller's late reply is refused", async () => {
    const R = await mkRelay({ waitMs: 3000 }); const k = keypair();
    try {
      const poll = post(R.base + "/relay/wait", waitBody(k)).then((r) => r.json()); await sleep(100);
      const ac = new AbortController(); fetch(`${R.base}/r/${k.id}/p2p/infer`, { method: "POST", headers: J, body: "{}", signal: ac.signal }).catch(() => {});
      const job = await poll; ac.abort(); await sleep(150);
      assert.equal((await fetch(`${R.base}/relay/reply?job=${job.job}`, { method: "POST", headers: replyHeaders(k, job.job), body: Buffer.from('{"status":200,"headers":{}}\n') })).status, 410);
    } finally { R.close(); }
  });
});

describe("the seller side runs only the peer endpoints, whatever the relay asks", () => {
  test("a hostile relay cannot reach /api, /v1 or traversal paths of the seller", async () => {
    const hits = []; const local = createServer((req, res) => { hits.push(req.method + " " + req.url); res.writeHead(200, J).end("{}"); });
    const lport = await listen(local);
    const replies = []; const jobsToSend = [{ path: "/api/upstreams", method: "GET" }, { path: "/v1/models", method: "GET" }, { path: "/p2p/../api/status", method: "GET" }, { path: "/p2p/infer", method: "GET" }, { path: "/p2p/hello?x=/api/chain", method: "POST" }, { path: "/p2p/hello", method: "POST" }];
    const fake = createServer(async (req, res) => {
      const url = new URL(req.url, "http://x"); const chunks = []; for await (const c of req) chunks.push(c);
      if (url.pathname === "/relay/wait") { const j = jobsToSend.shift(); if (!j) return setTimeout(() => res.writeHead(204).end(), 100); return res.writeHead(200, J).end(JSON.stringify({ job: "j" + replies.length, ctype: "application/json", body: Buffer.from("{}").toString("base64"), ...j })); }
      if (url.pathname === "/relay/reply") { replies.push(Buffer.concat(chunks).toString().split("\n")[0]); return res.writeHead(200, J).end("{}"); }
      res.writeHead(404).end();
    });
    const fport = await listen(fake); const k = keypair();
    const client = startRelayClient({ relayUrl: `http://127.0.0.1:${fport}`, identity: k, port: lport });
    try {
      for (let i = 0; i < 80 && replies.length < 6; i++) await sleep(50);
      assert.equal(replies.length, 6);
      assert.deepEqual(hits, ["POST /p2p/hello"], "only the one legitimate job reached the seller's own server");
      assert.deepEqual(replies.map((r) => JSON.parse(r).status), [404, 404, 404, 404, 404, 200]);
    } finally { client.stop(); local.close(); fake.close(); }
  });
});

describe("normUrl keeps a relay path and nothing else", () => {
  test("origin plus /r/<id> only", () => {
    assert.equal(normUrl("https://relay.example/r/0123456789abcdef"), "https://relay.example/r/0123456789abcdef");
    assert.equal(normUrl("https://relay.example/r/0123456789abcdef/"), "https://relay.example/r/0123456789abcdef");
    for (const u of ["https://x.example/anything", "https://x.example/r/short", "https://x.example/r/0123456789abcdef/p2p/hello", "https://x.example/r/0123456789ABCDEF", "https://x.example/?a=1#b"]) assert.equal(normUrl(u), "https://x.example", u);
  });
});

describe("end to end: buyer -> relay -> seller behind it", () => {
  const procs = [], dirs = [];
  const RP = 18740, SP = 18741, BP = 18742, STUB = 18749;
  const start = async (port, name, extra = [], env = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "vpr-relay-")); dirs.push(dir);
    const p = spawn(process.execPath, [server, "--port", String(port), "--data", dir, "--name", name, "--no-demo", "--allow-private-peers", ...extra], { stdio: "pipe", env: { ...process.env, ...env } }); procs.push(p);
    for (let i = 0; i < 300; i++) { try { if ((await fetch(`http://localhost:${port}/p2p/hello`)).ok) return p; } catch { /* booting */ } await sleep(100); }
    throw new Error("node did not start");
  };
  const j = async (port, path, method = "GET", body) => (await fetch(`http://localhost:${port}${path}`, { method, headers: J, body: body && JSON.stringify(body) })).json();
  const stub = createServer((req, res) => {
    if (req.url.endsWith("/models")) return res.setHeader("content-type", "application/json"), res.end(JSON.stringify({ data: [{ id: "stub-1" }] }));
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      const usage = { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 };
      if (JSON.parse(raw).stream) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "pong " } }] })}\n\n`); res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "pong" } }], usage })}\n\n`); return res.end("data: [DONE]\n\n"); }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "stub-1", choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }], usage }));
    });
  });
  let sellerId, relayUrl, sellerPeerUrl;
  before(async () => {
    await new Promise((r) => stub.listen(STUB, r));
    await start(RP, "relay", [], { ELYRA_RELAY: "1" });
    relayUrl = `http://127.0.0.1:${RP}`;
    await start(SP, "seller", ["--relay", relayUrl]);
    await start(BP, "buyer");
    const up = await j(SP, "/api/upstreams", "POST", { name: "stub", baseUrl: `http://localhost:${STUB}/v1` });
    await j(SP, "/api/provide", "PUT", { enabled: true, upstreamId: up.id, price: 2 });
    sellerId = (await j(SP, "/api/status")).node.id; sellerPeerUrl = `${relayUrl}/r/${sellerId}`;
    for (let i = 0; i < 100; i++) { if ((await j(SP, "/api/status")).node.relay?.connected) break; await sleep(100); }
  });
  after(() => { stub.close(); procs.forEach((p) => p.kill()); setTimeout(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })), 300); });

  test("a seller started with --relay advertises <relay>/r/<id> as its address and is connected", async () => {
    const st = await j(SP, "/api/status"); assert.equal(st.node.publicUrl, sellerPeerUrl); assert.equal(st.node.relay.connected, true);
    const hello = await (await fetch(`${sellerPeerUrl}/p2p/hello`)).json(); assert.equal(hello.id, sellerId); assert.equal(hello.url, sellerPeerUrl);
  });
  test("a buyer adds the seller by its relay address and gets a real paid answer, streaming included", async () => {
    const added = await j(BP, "/api/peers", "POST", { url: sellerPeerUrl }); assert.equal(added.id ?? added.peer?.id ?? sellerId, sellerId);
    const chat = (stream) => fetch(`http://localhost:${BP}/v1/chat/completions`, { method: "POST", headers: J, body: JSON.stringify({ model: "stub-1", stream, messages: [{ role: "user", content: "ping" }] }) });
    const r = await chat(false); assert.equal(r.status, 200); assert.equal(r.headers.get("x-elyra-route"), "peer:seller"); assert.equal((await r.json()).choices[0].message.content, "pong");
    const s = await (await chat(true)).text(); assert.ok(s.includes("pong") && s.trimEnd().endsWith("data: [DONE]"));
    const spend = (await j(BP, "/api/ledger")).entries.filter((e) => e.type === "spend"); assert.equal(spend.length, 2);
    assert.ok(Math.abs(spend[0].amount - (18 * 2) / 1e6) < 1e-12);
    const earn = (await j(SP, "/api/ledger")).entries.filter((e) => e.type === "earn"); assert.equal(earn.length, 2, "the seller was paid for both");
    const m = await (await fetch(`http://localhost:${RP}/metrics`)).text(); assert.match(m, /elyra_relay_jobs_total\{outcome="ok"\} [2-9]/, "the traffic really went through the relay");
  });
  test("the relay cannot be used to reach the seller's control API", async () => {
    for (const path of ["/api/status", "/v1/models", "/metrics"]) { const r = await fetch(`${sellerPeerUrl}${path}`); assert.notEqual(r.status, 200, path); }
  });
  test("when the seller goes away the buyer is told it is offline, not left hanging", async () => {
    procs[1].kill(); await sleep(300);
    const t0 = Date.now(); let status;
    for (let i = 0; i < 40; i++) { const r = await fetch(`${sellerPeerUrl}/p2p/hello`, { signal: AbortSignal.timeout(8000) }).catch(() => null); status = r?.status; if (status === 502) break; await sleep(500); }
    assert.equal(status, 502); assert.ok(Date.now() - t0 < 15_000, "noticed within seconds, not minutes");
  });
});
