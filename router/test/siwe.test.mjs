// Wallet sign-in (SIWE, EIP-4361) on the admin host: nonce/replay/domain binding, roles, cookie forgery, CSRF, rate limits, and that a
// wallet "user" session can never reach /api, /v1, /metrics or the live feed. Run: node --test router/test/siwe.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { Wallet } from "ethers";
import { buildMessage, createSiwe, parseAdminAddresses } from "../http/siwe.mjs";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
const ADMIN = "admin.elyra.test";
const TOKEN = "s".repeat(10) + "correct-horse-battery-staple-7";
const J = { "content-type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (port, { method = "GET", path = "/", host = ADMIN, headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, method, path, headers: { host, ...headers } }, (res) => {
    let data = ""; res.setEncoding("utf8"); res.on("data", (c) => (data += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
  });
  req.on("error", reject); if (body) req.write(body); req.end();
});
const boot = async (port, env, { upstream = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "vpr-siwe-"));
  const p = spawn(process.execPath, [server, "--port", String(port), "--data", dir, "--no-demo"], { env: { ...process.env, ELYRA_ADMIN_HOST: "", ELYRA_ADMIN_TOKEN: "", ELYRA_ADMIN_ADDRESSES: "", ELYRA_PUBLIC_TRY: "", ...env }, stdio: "pipe" });
  for (let i = 0; i < 300; i++) { try { if ((await call(port, { path: "/healthz", host: `localhost:${port}` })).status === 200) break; } catch { /* booting */ } await sleep(100); }
  if (upstream) { const r = await call(port, { method: "POST", path: "/api/upstreams", host: `localhost:${port}`, headers: J, body: JSON.stringify({ name: "stub", baseUrl: "http://localhost:18985/v1" }) }); assert.equal(r.status, 200, r.body); }
  return { p, dir };
};
const stop = async (n) => { if (n.p.exitCode === null) { const d = new Promise((r) => n.p.once("exit", r)); n.p.kill(); await d; } rmSync(n.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); };

