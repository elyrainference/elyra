// Private live feed: the sanitizer whitelist, the ring buffer, SSE access/resume/cleanup, and the end-to-end guarantee that
// a prompt never reaches an event. Run: node --test router/test/events.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { createChat } from "../core/consumer/chat.mjs";
import { createEvents, RING_MAX, sanitize } from "../core/events.mjs";
import { createEventsRoutes } from "../http/events.mjs";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
const CANARY = "CANARY-7f3a9c-do-not-leak";
const ADDR = "0x" + "ab12".repeat(10), TXH = "0x" + "cd34".repeat(16);
const J = { "content-type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000, what = "condition") => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout: " + what); await sleep(50); } };

describe("sanitizer", () => {
  test("only whitelisted, correctly typed fields survive; prompts, keys and unknown fields are dropped", () => {
    const e = sanitize("request", {
      role: "buyer", status: "ok", peer: "seller-1", model: "llama3.2:3b", promptTokens: 7, completionTokens: 11, costUsd: 0.000036, ttftMs: 120, latencyMs: 480, simulated: false,
      prompt: CANARY, messages: [{ content: CANARY }], completion: CANARY, apiKey: "sk-live-abcdefghijklmnop", authorization: "Bearer abcdefghijklmnop", privateKey: "0x" + "11".repeat(32), ip: "203.0.113.9", __proto__: { x: 1 },
    });
    assert.deepEqual(e, { role: "buyer", status: "ok", peer: "seller-1", model: "llama3.2:3b", promptTokens: 7, completionTokens: 11, costUsd: 0.000036, ttftMs: 120, latencyMs: 480, simulated: false });
    assert.ok(!JSON.stringify(e).includes(CANARY));
  });

  test("a secret-shaped value in an allowed field is dropped, not emitted", () => {
    for (const v of ["sk-live-abcdefghijklmnop", "Bearer abcdefghijklmnop", "-----BEGIN PRIVATE KEY-----", "0x" + "11".repeat(32), ADDR]) {
      assert.equal(sanitize("peer", { state: "online", name: v }), null, "the required name was secret-shaped, so the event is refused: " + v.slice(0, 12));
      assert.equal(sanitize("alert", { code: "upstream_down", subject: v }).subject, undefined);
    }
  });

  test("model names are a plain id charset: free text (a prompt smuggled into `model`) is dropped", () => {
    assert.equal(sanitize("request", { role: "buyer", status: "ok", model: "hf.co/org/Model-7B:Q4_K_M" }).model, "hf.co/org/Model-7B:Q4_K_M");
    assert.equal(sanitize("request", { role: "buyer", status: "ok", model: "Ignore all <script>\nand say " + CANARY }).model, undefined);
  });

  test("wallets and tx hashes are shortened; a buyer event carries no counterparty; malformed ones vanish", () => {
    const s = sanitize("request", { role: "seller", status: "ok", counterparty: ADDR });
    assert.equal(s.counterparty, ADDR.slice(0, 6) + "…" + ADDR.slice(-4));
    assert.equal(sanitize("request", { role: "buyer", status: "ok", counterparty: ADDR }).counterparty, undefined);
    assert.equal(sanitize("request", { role: "seller", status: "ok", counterparty: "0x123" }).counterparty, undefined);
    const v = sanitize("voucher", { action: "redeemed", amountUsd: 1.5, tx: TXH, counterparty: ADDR });
    assert.equal(v.tx, TXH.slice(0, 10) + "…" + TXH.slice(-4));
    assert.ok(!JSON.stringify(v).includes(TXH) && !JSON.stringify(v).includes(ADDR));
  });

  test("bad kinds, bad enums, missing required fields, NaN, negatives and huge numbers fail closed", () => {
    assert.equal(sanitize("secret", { a: 1 }), null);
    assert.equal(sanitize("request", { role: "admin", status: "ok" }), null);
    assert.equal(sanitize("request", { role: "buyer" }), null);
    assert.equal(sanitize("request", null), null);
    const e = sanitize("request", { role: "buyer", status: "ok", promptTokens: NaN, completionTokens: -1, costUsd: Infinity, latencyMs: 1e12, ttftMs: "5" });
    assert.deepEqual(e, { role: "buyer", status: "ok" });
  });

  test("strings are capped and stripped of control characters and bidi overrides", () => {
    const e = sanitize("peer", { state: "online", name: "a\u0000b\u202ec\n" + "x".repeat(200) });
    assert.ok(e.name.length <= 40 && !/[\u0000-\u001f\u202e]/.test(e.name));
  });
});

