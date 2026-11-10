// Remote admin (opt-in): login, session, Origin, proxy-header and rate-limit rules. Run: node --test router/test/remote.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
const TOKEN = "t".repeat(8) + "correct-horse-battery-staple-123";
const ADMIN = "admin.elyra.test";
const J = { "content-type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// node's fetch cannot set Host; use http.request so we can talk "as" the admin hostname
const call = (port, { method = "GET", path = "/", host = `localhost:${port}`, headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, method, path, headers: { host, ...headers } }, (res) => {
    let data = ""; res.setEncoding("utf8"); res.on("data", (c) => (data += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
  });
  req.on("error", reject); if (body) req.write(body); req.end();
});
const start = async (port, env) => {
  const dir = mkdtempSync(join(tmpdir(), "vpr-remote-"));
  const p = spawn(process.execPath, [server, "--port", String(port), "--data", dir, "--no-demo"], { env: { ...process.env, ...env }, stdio: "pipe" });
  for (let i = 0; i < 300; i++) { try { if ((await call(port, { path: "/healthz" })).status === 200) return { p, dir }; } catch { /* booting */ } await sleep(100); }
  throw new Error("node did not start");
};
const stop = async (n) => { if (n.p.exitCode === null) { const done = new Promise((r) => n.p.once("exit", r)); n.p.kill(); await done; } rmSync(n.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); };
const cookieOf = (r) => String(r.headers["set-cookie"] ?? "").split(";")[0];
const form = (t) => ({ method: "POST", path: "/admin/login", host: ADMIN, headers: { "content-type": "application/x-www-form-urlencoded" }, body: "token=" + encodeURIComponent(t) });

describe("remote admin disabled (default)", () => {
  let n; const P = 18951;
  before(async () => { n = await start(P, { ELYRA_ADMIN_HOST: "", ELYRA_ADMIN_TOKEN: "" }); });
  after(() => stop(n));
  test("localhost still works; any other Host is refused; no login route exists", async () => {
    assert.equal((await call(P, { path: "/api/status" })).status, 200);
    assert.equal((await call(P, { path: "/api/status", host: ADMIN })).status, 403);
    assert.equal((await call(P, { path: "/admin/login", host: ADMIN })).status, 404);
  });
});

describe("remote admin misconfigured fails closed", () => {
  let n; const P = 18952;
  before(async () => { n = await start(P, { ELYRA_ADMIN_HOST: ADMIN, ELYRA_ADMIN_TOKEN: "short" }); });
  after(() => stop(n));
  test("a too-short token does not enable remote access", async () => {
    assert.equal((await call(P, { path: "/api/status", host: ADMIN })).status, 403);
    assert.equal((await call(P, { path: "/admin/login", host: ADMIN })).status, 404);
  });
});

describe("remote admin enabled", () => {
  let n; const P = 18953;
  before(async () => { n = await start(P, { ELYRA_ADMIN_HOST: ADMIN, ELYRA_ADMIN_TOKEN: TOKEN }); });
  after(() => stop(n));

  test("no session: API is 401, panel redirects to the login page, /metrics is never reachable", async () => {
    const a = await call(P, { path: "/api/status", host: ADMIN });
    assert.equal(a.status, 401); assert.ok(!a.body.includes("balance"));
    const v = await call(P, { path: "/v1/models", host: ADMIN }); assert.equal(v.status, 401);
    const app = await call(P, { path: "/app/", host: ADMIN });
    assert.equal(app.status, 302); assert.equal(app.headers.location, "/admin/login");
    assert.equal((await call(P, { path: "/metrics", host: ADMIN })).status, 403);
    assert.equal((await call(P, { path: "/admin/login", host: ADMIN })).status, 200);
  });

  test("wrong token is refused and sets no cookie; the right one sets a hardened cookie", async () => {
    const bad = await call(P, form("nope")); assert.equal(bad.status, 401); assert.equal(bad.headers["set-cookie"], undefined);
    const ok = await call(P, form(TOKEN)); assert.equal(ok.status, 303); assert.equal(ok.headers.location, "/app/");
    const sc = String(ok.headers["set-cookie"]);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(sc.includes(flag), flag);
    assert.ok(!sc.includes(TOKEN), "cookie must not contain the token");
  });

  test("with a session: panel, /api and /v1 work on the admin host, the token is not echoed anywhere", async () => {
    const c = cookieOf(await call(P, form(TOKEN)));
    const st = await call(P, { path: "/api/status", host: ADMIN, headers: { cookie: c } });
    assert.equal(st.status, 200); assert.ok(!st.body.includes(TOKEN)); assert.equal(st.headers["cache-control"], "no-store");
    assert.equal((await call(P, { path: "/v1/models", host: ADMIN, headers: { cookie: c } })).status, 200);
    assert.equal((await call(P, { path: "/app/", host: ADMIN, headers: { cookie: c } })).status, 200);
    assert.equal((await call(P, { path: "/", host: ADMIN, headers: { cookie: c } })).headers.location, "/app/");
    assert.equal((await call(P, { path: "/metrics", host: ADMIN, headers: { cookie: c } })).status, 403, "metrics stay loopback-only even with a session");
  });

  test("a session is bound to the admin host and cannot be forged or tampered with", async () => {
    const c = cookieOf(await call(P, form(TOKEN)));
    assert.equal((await call(P, { path: "/api/status", host: "evil.example", headers: { cookie: c } })).status, 403);
    const [name, val] = c.split("=");
    const [ver, exp, mac] = val.split(".");
    assert.equal((await call(P, { path: "/api/status", host: ADMIN, headers: { cookie: `${name}=${ver}.${exp}.${mac.slice(0, -2)}xx` } })).status, 401, "bad MAC");
    assert.equal((await call(P, { path: "/api/status", host: ADMIN, headers: { cookie: `${name}=${ver}.${Number(exp) + 99999999}.${mac}` } })).status, 401, "extended expiry");
    assert.equal((await call(P, { path: "/api/status", host: ADMIN, headers: { cookie: `${name}=${ver}.${Date.now() - 1000}.${mac}` } })).status, 401, "expired / wrong MAC");
  });

  test("cross-site writes with a valid session are refused (CSRF)", async () => {
    const c = cookieOf(await call(P, form(TOKEN)));
    const put = (extra) => call(P, { method: "PUT", path: "/api/policy", host: ADMIN, headers: { cookie: c, ...J, ...extra }, body: JSON.stringify({ maxPrice: 3 }) });
    assert.equal((await put({ origin: "https://evil.example" })).status, 403);
    assert.equal((await put({ "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await put({ origin: `https://${ADMIN}` })).status, 200);
  });

  test("proxied traffic can never use the localhost path; plain local requests still can", async () => {
    for (const h of [{ "cf-connecting-ip": "203.0.113.9" }, { "x-forwarded-for": "203.0.113.9" }]) {
      assert.equal((await call(P, { path: "/api/status", headers: h })).status, 403, JSON.stringify(h));
    }
    assert.equal((await call(P, { path: "/api/status" })).status, 200);
  });

  test("the peer protocol stays open on the admin host (it is the network-facing surface)", async () => {
    assert.equal((await call(P, { path: "/p2p/hello", host: ADMIN })).status, 200);
    assert.equal((await call(P, { path: "/healthz", host: ADMIN })).status, 200);
  });

  test("brute force is rate limited: after repeated failures even the right token is refused for a while", async () => {
    const id = { "cf-connecting-ip": "198.51.100.77" };
    let last;
    for (let i = 0; i < 5; i++) last = await call(P, { ...form("wrong" + i), headers: { ...form("x").headers, ...id } });
    assert.equal(last.status, 401);
    const locked = await call(P, { ...form(TOKEN), headers: { ...form("x").headers, ...id } });
    assert.equal(locked.status, 429); assert.equal(locked.headers["set-cookie"], undefined);
    const other = await call(P, { ...form(TOKEN), headers: { ...form("x").headers, "cf-connecting-ip": "198.51.100.78" } });
    assert.equal(other.status, 303, "another client is not locked out by one client's failures");
  });

  test("the login page must let browsers send a real Origin on the form POST (no-referrer makes Chrome send Origin: null)", async () => {
    const page = await call(P, { path: "/admin/login", host: ADMIN });
    assert.notEqual(page.headers["referrer-policy"], "no-referrer");
    assert.equal(page.headers["referrer-policy"], "same-origin");
    const nul = await call(P, { ...form(TOKEN), headers: { ...form("x").headers, origin: "null" } });
    assert.equal(nul.status, 403, "Origin: null stays refused (sandboxed iframes and cross-origin redirects send it)");
    const real = await call(P, { ...form(TOKEN), headers: { ...form("x").headers, origin: `https://${ADMIN}`, "sec-fetch-site": "same-origin" } });
    assert.equal(real.status, 303, "what a real browser sends after the fix");
  });

  test("sign out clears the cookie", async () => {
    const out = await call(P, { method: "POST", path: "/admin/logout", host: ADMIN, headers: { origin: `https://${ADMIN}` } });
    assert.equal(out.status, 303); assert.ok(String(out.headers["set-cookie"]).includes("Max-Age=0"));
  });
});