const stub = createServer((req, res) => {
  if (req.url.endsWith("/models")) return res.setHeader("content-type", "application/json"), res.end(JSON.stringify({ data: [{ id: "stub-1" }] }));
  req.resume(); req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\n`); res.end("data: [DONE]\n\n");
  });
});

let ipN = 10; const freshIp = () => `198.51.100.${ipN++}`;
const cookieOf = (r) => String(r.headers["set-cookie"] ?? "").split(";")[0];
const hdr = (ip, extra = {}) => ({ "cf-connecting-ip": ip, ...extra });
const nonce = (port, address, { ip = freshIp(), host = ADMIN, headers = {} } = {}) => call(port, { path: "/auth/nonce?address=" + address, host, headers: hdr(ip, headers) });
const verify = (port, body, { ip = freshIp(), host = ADMIN, headers = {} } = {}) => call(port, { method: "POST", path: "/auth/verify", host, headers: hdr(ip, { ...J, ...headers }), body: typeof body === "string" ? body : JSON.stringify(body) });
/** the whole flow with a real ethers wallet; returns the verify response and the pieces */
async function signIn(port, wallet, { ip = freshIp() } = {}) {
  const n = JSON.parse((await nonce(port, wallet.address, { ip })).body);
  const signature = await wallet.signMessage(n.message);
  const r = await verify(port, { address: wallet.address, message: n.message, signature }, { ip });
  return { r, n, signature, ip, cookie: cookieOf(r), json: r.status === 200 ? JSON.parse(r.body) : null };
}

const admin1 = Wallet.createRandom(), admin2 = Wallet.createRandom(), visitor = Wallet.createRandom(), other = Wallet.createRandom();
const ADDRS = ` 0x${admin1.address.slice(2).toUpperCase()} , ${admin2.address.toLowerCase()}, not-an-address `; // case-insensitive allow-list; junk is ignored

describe("wallet sign-in: token + admin addresses + public page", () => {
  let n; const P = 18981;
  before(async () => { stub.listen(18985); n = await boot(P, { ELYRA_ADMIN_HOST: ADMIN, ELYRA_ADMIN_TOKEN: TOKEN, ELYRA_ADMIN_ADDRESSES: ADDRS, ELYRA_PUBLIC_TRY: "1", ELYRA_TRY_PER_IP_HOUR: "2", ELYRA_TRY_WALLET_PER_HOUR: "5" }, { upstream: true }); });
  after(async () => { await stop(n); stub.close(); });

  test("/auth/nonce returns the exact EIP-4361 message for this host, with a fresh single-use nonce", async () => {
    const a = await nonce(P, visitor.address), b = await nonce(P, visitor.address);
    assert.equal(a.status, 200); assert.equal(a.headers["cache-control"], "no-store");
    const j = JSON.parse(a.body), k = JSON.parse(b.body);
    assert.match(j.nonce, /^[0-9a-f]{32}$/); assert.notEqual(j.nonce, k.nonce);
    assert.equal(j.message.split("\n")[0], `${ADMIN} wants you to sign in with your Ethereum account:`);
    assert.equal(j.message.split("\n")[1], visitor.address, "EIP-55 address");
    for (const line of ["Sign in to Elyra. This does not move funds or approve anything.", `URI: https://${ADMIN}`, "Version: 1", "Chain ID: 46630", `Nonce: ${j.nonce}`]) assert.ok(j.message.includes(line), line);
    const exp = /Expiration Time: (.+)$/.exec(j.message)[1], iat = /Issued At: (.+)\n/.exec(j.message)[1];
    assert.equal(Date.parse(exp) - Date.parse(iat), 300_000, "5 minute lifetime");
    assert.equal(j.expiresAt, Date.parse(exp));
    assert.equal((await nonce(P, "0x123")).status, 400); assert.equal((await call(P, { path: "/auth/nonce" })).status, 400);
    assert.equal((await call(P, { method: "POST", path: "/auth/nonce", headers: J, body: "{}" })).status, 405);
  });

  test("an allow-listed address gets role admin (case-insensitive list); the cookie is hardened and opens the panel, /api and /v1 but never /metrics", async () => {
    for (const w of [admin1, admin2]) {
      const s = await signIn(P, w); assert.equal(s.r.status, 200, s.r.body);
      assert.deepEqual(Object.keys(s.json).sort(), ["address", "expiresAt", "role"]); assert.equal(s.json.role, "admin"); assert.equal(s.json.address, w.address);
      const sc = String(s.r.headers["set-cookie"]); for (const f of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=43200"]) assert.ok(sc.includes(f), f);
      assert.ok(Math.abs(s.json.expiresAt - (Date.now() + 12 * 3600_000)) < 60_000);
      assert.equal((await call(P, { path: "/api/status", headers: { cookie: s.cookie } })).status, 200);
      assert.equal((await call(P, { path: "/v1/models", headers: { cookie: s.cookie } })).status, 200);
      assert.equal((await call(P, { path: "/app/", headers: { cookie: s.cookie } })).status, 200);
      assert.equal((await call(P, { path: "/metrics", headers: { cookie: s.cookie } })).status, 403);
      const ss = JSON.parse((await call(P, { path: "/auth/session", headers: { cookie: s.cookie } })).body);
      assert.deepEqual(ss, { signedIn: true, address: w.address, role: "admin", expiresAt: s.json.expiresAt });
    }
  });

  test("any other address is role user: identity and quota only, 403 on /api, /v1, /metrics, the live feed and every write; the panel is not served", async () => {
    const s = await signIn(P, visitor); assert.equal(s.r.status, 200, s.r.body); assert.equal(s.json.role, "user");
    const h = { cookie: s.cookie, origin: `https://${ADMIN}` };
    for (const path of ["/api/status", "/api/events", "/api/events/recent", "/api/upstreams", "/api/chain", "/v1/models", "/metrics"]) {
      const r = await call(P, { path, headers: h }); assert.equal(r.status, 403, path); assert.doesNotMatch(r.body, /balance|apiKey|privateKey/i, path);
    }
    const w = await call(P, { method: "PUT", path: "/api/policy", headers: { ...h, ...J }, body: JSON.stringify({ maxPrice: 3 }) }); assert.equal(w.status, 403);
    assert.equal((await call(P, { method: "POST", path: "/v1/chat/completions", headers: { ...h, ...J }, body: "{}" })).status, 403);
    const app = await call(P, { path: "/app/", headers: h }); assert.equal(app.status, 302); assert.equal(app.headers.location, "/admin/login");
    const home = await call(P, { path: "/", headers: h }); assert.equal(home.status, 200, "the user sees the public page, not the panel"); assert.match(home.headers["content-security-policy"], /default-src 'none'/);
    assert.deepEqual(JSON.parse((await call(P, { path: "/auth/session", headers: h })).body), { signedIn: true, address: visitor.address, role: "user", expiresAt: s.json.expiresAt });
    // and the same paths without any session are 401 (the feed included)
    for (const path of ["/api/events", "/api/events/recent", "/api/status", "/v1/models"]) assert.equal((await call(P, { path })).status, 401, path);
  });

  test("a nonce is single use: replaying the same signed message is refused, even right after a success", async () => {
    const s = await signIn(P, visitor); assert.equal(s.r.status, 200);
    const again = await verify(P, { address: visitor.address, message: s.n.message, signature: s.signature }); assert.equal(again.status, 401); assert.equal(again.headers["set-cookie"], undefined);
    // a failed attempt burns the nonce too: the correct signature afterwards is refused
    const n2 = JSON.parse((await nonce(P, visitor.address)).body), sig2 = await visitor.signMessage(n2.message);
    assert.equal((await verify(P, { address: visitor.address, message: n2.message, signature: "0x" + "11".repeat(65) })).status, 401);
    assert.equal((await verify(P, { address: visitor.address, message: n2.message, signature: sig2 })).status, 401);
    assert.equal((await verify(P, { address: visitor.address, message: "never issued", signature: sig2 })).status, 401);
  });

  test("cross-host replay: a message for another domain, a changed uri/chain/statement or a request on another Host never signs anyone in", async () => {
    const n1 = JSON.parse((await nonce(P, visitor.address)).body);
    const tweak = (from, to) => { assert.ok(n1.message.includes(from), from); return n1.message.replace(from, to); };
    for (const m of [tweak(ADMIN + " wants", "evil.example wants"), tweak("URI: https://" + ADMIN, "URI: https://evil.example"), tweak("Chain ID: 46630", "Chain ID: 1"), tweak("This does not move funds", "This approves a transfer"), tweak("Expiration Time: ", "Expiration Time: 2999-")]) {
      const nn = JSON.parse((await nonce(P, visitor.address)).body); // fresh live nonce, but swap in the tampered text that carries it
      const text = m.replace(n1.nonce, nn.nonce);
      const r = await verify(P, { address: visitor.address, message: text, signature: await visitor.signMessage(text) });
      assert.equal(r.status, 401, text.split("\n").find((l) => !n1.message.includes(l)) ?? "tampered"); assert.equal(r.headers["set-cookie"], undefined);
    }
    // an attacker site's own message with the right nonce text but a foreign domain, signed by a real key
    const forged = buildMessage({ domain: "evil.example", address: visitor.address, uri: "https://evil.example", chainId: 46630, nonce: n1.nonce, issuedAt: Date.now(), expiresAt: Date.now() + 300_000 });
    assert.equal((await verify(P, { address: visitor.address, message: forged, signature: await visitor.signMessage(forged) })).status, 401);
    // wallet sign-in does not exist on any other host (it is the SIWE domain); no cookie either
    const n3 = JSON.parse((await nonce(P, visitor.address)).body), sig = await visitor.signMessage(n3.message);
    for (const host of ["evil.example", `localhost:${P}`]) {
      assert.equal((await nonce(P, visitor.address, { host })).status, 404, host);
      const r = await verify(P, { address: visitor.address, message: n3.message, signature: sig }, { host }); assert.equal(r.status, 404, host); assert.equal(r.headers["set-cookie"], undefined);
    }
    assert.equal((await verify(P, { address: visitor.address, message: n3.message, signature: sig })).status, 200, "the untouched message still works on the real host: the foreign attempts did not burn it");
  });

  test("wrong signer, wrong address and smart-contract (non-EOA) signatures are refused with a clear reason", async () => {
    const n1 = JSON.parse((await nonce(P, visitor.address)).body);
    const bad = await verify(P, { address: visitor.address, message: n1.message, signature: await other.signMessage(n1.message) });
    assert.equal(bad.status, 401); assert.match(bad.body, /1271|does not match/); assert.equal(bad.headers["set-cookie"], undefined);
    const n2 = JSON.parse((await nonce(P, visitor.address)).body);
    const swapped = await verify(P, { address: other.address, message: n2.message, signature: await other.signMessage(n2.message) }); assert.equal(swapped.status, 401, "request was issued for a different address");
    const n3 = JSON.parse((await nonce(P, admin1.address)).body);
    assert.equal((await verify(P, { address: visitor.address, message: n3.message, signature: await visitor.signMessage(n3.message) })).status, 401, "cannot sign in as an admin by signing the admin's message with another key");
  });

  test("malformed input is refused: bad address, signature shape, oversized body, wrong type", async () => {
    const n1 = JSON.parse((await nonce(P, visitor.address)).body), sig = await visitor.signMessage(n1.message);
    const ok = { address: visitor.address, message: n1.message, signature: sig };
    for (const [why, b] of [["address short", { ...ok, address: "0x123" }], ["address not hex", { ...ok, address: "0x" + "z".repeat(40) }], ["address number", { ...ok, address: 5 }], ["sig short", { ...ok, signature: "0x12" }], ["sig not hex", { ...ok, signature: "0x" + "g".repeat(130) }], ["sig missing", { address: ok.address, message: ok.message }], ["message number", { ...ok, message: 7 }], ["message huge", { ...ok, message: n1.message + "x".repeat(2000) }], ["array body", [ok]], ["null body", null]]) {
      const r = await verify(P, b); assert.ok([400, 401].includes(r.status), why + " " + r.status); assert.equal(r.headers["set-cookie"], undefined, why);
    }
    assert.equal((await verify(P, "x".repeat(5000))).status, 413);
    assert.equal((await verify(P, "{not json")).status, 400);
    assert.equal((await call(P, { method: "POST", path: "/auth/verify", headers: hdr(freshIp(), { "content-type": "text/plain" }), body: JSON.stringify(ok) })).status, 415);
    assert.equal((await call(P, { path: "/auth/verify", headers: hdr(freshIp()) })).status, 405);
  });

  test("session cookies cannot be forged, upgraded to admin, moved to another address or extended", async () => {
    const s = await signIn(P, visitor); const [name, val] = s.cookie.split("="); const [v, exp, role, addr, mac] = val.split(".");
    assert.equal(role, "user");
    const get = (c) => call(P, { path: "/api/status", headers: { cookie: `${name}=${c}` } });
    assert.equal((await get(val)).status, 403, "the genuine user cookie is known but not allowed");
    assert.equal((await get(`${v}.${exp}.admin.${addr}.${mac}`)).status, 401, "role escalation");
    assert.equal((await get(`${v}.${exp}.user.${admin1.address.toLowerCase()}.${mac}`)).status, 401, "address swap to an admin");
    assert.equal((await get(`${v}.${Number(exp) + 99_999_999}.${role}.${addr}.${mac}`)).status, 401, "extended expiry");
    assert.equal((await get(`${v}.${exp}.${role}.${addr}.${mac.slice(0, -2)}xx`)).status, 401, "bad MAC");
    assert.equal((await get(`v1.${exp}.${mac}`)).status, 401, "a wallet MAC is not a token-login MAC");
    assert.equal((await get(`${v}.${exp}.admin.${addr}`)).status, 401, "missing MAC");
    assert.equal((await get(`v2.${Date.now() - 1000}.admin.${addr}.${mac}`)).status, 401, "expired");
    const fake = `v2.${Date.now() + 3600_000}.admin.${admin1.address.toLowerCase()}.` + Buffer.from("x".repeat(32)).toString("base64url");
    assert.equal((await get(fake)).status, 401, "attacker-chosen MAC");
    assert.equal(JSON.parse((await call(P, { path: "/auth/session", headers: { cookie: `${name}=${v}.${exp}.admin.${addr}.${mac}` } })).body).signedIn, false);
  });

  test("CSRF: cross-site verify/logout are refused; sign-out clears the cookie", async () => {
    const n1 = JSON.parse((await nonce(P, visitor.address)).body), sig = await visitor.signMessage(n1.message);
    const body = { address: visitor.address, message: n1.message, signature: sig };
    assert.equal((await verify(P, body, { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await verify(P, body, { headers: { origin: "null" } })).status, 403);
    assert.equal((await verify(P, body, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await call(P, { path: "/auth/nonce?address=" + visitor.address, headers: hdr(freshIp(), { origin: "https://evil.example" }) })).status, 403);
    assert.equal((await verify(P, body, { headers: { origin: `https://${ADMIN}`, "sec-fetch-site": "same-origin" } })).status, 200, "what a real browser sends");
    const out = (h) => call(P, { method: "POST", path: "/auth/logout", headers: hdr(freshIp(), h) });
    assert.equal((await out({ origin: "https://evil.example" })).status, 403);
    const ok = await out({ origin: `https://${ADMIN}` }); assert.equal(ok.status, 200); assert.ok(String(ok.headers["set-cookie"]).includes("Max-Age=0"));
    assert.equal((await call(P, { path: "/auth/session" })).body, JSON.stringify({ signedIn: false }));
  });

  test("rate limits: nonce requests per client, and 5 failed verifications lock that client (right signature included) for 10 minutes", async () => {
    const ip = freshIp(); let last;
    for (let i = 0; i < 20; i++) { last = await nonce(P, visitor.address, { ip }); assert.equal(last.status, 200, "request " + i); }
    assert.equal((await nonce(P, visitor.address, { ip })).status, 429); assert.equal((await nonce(P, visitor.address, { ip: freshIp() })).status, 200, "another client is unaffected");

    const bf = freshIp(), n1 = JSON.parse((await nonce(P, admin1.address)).body), good = await admin1.signMessage(n1.message);
    for (let i = 0; i < 5; i++) assert.equal((await verify(P, { address: admin1.address, message: "guess " + i, signature: "0x" + "22".repeat(65) }, { ip: bf })).status, 401);
    const locked = await verify(P, { address: admin1.address, message: n1.message, signature: good }, { ip: bf });
    assert.equal(locked.status, 429); assert.equal(locked.headers["retry-after"], "600"); assert.equal(locked.headers["set-cookie"], undefined);
    const other1 = await verify(P, { address: admin1.address, message: n1.message, signature: good }, { ip: freshIp() });
    assert.equal(other1.status, 200, "the lock is per client, and the locked attempt did not burn the nonce");
  });

  test("tiers: /pub/quota says visitor or wallet; a wallet gets the larger bounded limit, counted per address; the visitor limit is unchanged", async () => {
    const vip = freshIp(), q0 = JSON.parse((await call(P, { path: "/pub/quota", headers: hdr(vip) })).body);
    assert.deepEqual(q0, { tier: "visitor", used: 0, limit: 2, resetsAt: null });
    const chat = (ip, cookie) => call(P, { method: "POST", path: "/pub/chat", headers: hdr(ip, { ...J, ...(cookie ? { cookie } : {}) }), body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) });
    for (let i = 0; i < 2; i++) assert.equal((await chat(vip)).status, 200);
    const refused = await chat(vip); assert.equal(refused.status, 429); assert.match(refused.body, /wallet/i, "tells the visitor what more they could do");

    const w = Wallet.createRandom(), ip = freshIp(); const s = await signIn(P, w, { ip }); assert.equal(s.json.role, "user");
    const q1 = JSON.parse((await call(P, { path: "/pub/quota", headers: hdr(ip, { cookie: s.cookie }) })).body);
    assert.deepEqual(q1, { tier: "wallet", used: 0, limit: 5, resetsAt: null });
    for (let i = 0; i < 5; i++) assert.equal((await chat(ip, s.cookie)).status, 200, "wallet request " + i);
    const done = await chat(ip, s.cookie); assert.equal(done.status, 429); assert.ok(Number(done.headers["retry-after"]) >= 60);
    const q2 = JSON.parse((await call(P, { path: "/pub/quota", headers: hdr(ip, { cookie: s.cookie }) })).body);
    assert.equal(q2.used, 5); assert.equal(q2.tier, "wallet"); assert.ok(q2.resetsAt > Date.now());
    // a cookie is needed to claim the tier; the same IP without one is a visitor, and a forged one is not honoured
    assert.equal(JSON.parse((await call(P, { path: "/pub/quota", headers: hdr(ip) })).body).tier, "visitor");
    const forged = s.cookie.replace(".user.", ".admin.").replace(/\.[^.]+$/, ".AAAA");
    assert.equal(JSON.parse((await call(P, { path: "/pub/quota", headers: hdr(ip, { cookie: forged }) })).body).tier, "visitor");
    // a different wallet from the same machine has its own address budget but shares the IP cap (3x the wallet limit), so minting wallets does not dodge limits
    let ok = 0, status = 0;
    for (let i = 0; i < 4; i++) { const t = await signIn(P, Wallet.createRandom(), { ip }); for (let k = 0; k < 5; k++) { status = (await chat(ip, t.cookie)).status; if (status === 200) ok++; else break; } }
    assert.equal(ok, 10, "15 per IP and hour in total, 5 already used by the first wallet"); assert.equal(status, 429);
    assert.equal(JSON.parse((await call(P, { path: "/pub/info", headers: hdr(freshIp()) })).body).you.tier, "visitor");
  });

  test("the token login still works next to the wallet and its cookie has no address", async () => {
    const r = await call(P, { method: "POST", path: "/admin/login", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "token=" + encodeURIComponent(TOKEN) });
    assert.equal(r.status, 303);
    const ss = JSON.parse((await call(P, { path: "/auth/session", headers: { cookie: cookieOf(r) } })).body);
    assert.equal(ss.signedIn, true); assert.equal(ss.role, "admin"); assert.equal(ss.address, undefined);
    const page = await call(P, { path: "/admin/login" });
    assert.match(page.body, /name=token/); assert.match(page.body, /id=wbtn/);
    assert.match(page.headers["content-security-policy"], /script-src 'self'/); assert.doesNotMatch(page.headers["content-security-policy"], /script-src[^;]*unsafe/);
    assert.doesNotMatch(page.body, /<script(?![^>]*\bsrc=)/i, "no inline script, ever");
    assert.equal(/default-src 'none'/.test(page.headers["content-security-policy"]), true);
  });
});

describe("wallet-only admin (no token) and its login page", () => {
  let n; const P = 18982;
  before(async () => { n = await boot(P, { ELYRA_ADMIN_HOST: ADMIN, ELYRA_ADMIN_ADDRESSES: admin1.address }); });
  after(() => stop(n));

  test("remote admin turns on with host + address alone; the token login is off", async () => {
    const t = await call(P, { method: "POST", path: "/admin/login", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "token=" });
    assert.equal(t.status, 401); assert.equal(t.headers["set-cookie"], undefined); assert.doesNotMatch(t.body, /name=token/);
    assert.equal((await call(P, { path: "/api/status" })).status, 401);
    const s = await signIn(P, admin1); assert.equal(s.json.role, "admin");
    assert.equal((await call(P, { path: "/api/status", headers: { cookie: s.cookie } })).status, 200);
    const u = await signIn(P, visitor); assert.equal(u.json.role, "user");
    assert.equal((await call(P, { path: "/api/status", headers: { cookie: u.cookie } })).status, 403);
  });

  test("the login page offers the wallet and loads only same-origin scripts under a CSP that allows nothing else", async () => {
    const page = await call(P, { path: "/admin/login" });
    assert.equal(page.status, 200); assert.match(page.body, /Sign in with wallet/); assert.match(page.body, /<script src=\/admin\/login\.js defer><\/script>/); assert.doesNotMatch(page.body, /<script(?![^>]*\bsrc=)/i);
    const csp = page.headers["content-security-policy"]; assert.match(csp, /default-src 'none'/); assert.match(csp, /script-src 'self'(;|$)/); assert.match(csp, /connect-src 'self'(;|$)/); assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*(unsafe-inline|https?:|\*)/);
    for (const p of ["/admin/login.js", "/admin/auth.js"]) {
      const r = await call(P, { path: p }); assert.equal(r.status, 200, p); assert.match(r.headers["content-type"], /javascript/); assert.equal(r.headers["x-content-type-options"], "nosniff");
    }
    assert.match((await call(P, { path: "/admin/auth.js" })).body, /export async function signInWithWallet/);
    assert.equal((await call(P, { path: "/admin/other.js" })).status, 302, "only the two named scripts exist; anything else is behind the login");
    assert.equal((await call(P, { method: "POST", path: "/admin/login.js", headers: J, body: "{}" })).status, 405);
  });
});