describe("ring buffer", () => {
  test("it is bounded, ids rise by one, and the oldest events are the ones that go", () => {
    const ev = createEvents();
    for (let i = 0; i < RING_MAX + 150; i++) ev.peer({ state: "online", name: "p" + i });
    const r = ev.recent();
    assert.equal(r.length, RING_MAX);
    assert.equal(r[0].id, 151); assert.equal(r.at(-1).id, RING_MAX + 150);
    assert.ok(r.every((e, i) => i === 0 || e.id === r[i - 1].id + 1));
    assert.equal(ev.lastId(), RING_MAX + 150);
  });

  test("since(id) returns only newer events; an id from before a restart replays the ring", () => {
    const ev = createEvents({ max: 10 });
    for (let i = 0; i < 6; i++) ev.peer({ state: "offline", name: "p" + i });
    assert.deepEqual(ev.since(4).map((e) => e.id), [5, 6]);
    assert.deepEqual(ev.since(6), []);
    assert.equal(ev.since(999).length, 6, "stale id after a restart: send what we have");
  });

  test("subscribers get new events, unsubscribe stops them, and a throwing listener neither leaks nor blocks the others", () => {
    const ev = createEvents(); const got = [];
    const off = ev.subscribe((e) => got.push(e.id)); ev.subscribe(() => { throw new Error("boom"); }); ev.subscribe((e) => got.push("b" + e.id));
    assert.equal(ev.listenerCount(), 3);
    ev.peer({ state: "online", name: "a" });
    off(); ev.peer({ state: "online", name: "b" });
    assert.deepEqual(got, [1, "b1", "b2"]);
    assert.equal(ev.listenerCount(), 2);
  });

  test("a flapping alert and a spamming stranger are throttled instead of filling the ring", () => {
    const ev = createEvents();
    for (let i = 0; i < 20; i++) ev.alert({ code: "upstream_down", subject: "ollama" });
    for (let i = 0; i < 20; i++) ev.request({ role: "seller", status: "refused", reason: "no_model", peer: "peer abc123", model: "x" });
    ev.request({ role: "seller", status: "ok", peer: "peer abc123", model: "x" });
    assert.deepEqual(ev.recent().map((e) => e.kind + ":" + (e.status ?? e.code)), ["alert:upstream_down", "request:refused", "request:ok"]);
  });

  test("an unsanitisable event is not recorded and never throws into the request path", () => {
    const ev = createEvents();
    assert.equal(ev.emit("request", { role: "nobody" }), null);
    assert.equal(ev.emit("request", { get role() { throw new Error("hostile getter"); } }), null);
    assert.equal(ev.recent().length, 0);
  });
});

describe("a prompt never reaches an event (router level)", () => {
  const out = () => { const o = {}; o.head = () => {}; o.json = (j) => { o.body = j; }; o.write = () => {}; o.end = () => {}; return o; };
  const cand = (kind, name, price) => ({ key: `${kind}:${name}`, kind, peerName: name, peerId: name, model: "m1", price, tee: "none", simulated: false });
  const body = { model: "auto", messages: [{ role: "user", content: CANARY }], max_tokens: 50, api_key: "sk-live-abcdefghijklmnop" };
  const mk = ({ ranked, exec, cap = null }) => {
    const events = createEvents();
    const state = { routes: [], ledger: [], stats: {}, peers: {}, settings: { spendCapUsdDay: cap } };
    const chat = createChat({ state, save() {}, chain: { configured: () => false }, events }, { plan: () => ranked, execLocal: exec, execPeer: exec, wallet: { balance: () => 100 }, record() {} });
    return { events, run: () => chat(body, out(), new AbortController()) };
  };
  const leaked = (events) => JSON.stringify(events.recent()).includes(CANARY) || JSON.stringify(events.recent()).includes("sk-live");

  test("success: one buyer event with metadata only", async () => {
    const { events, run } = mk({ ranked: [cand("self", "SELF - ollama", 0)], exec: async () => ({ json: { choices: [{ message: { content: CANARY } }] }, usage: Promise.resolve({ p: 8, c: 100 }) }) });
    await run();
    const [e] = events.recent();
    assert.equal(events.recent().length, 1);
    assert.deepEqual([e.kind, e.role, e.status, e.model, e.peer, e.promptTokens, e.completionTokens, e.costUsd], ["request", "buyer", "ok", "m1", "SELF - ollama", 8, 100, 0]);
    assert.ok(!leaked(events));
  });

  test("failure whose error message echoes the prompt, and a refused spend cap: still nothing leaks", async () => {
    const bad = mk({ ranked: [cand("peer", "seller-1", 0)], exec: async () => { throw new Error("upstream said: " + CANARY); } });
    await assert.rejects(bad.run());
    assert.equal(bad.events.recent().at(0).status, "error");
    assert.ok(!leaked(bad.events));
    const capped = mk({ ranked: [cand("peer", "seller-1", 10)], cap: 0, exec: async () => { throw new Error("must not be called"); } });
    await assert.rejects(capped.run(), (e) => e.type === "spend_cap_reached");
    assert.deepEqual(capped.events.recent().map((e) => e.kind + ":" + (e.code ?? e.status)), ["alert:spend_cap", "request:refused"]);
    assert.ok(!leaked(capped.events));
  });
});

