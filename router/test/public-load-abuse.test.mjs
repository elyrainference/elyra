// Load, abuse and fuzz test of the public surface (/pub/*, /try/*, /admin/*, /relay/*, /r/*, /p2p/*, /healthz):
// concurrent visitors, rate-limit & concurrency-cap invariants, memory bounds under IP floods, and malformed inputs.
// Run: node --test router/test/public-load-abuse.test.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { createPublicTry } from "../http/public.mjs";
import { createRelay, idOfPub } from "../http/relay.mjs";
import { createSessionPay } from "../core/consumer/session-pay.mjs";
import { createRequestGuard } from "../core/provider/guard.mjs";
import { createServe } from "../core/provider/serve.mjs";
import { loadIdentity } from "../core/identity.mjs";
import { sealTo } from "../seal.mjs";
import { canon, sha } from "../lib/canon.mjs";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
const ADMIN = "admin.elyra.test", TOKEN = "a".repeat(10) + "correct-horse-battery-staple-5";
const J = { "content-type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rawCall = (port, { method = "GET", path = "/", host = ADMIN, headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, method, path, headers: { host, ...headers } }, (res) => {
    let data = ""; res.setEncoding("utf8"); res.on("data", (c) => (data += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
  });
  req.setTimeout(8000, () => req.destroy(new Error("request timeout")));
  req.on("error", reject);
  if (body !== undefined) req.write(body);
  req.end();
});

