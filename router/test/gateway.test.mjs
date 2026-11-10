// The wallet-account gateway (ELYRA_GATEWAY=1) through the whole app (admin host + public surface), as a browser would use it.
// There is ONE sign-in system (SIWE: /auth/nonce, /auth/verify, /auth/session, /auth/logout, cookie `elyra_admin`); the gateway adds the username profile
// (GET/PUT /auth/username) and the chat gate (sign in + a name) on top. Run: node --test router/test/gateway.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { Wallet } from "ethers";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADMIN = "admin.elyra.test", TOKEN = "t".repeat(30), ON = 19510, OFF = 19511, STUB = 19512;
const dirs = [], procs = [];
const call = (port, host, method, path, { body, headers = {} } = {}) => new Promise((resolve) => {
  const r = http.request({ host: "127.0.0.1", port, method, path, headers: { host, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers } }, (x) => { let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => resolve({ s: x.statusCode, h: x.headers, b: d, j: (() => { try { return JSON.parse(d); } catch { return null; } })() })); });
  r.on("error", () => resolve({ s: 0, h: {}, b: "" })); if (body !== undefined) r.write(typeof body === "string" ? body : JSON.stringify(body)); r.end();
});
const boot = async (port, env) => {
  const dir = mkdtempSync(join(tmpdir(), "vpr-gw-")); dirs.push(dir);
  const p = spawn(process.execPath, [server, "--port", String(port), "--data", dir, "--name", "gw", "--no-demo"], { env: { ...process.env, ELYRA_ADMIN_HOST: ADMIN, ELYRA_ADMIN_TOKEN: TOKEN, ELYRA_ADMIN_ADDRESSES: "", ELYRA_PUBLIC_TRY: "1", ELYRA_TRY_MODEL: "", ELYRA_GATEWAY: "", ...env }, stdio: "pipe" }); procs.push(p);
  for (let i = 0; i < 80; i++) { if ((await call(port, "localhost", "GET", "/p2p/hello")).s === 200) return; await sleep(250); }
  throw new Error("node did not start");
};
const stub = http.createServer((q, r) => {
  if (q.url.endsWith("/models")) { r.setHeader("content-type", "application/json"); return r.end(JSON.stringify({ data: [{ id: "stub-1" }] })); }
  q.resume(); q.on("end", () => { r.writeHead(200, { "content-type": "text/event-stream" }); r.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`); r.end("data: [DONE]\n\n"); });
});
before(async () => {
  await new Promise((r) => stub.listen(STUB, r));
  await boot(ON, { ELYRA_GATEWAY: "1" }); await boot(OFF, {});
  assert.equal((await call(ON, "localhost", "POST", "/api/upstreams", { body: { name: "stub", baseUrl: `http://127.0.0.1:${STUB}/v1` } })).s, 200);
  for (let i = 0; i < 40; i++) { if ((await call(ON, ADMIN, "GET", "/pub/info")).j?.live) break; await sleep(250); }
});
after(() => { stub.close(); procs.forEach((p) => p.kill()); setTimeout(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })), 500); });

let ipN = 20; const freshIp = () => `198.51.100.${ipN++}`; // each test is its own client: the sign-in limits are per client
const nonce = (w, host = ADMIN, port = ON, ip = freshIp()) => call(port, host, "GET", `/auth/nonce?address=${w.address}`, { headers: { "cf-connecting-ip": ip } });
const signin = async (w, over = {}) => { const ip = freshIp(), n = (await nonce(w, ADMIN, ON, ip)).j; const message = over.message ?? n.message; return call(ON, ADMIN, "POST", "/auth/verify", { body: { message, signature: await w.signMessage(message) }, headers: { "cf-connecting-ip": ip, ...over.headers } }); };
const cookieOf = (r) => String([].concat(r.h["set-cookie"] ?? "")[0] ?? "").split(";")[0];
const chat = (cookie) => call(ON, ADMIN, "POST", "/pub/chat", { body: { messages: [{ role: "user", content: "hi" }] }, headers: cookie ? { cookie } : {} });
const session = (cookie) => call(ON, ADMIN, "GET", "/auth/session", { headers: cookie ? { cookie } : {} });
const putName = (cookie, username) => call(ON, ADMIN, "PUT", "/auth/username", { body: { username }, headers: { cookie } });

describe("gateway off", () => {
  test("the username routes are a plain 404 and chat needs nothing; sign-in itself stays (it is the public page's quota tier)", async () => {
    for (const p of ["/auth/username?name=abc"]) assert.equal((await call(OFF, ADMIN, "GET", p)).s, 404, p);
    assert.equal((await call(OFF, ADMIN, "PUT", "/auth/username", { body: { username: "abcdef" } })).s, 404);
    assert.equal((await call(OFF, ADMIN, "GET", "/pub/info")).j.gateway, false);
    assert.equal((await call(OFF, ADMIN, "GET", "/auth/session")).j.signedIn, false);
    const r = await call(OFF, ADMIN, "POST", "/pub/chat", { body: { messages: [{ role: "user", content: "hi" }] } }); assert.notEqual(r.s, 401, "no sign-in needed to chat with the gateway off");
  });
});