/** a fake ServerResponse/IncomingMessage pair: enough to drive the stream handler without sockets */
const fake = (headers = {}) => {
  const req = Object.assign(new EventEmitter(), { headers, method: "GET" });
  const res = Object.assign(new EventEmitter(), { chunks: [], head: null, writableEnded: false, writableLength: 0, destroyed: false });
  res.writeHead = (s, h) => { res.head = { s, h }; };
  res.write = (c) => { res.chunks.push(c); return true; };
  res.end = () => { res.writableEnded = true; };
  res.destroy = () => { res.destroyed = true; res.emit("close"); };
  return { req, res, text: () => res.chunks.join("") };
};

describe("stream handler (in process)", () => {
  test("replays from Last-Event-ID or ?since, otherwise only live; heartbeats; closing removes the listener", async () => {
    const events = createEvents();
    for (let i = 0; i < 5; i++) events.peer({ state: "online", name: "p" + i });
    const feed = createEventsRoutes({ events }, { heartbeatMs: 20 });
    const live = fake(); feed.stream(live.req, live.res, new URLSearchParams());
    assert.equal(live.res.head.s, 200); assert.match(live.res.head.h["content-type"], /text\/event-stream/);
    assert.ok(!live.text().includes("data:"), "no replay without a resume point");
    const resumed = fake({ "last-event-id": "3" }); feed.stream(resumed.req, resumed.res, new URLSearchParams());
    assert.deepEqual([...resumed.text().matchAll(/^id: (\d+)$/gm)].map((m) => +m[1]), [4, 5]);
    const bySince = fake(); feed.stream(bySince.req, bySince.res, new URLSearchParams("since=0"));
    assert.equal([...bySince.text().matchAll(/^id: /gm)].length, 5);
    assert.equal(events.listenerCount(), 3);

    events.alert({ code: "low_gas" });
    assert.match(live.text(), /"kind":"alert"/);
    await sleep(70);
    assert.match(live.text(), /^: ping$/m, "heartbeat comments keep the connection open");

    for (const c of [live, resumed]) c.res.emit("close");
    assert.equal(events.listenerCount(), 1);
    bySince.res.emit("error", new Error("reset")); bySince.res.emit("close");
    assert.equal(events.listenerCount(), 0, "no listener left behind");
    assert.equal(feed.openStreams(), 0);
    const before = live.res.chunks.length; events.alert({ code: "spend_cap", subject: "x" }); await sleep(50);
    assert.equal(live.res.chunks.length, before, "nothing is written to a closed stream, no timers left running");
  });

  test("the per-node connection limit refuses with 429 and frees the slot on close", () => {
    const events = createEvents();
    const feed = createEventsRoutes({ events }, { maxStreams: 2 });
    const a = fake(), b = fake(), c = fake();
    feed.stream(a.req, a.res, new URLSearchParams()); feed.stream(b.req, b.res, new URLSearchParams());
    assert.throws(() => feed.stream(c.req, c.res, new URLSearchParams()), (e) => e.status === 429);
    a.res.emit("close");
    feed.stream(c.req, c.res, new URLSearchParams());
    assert.equal(events.listenerCount(), 2);
    b.res.emit("close"); c.res.emit("close");
    assert.equal(events.listenerCount(), 0);
  });

  test("a client that stops reading is dropped instead of buffered without bound", () => {
    const events = createEvents(); const feed = createEventsRoutes({ events });
    const s = fake(); feed.stream(s.req, s.res, new URLSearchParams());
    s.res.writableLength = 5 << 20; events.alert({ code: "low_gas" });
    assert.ok(s.res.destroyed); assert.equal(events.listenerCount(), 0);
  });

  test("the stream ends by itself after its maximum age (so the session is checked again on reconnect)", async () => {
    const events = createEvents(); const feed = createEventsRoutes({ events }, { maxAgeMs: 30 });
    const s = fake(); feed.stream(s.req, s.res, new URLSearchParams());
    await sleep(80);
    assert.ok(s.res.writableEnded); assert.equal(events.listenerCount(), 0);
  });
});