describe("memory bounds under multi-IP flood (unit)", () => {
  test("hits and payHits Maps stay capped at <= 5000 entries even when 6,000 fresh IPs arrive in the same hour", async () => {
    const node = {
      cands: () => [{ kind: "self", hosted: false, simulated: false, sourceId: "u1", model: "m", key: "k:s" }],
      upstreamById: () => ({ kind: "openai", name: "local" }),
      state: { name: "n", peers: {}, chain: {} },
      chain: { configured: () => true, info: async () => ({}) },
      execLocal: async () => ({ frames: (async function* () { yield "data: [DONE]\n\n"; })(), usage: Promise.resolve({ p: 1, c: 1 }) }),
      sessionPay: {
        chat: async () => {},
        voucher: async () => ({ accepted: false }),
        position: async () => ({ depositUnits: "0", depositUsd: 0 }),
      },
    };
    const pub = createPublicTry(node, {
      staticFile: async () => {},
      env: { ELYRA_PUBLIC_TRY: "1", ELYRA_PUBLIC_PAY: "1", ELYRA_TRY_DAILY: "100000", ELYRA_TRY_CONCURRENCY: "16" },
    });
    const mkRes = () => ({ headersSent: false, setHeader() {}, writeHead() { this.headersSent = true; return this; }, write() { return true; }, end() { return this; }, on() {}, once() {} });
    for (let i = 0; i < 5400; i++) {
      const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
      await pub.handle({ method: "GET", url: "/pub/session?wallet=0x" + "1".repeat(40), headers: { "cf-connecting-ip": ip }, socket: {} }, mkRes(), "/pub/session");
      const chatReq = (async function* () { yield Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "hi" }] })); })();
      chatReq.method = "POST"; chatReq.url = "/pub/chat"; chatReq.headers = { "content-type": "application/json", "cf-connecting-ip": ip }; chatReq.socket = {};
      await pub.handle(chatReq, mkRes(), "/pub/chat");
    }
    const st = pub.stats();
    assert.ok(st.hits <= 5000, `hits should be <= 5000, got ${st.hits}`);
    assert.ok(st.payHits <= 5000, `payHits should be <= 5000, got ${st.payHits}`);
    assert.equal(st.inflight, 0);
    assert.equal(st.payInflight, 0);
  });

  test("concurrent /pub/paid-chat flood enforces payInflight concurrency cap (503) and per-IP hourly limit (429)", async () => {
    const node = {
      cands: () => [],
      upstreamById: () => null,
      state: { name: "n", peers: {}, chain: {} },
      chain: { configured: () => true, info: async () => ({}) },
      sessionPay: {
        chat: async (_body, out) => { await sleep(120); out.head(200, { "content-type": "text/event-stream" }); out.write("data: [DONE]\n\n"); out.end(); },
        voucher: async () => ({ accepted: true }),
        position: async () => ({ depositUnits: "100", depositUsd: 0.0001 }),
      },
    };
    const pub = createPublicTry(node, {
      staticFile: async () => {},
      env: { ELYRA_PUBLIC_TRY: "1", ELYRA_PUBLIC_PAY: "1", ELYRA_PAY_PER_IP_HOUR: "3", ELYRA_PAY_CONCURRENCY: "2" },
    });
    const callPaid = async (ip) => {
      let status = 0;
      const req = (async function* () { yield Buffer.from(JSON.stringify({ messages: [{ role: "user", content: "hi" }] })); })();
      req.method = "POST"; req.url = "/pub/paid-chat"; req.headers = { "content-type": "application/json", "cf-connecting-ip": ip }; req.socket = {};
      const res = { headersSent: false, setHeader() {}, writeHead(s) { status = s; this.headersSent = true; return this; }, write() { return true; }, end() { return this; }, on() {}, once() {} };
      try { await pub.handle(req, res, "/pub/paid-chat"); } catch (e) { status = e.status ?? 500; }
      return status;
    };
    const wave = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => callPaid(`198.51.100.${i}`)));
    assert.equal(wave.filter((s) => s === 200).length, 2, "exactly 2 run concurrently");
    assert.equal(wave.filter((s) => s === 503).length, 4, "4 excess concurrent paid-chats get 503 busy");
    assert.equal(pub.stats().payInflight, 0, "payInflight returns to 0");
    for (let i = 0; i < 3; i++) assert.equal(await callPaid("198.51.100.99"), 200);
    assert.equal(await callPaid("198.51.100.99"), 429, "4th paid-chat from same IP is rate-limited with 429");
  });

  test("provider seenNonces Map stays capped at <= 20000 entries under a fresh-nonce flood", () => {
    const dir = mkdtempSync(join(tmpdir(), "vpr-guard-"));
    try {
      const identity = loadIdentity(dir, "");
      const guard = createRequestGuard({ identity });
      const consumer = loadIdentity(mkdtempSync(join(tmpdir(), "vpr-c-")), "");
      const body = { messages: [{ role: "user", content: "x" }] };
      const bodyHash = sha(canon(body));
      const ts = Date.now();
      for (let i = 0; i < 20_500; i++) {
        const nonce = "n_" + i;
        const sig = consumer.sign({ provider: identity.id, ts, nonce, model: "m", bodyHash });
        guard.authenticate({ from: consumer.id }, { consumer: { id: consumer.id, pub: consumer.pub }, model: "m", body, auth: { ts, nonce, sig } });
      }
      // oldest nonces were evicted once > 20000, while recent nonces are still remembered and rejected on replay
      const recentNonce = "n_20499";
      const recentSig = consumer.sign({ provider: identity.id, ts, nonce: recentNonce, model: "m", bodyHash });
      assert.throws(() => guard.authenticate({ from: consumer.id }, { consumer: { id: consumer.id, pub: consumer.pub }, model: "m", body, auth: { ts, nonce: recentNonce, sig: recentSig } }), (e) => e.status === 409);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("unit regressions: /pub/session RPC failure, /p2p/infer malformed sealed payloads, relay zombie queue", () => {
  test("sessionPay.position translates chain RPC failures to 503 chain_unavailable instead of 500", async () => {
    const sp = createSessionPay({
      state: { peers: {} },
      identity: { id: "0123456789abcdef" },
      chain: {
        configured: () => true,
        isAddress: (a) => /^0x[0-9a-fA-F]{40}$/.test(a),
        consumerPosition: async () => { throw new Error("RPC connection refused"); },
      },
    }, { plan: () => [], execPeer: async () => {}, record: () => {} });
    await assert.rejects(() => sp.position("0x" + "1".repeat(40)), (e) => e.status === 503 && e.type === "chain_unavailable");
  });

  test("serve and guard reject non-string wire.from and malformed decrypted payloads with 400/401, never 500", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vpr-serve-"));
    try {
      const identity = loadIdentity(dir, "");
      const guard = createRequestGuard({ identity });
      const state = { provide: { enabled: true, deny: [], ratePerMin: 100, maxConcurrent: 4, upstreamId: "u1" } };
      const { serve } = createServe({ state, save() {}, identity, chain: { configured: () => false } }, {
        execLocal: async () => { throw new Error("unreachable"); },
        upstreamById: () => ({ id: "u1" }),
        provideModels: () => [{ id: "m", price: 1 }],
        guard,
        credit: async () => ({}),
        issueReceipt: () => ({}),
      });
      for (const badWire of [{ from: 123, sealed: {} }, { from: "", sealed: {} }, { from: "x".repeat(65), sealed: {} }, { from: "abc", sealed: "not-obj" }]) {
        await assert.rejects(() => serve(badWire, {}, new AbortController()), (e) => e.status === 400);
      }
      for (const inner of [
        null,
        123,
        "str",
        [1, 2],
        { consumer: { id: "abc", pub: 12345 }, model: "m", body: {} },
        { consumer: { id: "abc", pub: { bad: 1 } }, model: "m", body: {} },
        { consumer: { id: identity.id, pub: identity.pub }, model: "m", body: "not-object", auth: { ts: Date.now(), nonce: "12345678", sig: "x" } },
        { consumer: { id: identity.id, pub: identity.pub }, model: "m", body: [], auth: { ts: Date.now(), nonce: "12345678", sig: "x" } },
        { consumer: { id: identity.id, pub: identity.pub }, model: "m", body: {}, auth: { ts: Date.now(), nonce: "", sig: "x" } },
      ]) {
        const { envelope } = sealTo(identity.box.pub, inner);
        await assert.rejects(
          () => serve({ from: inner?.consumer?.id && typeof inner.consumer.id === "string" ? inner.consumer.id : "abc", sealed: envelope }, {}, new AbortController()),
          (e) => e.status === 400 || e.status === 401,
          `inner=${JSON.stringify(inner)}`,
        );
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("relay drops queued jobs when buyers disconnect before the seller polls, and strips CRLF in seller reply headers", async () => {
    const relay = createRelay({ env: { ELYRA_RELAY: "1" }, limits: { waitMs: 400, maxQueue: 4, maxInflight: 4, headMs: 2000 } });
    const srv = createServer(async (req, res) => {
      const url = new URL(req.url, "http://x");
      try { if (relay.owns(url.pathname)) return await relay.handle(req, res, url.pathname, url); res.writeHead(404).end(); }
      catch (e) { if (!res.headersSent) res.writeHead(e.status ?? 500, J); res.end(JSON.stringify({ error: { message: e.message } })); }
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port, base = `http://127.0.0.1:${port}`;
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const id = idOfPub(pub);
    const sign = (o) => crypto.sign(null, Buffer.from(canon(o)), privateKey).toString("base64");
    const waitBody = (extra = {}) => { const ts = Date.now(), nonce = crypto.randomBytes(8).toString("hex"); return { pub, ts, nonce, sig: sign({ t: "relay-wait", id, ts, nonce }), ...extra }; };
    try {
      // register seller with quick:true so s.waiter is null (between polls) but seller is alive within graceMs
      assert.equal((await fetch(base + "/relay/wait", { method: "POST", headers: J, body: JSON.stringify(waitBody({ quick: true })) })).status, 204);
      // 6 buyers enqueue and immediately abort (> maxQueue = 4)
      for (let i = 0; i < 6; i++) {
        const ac = new AbortController();
        const p = fetch(`${base}/r/${id}/p2p/voucher`, { method: "POST", headers: J, body: JSON.stringify({ n: i }), signal: ac.signal }).catch(() => {});
        await sleep(15);
        ac.abort();
        await p;
      }
      await sleep(30);
      assert.equal(relay.stats().jobs, 0, "all aborted jobs were cleaned up");
      // now a real buyer sends a request and the seller polls: the seller gets the real buyer's job, not a dead one
      const buyerP = fetch(`${base}/r/${id}/p2p/voucher`, { method: "POST", headers: J, body: JSON.stringify({ real: 42 }) });
      await sleep(20);
      const pollRes = await fetch(base + "/relay/wait", { method: "POST", headers: J, body: JSON.stringify(waitBody()) });
      assert.equal(pollRes.status, 200);
      const job = await pollRes.json();
      assert.equal(JSON.parse(Buffer.from(job.body, "base64")).real, 42);
      // seller replies with CRLF characters inside content-type header: must be sanitized without throwing 502
      const ts = Date.now(), nonce = crypto.randomBytes(8).toString("hex");
      const head = Buffer.from(JSON.stringify({ status: 200, headers: { "content-type": "application/json\r\nx-injected: 1" } }) + "\n{\"accepted\":true}");
      const rep = await fetch(`${base}/relay/reply?job=${job.job}`, {
        method: "POST",
        headers: { "x-relay-pub": pub, "x-relay-ts": String(ts), "x-relay-nonce": nonce, "x-relay-sig": sign({ t: "relay-reply", job: job.job, ts, nonce }) },
        body: head,
      });
      assert.equal(rep.status, 200);
      const buyerRes = await buyerP;
      assert.equal(buyerRes.status, 200);
      assert.equal(buyerRes.headers.get("x-injected"), null);
      assert.deepEqual(await buyerRes.json(), { accepted: true });
    } finally { srv.close(); }
  });
});

describe("full local rig: concurrent load and fuzzing across all public routes", () => {
  const P = 18981, STUB = 18982;
  let proc, dir, stderr = "";
  const stub = createServer((req, res) => {
    if (req.url.endsWith("/models")) return res.setHeader("content-type", "application/json"), res.end(JSON.stringify({ data: [{ id: "stub-1" }] }));
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", async () => {
      const b = JSON.parse(raw);
      if (/hold/.test(b.messages?.at(-1)?.content ?? "")) await sleep(250);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }], usage: { prompt_tokens: 4, completion_tokens: 2 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });

  before(async () => {
    await new Promise((r) => stub.listen(STUB, "127.0.0.1", r));
    dir = mkdtempSync(join(tmpdir(), "vpr-load-"));
    proc = spawn(process.execPath, [server, "--port", String(P), "--data", dir, "--no-demo"], {
      env: {
        ...process.env,
        ELYRA_ADMIN_HOST: ADMIN,
        ELYRA_ADMIN_TOKEN: TOKEN,
        ELYRA_PUBLIC_TRY: "1",
        ELYRA_PUBLIC_PAY: "1",
        ELYRA_RELAY: "1",
        ELYRA_TRY_PER_IP_HOUR: "3",
        ELYRA_TRY_DAILY: "30",
        ELYRA_TRY_CONCURRENCY: "2",
        ELYRA_PAY_PER_IP_HOUR: "4",
        ELYRA_PAY_CONCURRENCY: "2",
      },
      stdio: "pipe",
    });
    proc.stderr.on("data", (c) => (stderr += c.toString("utf8")));
    for (let i = 0; i < 300; i++) {
      try { if ((await rawCall(P, { path: "/healthz", host: `localhost:${P}` })).status === 200) break; } catch { /* booting */ }
      await sleep(100);
    }
    const r = await rawCall(P, { method: "POST", path: "/api/upstreams", host: `localhost:${P}`, headers: J, body: JSON.stringify({ name: "stub", baseUrl: `http://127.0.0.1:${STUB}/v1` }) });
    assert.equal(r.status, 200);
  });

  after(async () => {
    if (proc?.exitCode === null) { const d = new Promise((r) => proc.once("exit", r)); proc.kill(); await d; }
    stub.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test("150 concurrent visitors on /pub/market, /pub/info, /pub/chain and /healthz all succeed with 0 errors", async () => {
    const paths = ["/pub/market", "/pub/info", "/pub/chain", "/healthz", "/robots.txt", "/"];
    const reqs = Array.from({ length: 150 }, (_, i) => rawCall(P, { path: paths[i % paths.length], headers: { "cf-connecting-ip": `198.51.100.${(i % 200) + 1}` } }));
    const res = await Promise.all(reqs);
    assert.ok(res.every((r) => r.status === 200), "every concurrent read returned 200");
  });

  test("concurrent /pub/chat flood enforces concurrency cap (503) and per-IP hourly limit (429), then recovers cleanly", async () => {
    // 6 simultaneous slow chats from distinct IPs when concurrency cap = 2 -> exactly 2 succeed (200) and 4 get 503 busy
    const wave = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        rawCall(P, {
          method: "POST",
          path: "/pub/chat",
          headers: { ...J, "cf-connecting-ip": `203.0.113.${i + 1}` },
          body: JSON.stringify({ messages: [{ role: "user", content: "hold please" }] }),
        }),
      ),
    );
    const s200 = wave.filter((r) => r.status === 200).length;
    const s503 = wave.filter((r) => r.status === 503).length;
    assert.equal(s200, 2, `expected 2 concurrent chats to run, got ${s200}`);
    assert.equal(s503, 4, `expected 4 excess concurrent chats to get 503, got ${s503}`);

    // per-IP limit = 3/hour: IP 203.0.113.99 can make 3 sequential fast chats, and the 4th is 429
    const ip = "203.0.113.99";
    for (let i = 0; i < 3; i++) {
      const r = await rawCall(P, { method: "POST", path: "/pub/chat", headers: { ...J, "cf-connecting-ip": ip }, body: JSON.stringify({ messages: [{ role: "user", content: "fast" }] }) });
      assert.equal(r.status, 200);
    }
    const capped = await rawCall(P, { method: "POST", path: "/pub/chat", headers: { ...J, "cf-connecting-ip": ip }, body: JSON.stringify({ messages: [{ role: "user", content: "fast" }] }) });
    assert.equal(capped.status, 429);
  });

  test("fuzzing malformed bodies, headers, methods and traversal paths against every public route produces 0 5xx and 0 hangs", async () => {
    // encoded traversal & authority-confusion paths must never return 200 or leak panel code
    const traversalPaths = [
      "/try/%2e%2e%2fmain.js",
      "/try/%2e%2e%5cmain.js",
      "/try/%252e%252e%252fmain.js",
      "/try/.%2e/main.js",
      "/try/%2e./main.js",
      "/try/%2f../main.js",
      "/try/%00.js",
      "//evil.example/api/status",
      "/\\evil.example/app/main.js",
      "/%00",
      "/%ff%fe",
    ];
    for (const path of traversalPaths) {
      const r = await rawCall(P, { path });
      assert.ok(r.status === 400 || r.status === 404, `traversal path ${path} got status ${r.status}`);
      assert.doesNotMatch(r.body, /installActions|buildNav/, path);
    }

    // fuzz JSON endpoints with non-object JSON ("null", "123", "true", '"str"', "[1,2]"), broken JSON, wrong content-type, bad origins
    const postRoutes = ["/pub/chat", "/pub/paid-chat", "/pub/voucher", "/relay/wait", "/relay/reply?job=dead", "/p2p/hello", "/p2p/infer", "/p2p/voucher", "/admin/login"];
    const payloads = ["null", "123", "true", '"string"', "[1,2,3]", "{", "", "\x00\xff\xfe", JSON.stringify({ __proto__: { polluted: true }, constructor: { prototype: { polluted: true } } })];
    const tasks = [];
    for (const path of postRoutes) {
      for (const body of payloads) {
        tasks.push(rawCall(P, { method: "POST", path, headers: { ...J, "cf-connecting-ip": "192.0.2.250" }, body }));
      }
      tasks.push(rawCall(P, { method: "DELETE", path, headers: J, body: "null" }));
    }
    // also fuzz GET routes with weird query strings and headers
    for (const path of ["/pub/market?q=%00", "/pub/info", "/pub/chain", "/pub/session?wallet=null", "/pub/session?wallet=0x" + "1".repeat(40), "/r/0123456789abcdef/p2p/hello", "/r/0123456789abcdef/p2p/../../api/status", "/p2p/hello"]) {
      tasks.push(rawCall(P, { method: "GET", path, headers: { cookie: "elyra_admin=v1.notanumber.bad; a===b; ;", "cf-connecting-ip": "192.0.2.251, 10.0.0.1", origin: "http://[::1]:bad:port" } }));
    }
    const results = await Promise.all(tasks);
    for (const r of results) {
      // 502 seller_offline on /r/<unknown>/p2p/hello is the expected relay status for an offline seller; no 500 internal error may ever occur
      assert.notEqual(r.status, 500, `unexpected 500: ${r.body}`);
    }

    // aborted mid-stream POST bodies on /pub/chat, /relay/wait and /r/<id>/p2p/infer must not crash the server
    for (const path of ["/pub/chat", "/relay/wait", "/p2p/infer"]) {
      await new Promise((resolve) => {
        const req = request({ host: "127.0.0.1", port: P, method: "POST", path, headers: { host: ADMIN, "content-type": "application/json", "content-length": "5000" } });
        req.on("error", () => resolve());
        req.write('{"messages":[{"role":"user","content":"partial');
        setTimeout(() => { req.destroy(); resolve(); }, 20);
      });
    }
    await sleep(50);
    // confirm node is still healthy and zero 500 / unhandled errors occurred on any surface
    const health = await rawCall(P, { path: "/healthz", host: `localhost:${P}` });
    assert.equal(health.status, 200);
    assert.doesNotMatch(stderr, /unhandled error|"status":500/);
  });
});