describe("gateway on: connect, sign, name, chat", () => {
  const w = Wallet.createRandom(); let cookie = "";
  test("the page learns the gateway is on; chat is refused before sign-in", async () => {
    assert.equal((await call(ON, ADMIN, "GET", "/pub/info")).j.gateway, true);
    const r = await chat(""); assert.equal(r.s, 401); assert.equal(r.j.error.type, "signin_required");
    assert.deepEqual((await session("")).j, { signedIn: false });
  });
  test("a signed message opens a session: ONE cookie (elyra_admin), HttpOnly, SameSite=Strict, Secure; the token is only in the cookie", async () => {
    const r = await signin(w); assert.equal(r.s, 200, r.b); assert.equal(r.j.needsName, true); assert.equal(r.j.username, null); assert.equal(r.j.role, "user"); cookie = cookieOf(r);
    assert.match(cookie, /^elyra_admin=v2\./); assert.equal([].concat(r.h["set-cookie"]).length, 1, "one cookie family");
    const sc = [].concat(r.h["set-cookie"]).join("; "); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Secure/); assert.match(sc, /Max-Age=\d+/);
    assert.equal(r.h["cache-control"], "no-store"); assert.equal(JSON.stringify(r.j).includes(cookie.split("=")[1]), false);
    const s = (await session(cookie)).j; assert.equal(s.signedIn, true); assert.equal(s.address.toLowerCase(), w.address.toLowerCase()); assert.equal(s.needsName, true);
  });
  test("signed in but no name yet: chat says so (403), names are checked live, then chat works", async () => {
    let r = await chat(cookie); assert.equal(r.s, 403); assert.equal(r.j.error.type, "profile_required");
    assert.deepEqual((await call(ON, ADMIN, "GET", "/auth/username?name=admin")).j.available, false);
    assert.deepEqual((await call(ON, ADMIN, "GET", "/auth/username?name=nice_name")).j, { name: "nice_name", valid: true, available: true, reason: "" });
    r = await putName(cookie, "bad name!"); assert.equal(r.s, 400);
    r = await putName(cookie, "Nice_Name"); assert.equal(r.s, 200); assert.equal(r.j.username, "nice_name"); assert.equal(r.j.needsName, false);
    assert.equal((await putName(cookie, "other_name")).s, 409, "no renaming");
    assert.equal((await session(cookie)).j.username, "nice_name");
    r = await chat(cookie); assert.equal(r.s, 200, r.b); assert.match(r.b, /hello/);
  });
  test("a returning wallet is recognised with its name; a second wallet cannot take the name (case-insensitive)", async () => {
    const again = await signin(w); assert.equal(again.j.username, "nice_name"); assert.equal(again.j.needsName, false);
    const w2 = Wallet.createRandom(); const c2 = cookieOf(await signin(w2));
    assert.equal((await putName(c2, "NICE_NAME")).s, 409);
    assert.equal((await call(ON, ADMIN, "PUT", "/auth/username", { body: { username: "no_session" } })).s, 401, "setting a name needs a wallet session");
  });
  test("sign-out ends the session on the server: the old cookie is dead even if somebody kept a copy", async () => {
    const c = cookieOf(await signin(Wallet.createRandom()));
    assert.equal((await session(c)).j.signedIn, true);
    const out = await call(ON, ADMIN, "POST", "/auth/logout", { body: {}, headers: { cookie: c } }); assert.equal(out.s, 200); assert.match([].concat(out.h["set-cookie"]).join(";"), /Max-Age=0/);
    assert.equal((await session(c)).j.signedIn, false, "the copied cookie no longer works");
    assert.equal((await putName(c, "late_name")).s, 401);
  });
  test("a wallet user is known but never reaches the control surface; the admin token session is not chat-gated", async () => {
    for (const p of ["/api/status", "/v1/models", "/api/events"]) assert.equal((await call(ON, ADMIN, "GET", p, { headers: { cookie } })).s, 403, p);
    const login = await call(ON, ADMIN, "POST", "/admin/login", { body: { token: TOKEN } }); assert.equal(login.s, 303); const admin = cookieOf(login);
    assert.equal((await chat(admin)).s, 200, "the node's own admin is not gated by the account rules");
  });
});