// ---- real nodes over HTTP ----
const call = (port, { method = "GET", path = "/", host = `localhost:${port}`, headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, method, path, headers: { host, ...headers } }, (res) => {
    let data = ""; res.setEncoding("utf8"); res.on("data", (c) => (data += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
  });
  req.on("error", reject); if (body) req.write(body); req.end();
});
/** open an SSE stream; resolves once headers arrive. `text()` is everything received so far, `close()` hangs up. */
const sse = (port, { path = "/api/events", host = `localhost:${port}`, headers = {} } = {}) => new Promise((resolve, reject) => {
  let data = "";
  const req = request({ host: "127.0.0.1", port, path, headers: { host, ...headers } }, (res) => {
    res.setEncoding("utf8"); res.on("data", (c) => (data += c)); res.on("error", () => {});
    if (res.statusCode !== 200) res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: () => data, close() {} }));
    else resolve({ status: 200, headers: res.headers, text: () => data, close: () => req.destroy(), events: () => [...data.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1])) });
  });
  req.on("error", (e) => { if (e.code !== "ECONNRESET") reject(e); }); req.end();
});

describe("two real nodes: the feed over HTTP", () => {
  const procs = [], dirs = [];
  const A = 18981, B = 18982, STUB = 18983;
  const boot = async (port, name, extra = [], env = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "vpr-ev-")); dirs.push(dir);
    const p = spawn(process.execPath, [server, "--port", String(port), "--data", dir, "--name", name, "--no-demo", ...extra], { env: { ...process.env, ...env }, stdio: "pipe" });
    procs.push(p);
    for (let i = 0; i < 300; i++) { try { if ((await fetch(`http://localhost:${port}/p2p/hello`)).ok) return; } catch { /* booting */ } await sleep(100); }
    throw new Error("node did not start");
  };
  const aj = async (port, p, method = "GET", body) => (await fetch(`http://localhost:${port}${p}`, { method, headers: J, body: body && JSON.stringify(body) })).json();
  const chat = (content = "ping") => fetch(`http://localhost:${A}/v1/chat/completions`, { method: "POST", headers: J, body: JSON.stringify({ model: "stub-1", messages: [{ role: "user", content }] }) });
  const stub = createServer((req, res) => {
    if (req.url.endsWith("/models")) return res.setHeader("content-type", "application/json"), res.end(JSON.stringify({ data: [{ id: "stub-1" }] }));
    req.resume(); req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "stub-1", choices: [{ index: 0, message: { role: "assistant", content: "pong " + CANARY + "-reply" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 } }));
    });
  });

  before(async () => {
    await new Promise((r) => stub.listen(STUB, r));
    await boot(A, "consumer"); await boot(B, "provider");
    const up = await aj(B, "/api/upstreams", "POST", { name: "stub", baseUrl: `http://localhost:${STUB}/v1` });
    await aj(B, "/api/provide", "PUT", { enabled: true, upstreamId: up.id, price: 2, tee: "claimed" });
  });
  after(() => { stub.close(); procs.forEach((p) => p.kill()); setTimeout(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })), 400); });

  test("SSE and /recent need the local surface: another Host or a cross-site Origin gets 403, never a stream", async () => {
    for (const path of ["/api/events", "/api/events/recent"]) {
      assert.equal((await call(A, { path, host: "evil.example" })).status, 403, path + " via a foreign Host");
      assert.equal((await call(A, { path, headers: { origin: "https://evil.example" } })).status, 403, path + " cross-site");
      assert.equal((await call(A, { path, headers: { "x-forwarded-for": "203.0.113.9" }, host: "evil.example" })).status, 403);
    }
    assert.equal((await call(A, { path: "/api/events/recent" })).status, 200);
  });

  test("discovering a peer is a `peer` event; a request through it gives a buyer event here and a seller event there, with metadata only", async () => {
    const live = await sse(A);
    assert.equal(live.status, 200); assert.match(live.headers["content-type"], /text\/event-stream/); assert.equal(live.headers["cache-control"], "no-store, no-transform");
    await aj(A, "/api/peers", "POST", { url: `http://localhost:${B}` });
    const secret = "API-KEY-sk-live-abcdefghijklmnop";
    const r = await chat(CANARY + " " + secret);
    assert.equal(r.status, 200);
    assert.ok((await r.text()).includes(CANARY), "the answer itself reaches the caller untouched");
    await until(() => live.events().some((e) => e.kind === "request"), 8000, "buyer request event");
    const evs = live.events();
    assert.ok(evs.some((e) => e.kind === "peer" && e.state === "discovered" && e.name === "provider"), "peer discovered");
    const buy = evs.find((e) => e.kind === "request");
    assert.deepEqual([buy.role, buy.status, buy.model, buy.peer, buy.promptTokens, buy.completionTokens, buy.simulated], ["buyer", "ok", "stub-1", "provider", 7, 11, false]);
    assert.ok(Math.abs(buy.costUsd - (18 * 2) / 1e6) < 1e-12 && buy.latencyMs >= 0 && buy.ttftMs >= 0);
    assert.ok(typeof buy.id === "number" && typeof buy.ts === "number");
    const sell = await until(async () => (await aj(B, "/api/events/recent")).events.find((e) => e.kind === "request"), 8000, "seller request event");
    assert.deepEqual([sell.role, sell.status, sell.model, sell.promptTokens, sell.completionTokens], ["seller", "ok", "stub-1", 7, 11]);
    assert.ok(/^peer [0-9a-f]{6}$/.test(sell.peer));
    const all = live.text() + JSON.stringify(await aj(A, "/api/events/recent")) + JSON.stringify(await aj(B, "/api/events/recent"));
    for (const bad of [CANARY, secret, "sk-live"]) assert.ok(!all.includes(bad), `"${bad}" must not appear in any event on either node`);
    live.close();
  });

  test("a refused request (model nobody serves) is an event with a reason and no model text from the prompt", async () => {
    const r = await fetch(`http://localhost:${A}/v1/chat/completions`, { method: "POST", headers: J, body: JSON.stringify({ model: "no-such-model-" + CANARY + " free text with spaces", messages: [{ role: "user", content: "x" }] }) });
    assert.equal(r.status, 404);
    const ev = (await aj(A, "/api/events/recent")).events.findLast((e) => e.status === "refused");
    assert.equal(ev.reason, "no_route");
    assert.ok(!JSON.stringify(ev).includes("free text"), JSON.stringify(ev));
  });

  test("Last-Event-ID and ?since resume from the ring; /recent is the same ring, oldest first", async () => {
    const rec = await aj(A, "/api/events/recent");
    assert.ok(rec.events.length >= 2 && rec.events.length <= 200); assert.equal(rec.lastId, rec.events.at(-1).id);
    assert.ok(rec.events.every((e, i) => i === 0 || e.id > rec.events[i - 1].id));
    const first = rec.events[0].id;
    const resumed = await sse(A, { headers: { "last-event-id": String(first) } });
    await until(() => resumed.events().length >= rec.events.length - 1, 4000, "replay");
    assert.deepEqual(resumed.events().map((e) => e.id), rec.events.slice(1).map((e) => e.id));
    assert.match(resumed.text(), new RegExp(`^id: ${rec.events[1].id}$`, "m"));
    resumed.close();
    const bySince = await sse(A, { path: "/api/events?since=0" });
    await until(() => bySince.events().length >= rec.events.length, 4000, "full replay");
    bySince.close();
    const liveOnly = await sse(A); await sleep(150);
    assert.equal(liveOnly.events().length, 0, "a plain connection gets only what happens next");
    liveOnly.close();
    const bad = await sse(A, { headers: { "last-event-id": "not-a-number" } }); await sleep(150);
    assert.equal(bad.status, 200); assert.equal(bad.events().length, 0, "garbage resume id = live only, never an error");
    bad.close();
  });

  test("connections are capped, and hanging up frees the slot (no leak)", async () => {
    await sleep(300); // earlier tests' streams are still being torn down server-side
    const held = [];
    for (let i = 0; i < 8; i++) { const s = await sse(A); assert.equal(s.status, 200, "stream " + i); held.push(s); }
    const ninth = await sse(A); assert.equal(ninth.status, 429);
    held.forEach((s) => s.close());
    await until(async () => { const s = await sse(A); s.close(); return s.status === 200; }, 4000, "slot freed after hang-up");
    await sleep(300);
    const again = [];
    for (let i = 0; i < 8; i++) { const s = await sse(A); assert.equal(s.status, 200, "all 8 slots are free again: " + i); again.push(s); }
    again.forEach((s) => s.close());
  });

  test("non-GET methods on the stream path never open a stream", async () => {
    const r = await call(A, { method: "POST", path: "/api/events", headers: J, body: "{}" });
    assert.equal(r.status, 404);
  });
});