describe("deployments without wallet sign-in stay as they were", () => {
  let a, b; const PA = 18983, PB = 18984;
  before(async () => {
    a = await boot(PA, { ELYRA_ADMIN_HOST: ADMIN, ELYRA_ADMIN_TOKEN: TOKEN });
    b = await boot(PB, { ELYRA_ADMIN_HOST: ADMIN, ELYRA_ADMIN_ADDRESSES: "0xnothex, 123" });
  });
  after(async () => { await stop(a); await stop(b); });

  test("token only: no /auth routes, no wallet script, the page forbids script entirely", async () => {
    for (const p of ["/auth/session", "/auth/nonce?address=" + visitor.address]) assert.equal((await call(PA, { path: p })).status, 404, p);
    assert.equal((await verify(PA, "{}")).status, 404);
    assert.equal((await call(PA, { path: "/admin/login.js" })).status, 404);
    const page = await call(PA, { path: "/admin/login" });
    assert.doesNotMatch(page.headers["content-security-policy"], /script-src/); assert.doesNotMatch(page.body, /<script|wbtn/);
  });

  test("an address list with no valid address does not enable anything (fails closed)", async () => {
    assert.equal((await call(PB, { path: "/api/status" })).status, 403, "the admin host is not recognised: loopback rules apply");
    assert.equal((await call(PB, { path: "/auth/session" })).status, 404);
    assert.equal((await call(PB, { path: "/api/status", host: `localhost:${PB}` })).status, 200);
  });
});