describe("gateway on: abuse", () => {
  test("a text written for another domain is refused; a replayed message is refused; a failed attempt burns the nonce", async () => {
    const w = Wallet.createRandom(); const n = (await nonce(w)).j;
    const evil = n.message.replace(ADMIN + " wants", "evil.example wants").replace("URI: https://" + ADMIN, "URI: https://evil.example");
    let r = await call(ON, ADMIN, "POST", "/auth/verify", { body: { message: evil, signature: await w.signMessage(evil) } }); assert.equal(r.s, 401);
    const w2 = Wallet.createRandom(); const n2 = (await nonce(w2)).j, sig = await w2.signMessage(n2.message);
    assert.equal((await call(ON, ADMIN, "POST", "/auth/verify", { body: { message: n2.message, signature: sig } })).s, 200);
    assert.equal((await call(ON, ADMIN, "POST", "/auth/verify", { body: { message: n2.message, signature: sig } })).s, 401, "replay");
    const w3 = Wallet.createRandom(), liar = Wallet.createRandom(); const n3 = (await nonce(w3)).j;
    assert.equal((await call(ON, ADMIN, "POST", "/auth/verify", { body: { message: n3.message, signature: await liar.signMessage(n3.message) } })).s, 401, "wrong signer");
    assert.equal((await call(ON, ADMIN, "POST", "/auth/verify", { body: { message: n3.message, signature: await w3.signMessage(n3.message) } })).s, 401, "burned by the failed attempt");
  });
  test("cross-site writes are refused; so is a wrong content type; a wrong Host never gets a sign-in text", async () => {
    const w = Wallet.createRandom(); const n = (await nonce(w)).j, sig = await w.signMessage(n.message);
    assert.equal((await call(ON, ADMIN, "POST", "/auth/verify", { body: { message: n.message, signature: sig }, headers: { origin: "https://evil.example" } })).s, 403);
    assert.equal((await call(ON, ADMIN, "POST", "/auth/verify", { body: { message: n.message, signature: sig }, headers: { "sec-fetch-site": "cross-site" } })).s, 403);
    assert.equal((await call(ON, ADMIN, "POST", "/auth/verify", { body: "x=1", headers: { "content-type": "text/plain" } })).s, 415);
    assert.equal((await call(ON, ADMIN, "PUT", "/auth/username", { body: { username: "csrf_name" }, headers: { origin: "https://evil.example", cookie: cookieOf(await signin(w)) } })).s, 403);
    const r = await nonce(w, "other.example"); assert.ok(r.s !== 200, "wrong host: " + r.s);
  });
  test("garbage in: odd bodies, addresses and names never cause a 5xx", async () => {
    for (const body of ["{", "null", "[]", '{"message":5}', JSON.stringify({ message: "x".repeat(9000) })]) { const r = await call(ON, ADMIN, "POST", "/auth/verify", { body }); assert.ok(r.s >= 400 && r.s < 500, `${body.slice(0, 20)} -> ${r.s} ${r.b.slice(0, 120)}`); }
    for (const a of ["", "0x1", "../../x", "%00", "0x" + "z".repeat(40)]) assert.equal((await call(ON, ADMIN, "GET", "/auth/nonce?address=" + encodeURIComponent(a), { headers: { "cf-connecting-ip": freshIp() } })).s, 400);
    for (const m of ["PUT", "DELETE", "PATCH"]) { const s = (await call(ON, ADMIN, m, "/auth/nonce", { body: {} })).s; assert.ok(s >= 400 && s < 500, `${m} -> ${s}`); }
    const c = cookieOf(await signin(Wallet.createRandom()));
    for (const name of ["", "  ", "x", "a".repeat(500), "😀😀😀", "../../etc", null, 5, {}, []]) { const r = await putName(c, name); assert.ok(r.s >= 400 && r.s < 500, `${JSON.stringify(name)} -> ${r.s}`); }
  });
  test("per-client limits: the 21st nonce request in a minute gets 429, and a client that was limited does not affect another", async () => {
    const w = Wallet.createRandom(); let last = 0; const ip = "203.0.113.77";
    for (let i = 0; i < 30; i++) { last = (await call(ON, ADMIN, "GET", `/auth/nonce?address=${w.address}`, { headers: { "cf-connecting-ip": ip } })).s; if (last === 429) { assert.ok(i >= 20, "limit hit too early at " + i); assert.equal((await nonce(w)).s, 200, "another client is unaffected"); return; } }
    assert.fail("never limited, last status " + last);
  });
  test("name checks and name writes are rate limited per client", async () => {
    const ip = "203.0.113.88"; let limited = 0;
    for (let i = 0; i < 70; i++) { const r = await call(ON, ADMIN, "GET", "/auth/username?name=probe_" + i, { headers: { "cf-connecting-ip": ip } }); if (r.s === 429) limited++; else assert.equal(r.s, 200); }
    assert.ok(limited >= 5, "limited " + limited);
  });
});