describe("the feed behind remote admin", () => {
  const P = 18984, ADMIN = "admin.elyra.test", TOKEN = "t".repeat(8) + "correct-horse-battery-staple-123";
  let n;
  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "vpr-ev2-"));
    const p = spawn(process.execPath, [server, "--port", String(P), "--data", dir, "--no-demo"], { env: { ...process.env, ELYRA_ADMIN_HOST: ADMIN, ELYRA_ADMIN_TOKEN: TOKEN }, stdio: "pipe" });
    n = { p, dir };
    for (let i = 0; i < 300; i++) { try { if ((await call(P, { path: "/healthz" })).status === 200) return; } catch { /* booting */ } await sleep(100); }
    throw new Error("node did not start");
  });
  after(async () => { const done = new Promise((r) => n.p.once("exit", r)); n.p.kill(); await done; rmSync(n.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const login = async () => String((await call(P, { method: "POST", path: "/admin/login", host: ADMIN, headers: { "content-type": "application/x-www-form-urlencoded" }, body: "token=" + encodeURIComponent(TOKEN) })).headers["set-cookie"]).split(";")[0];

  test("no session = 401 and no stream, on both routes", async () => {
    for (const path of ["/api/events", "/api/events/recent"]) {
      const r = await sse(P, { path, host: ADMIN });
      assert.equal(r.status, 401, path);
      assert.ok(!r.text().includes("data:"));
    }
  });

  test("a forged, tampered or foreign-host cookie never opens the stream", async () => {
    const c = await login(); const [name, val] = c.split("="); const parts = val.split(".");
    const tampered = `${name}=${parts.slice(0, -1).join(".")}.${parts.at(-1).slice(0, -2)}xx`;
    assert.equal((await sse(P, { host: ADMIN, headers: { cookie: tampered } })).status, 401);
    assert.equal((await sse(P, { host: ADMIN, headers: { cookie: `${name}=v1.${Date.now() + 1e9}.${"A".repeat(43)}` } })).status, 401);
    assert.equal((await sse(P, { host: "evil.example", headers: { cookie: c } })).status, 403, "session cookie replayed on another host");
    assert.equal((await sse(P, { host: `localhost:${P}`, headers: { "cf-connecting-ip": "203.0.113.9" } })).status, 403, "proxied traffic never gets the localhost path");
  });

  test("an admin session streams; the token is not in the stream; writes by the owner show up", async () => {
    const c = await login();
    const live = await sse(P, { host: ADMIN, headers: { cookie: c } });
    assert.equal(live.status, 200); assert.match(live.headers["content-type"], /text\/event-stream/); assert.equal(live.headers["cache-control"], "no-store, no-transform");
    const rec = await call(P, { path: "/api/events/recent", host: ADMIN, headers: { cookie: c } });
    assert.equal(rec.status, 200); assert.ok(!rec.body.includes(TOKEN));
    assert.ok(Array.isArray(JSON.parse(rec.body).events));
    live.close();
  });
});