describe("siwe unit: expiry, future issue time, bounded memory, global lock, parsing", () => {
  const w = Wallet.createRandom();
  const mk = (clock, extra = {}) => {
    const c = { t: 1_800_000_000_000, ...clock };
    const s = createSiwe({ host: ADMIN, chainId: () => 4663, admins: new Set([w.address.toLowerCase()]), now: () => c.t, client: (r) => r.ip, assertOrigin() {}, mint: (role, address) => ({ cookie: "c", exp: c.t, role, address }), session: () => null, clearCookie: "x", ...extra });
    return { s, c };
  };

  test("an expired request is refused; one still inside five minutes works and reports its role", async () => {
    const { s, c } = mk();
    const a = s.issue(w.address); assert.match(a.message, /Chain ID: 4663/);
    c.t += 4 * 60_000; assert.deepEqual(s.redeem({ address: w.address, message: a.message, signature: await w.signMessage(a.message) }, "x"), { address: w.address, role: "admin" });
    const b = s.issue(w.address), sig = await w.signMessage(b.message);
    c.t += 5 * 60_000 + 1; assert.throws(() => s.redeem({ address: w.address, message: b.message, signature: sig }, "y"), /expired/);
    const o = Wallet.createRandom(), d = s.issue(o.address); assert.equal(s.redeem({ address: o.address, message: d.message, signature: await o.signMessage(d.message) }, "z").role, "user");
  });

  test("a message issued in the future (clock skew or forged) is refused", async () => {
    const { s, c } = mk();
    const a = s.issue(w.address), sig = await w.signMessage(a.message);
    c.t -= 10 * 60_000; assert.throws(() => s.redeem({ address: w.address, message: a.message, signature: sig }, "x"), /Clock mismatch/);
    const n = s.issue(w.address); // a forged issued-at/expiry claiming a longer life with the live nonce
    const forged = buildMessage({ domain: ADMIN, address: w.address, uri: `https://${ADMIN}`, chainId: 4663, nonce: n.nonce, issuedAt: c.t + 3600_000, expiresAt: c.t + 7200_000 });
    assert.throws(() => s.redeem({ address: w.address, message: forged, signature: "0x" + "00".repeat(64) + "1b" }, "x"), /not the one this node issued/);
  });

  test("the nonce store is bounded and old nonces are dropped; global issuing is capped", async () => {
    const { s, c } = mk();
    for (let i = 0; i < 600; i++) { c.t += 1; s.issue(w.address, "c" + i); }
    assert.throws(() => s.issue(w.address, "extra"), /Too many/); assert.ok(s.size() <= 2048);
    c.t += 6 * 60_000; const x = s.issue(w.address, "late"); assert.ok(x.nonce); assert.equal(s.size(), 1, "expired nonces are swept");
  });

  test("60 failures anywhere lock verification for everyone for 10 minutes", () => {
    const { s, c } = mk();
    for (let i = 0; i < 60; i++) assert.throws(() => s.redeem({ address: w.address, message: "m", signature: "0x" + "00".repeat(65) }, "ip" + (i % 20)), /Unknown|Too many/);
    assert.throws(() => s.redeem({ address: w.address, message: "m", signature: "0x" + "00".repeat(65) }, "brand-new"), /Too many attempts/);
    c.t += 10 * 60_000 + 1; assert.throws(() => s.redeem({ address: w.address, message: "m", signature: "0x" + "00".repeat(65) }, "brand-new"), /Unknown/);
  });

  test("parseAdminAddresses lowercases, trims, dedupes and counts junk", () => {
    const r = parseAdminAddresses(` ${w.address}, ${w.address.toLowerCase()},0x12, ,x `);
    assert.deepEqual([...r.set], [w.address.toLowerCase()]); assert.equal(r.rejected, 2);
    assert.equal(parseAdminAddresses(undefined).set.size, 0);
  });

  test("buildMessage is plain EIP-4361", () => {
    const m = buildMessage({ domain: "a.b", address: "0xA", uri: "https://a.b", chainId: 1, nonce: "ff", issuedAt: 0, expiresAt: 1000 });
    assert.equal(m, "a.b wants you to sign in with your Ethereum account:\n0xA\n\nSign in to Elyra. This does not move funds or approve anything.\n\nURI: https://a.b\nVersion: 1\nChain ID: 1\nNonce: ff\nIssued At: 1970-01-01T00:00:00.000Z\nExpiration Time: 1970-01-01T00:00:01.000Z");
  });
});
