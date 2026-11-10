// OPT-IN remote admin: lets the control panel, /api and /v1 be reached through a reverse proxy or tunnel on ONE named host,
// behind a login. Off unless ELYRA_ADMIN_HOST is set together with ELYRA_ADMIN_TOKEN (>= 24 chars) and/or ELYRA_ADMIN_ADDRESSES
// (wallet sign-in, see siwe.mjs and docs/AUTH.md); with it off nothing changes and /api, /v1, /metrics stay loopback-only (see guard.mjs).
// Why a login is mandatory: a tunnel/proxy connects from loopback, so the peer-address check proves nothing for proxied
// traffic. Rules enforced here:
//  - only the exact admin host is accepted for remote use; every other Host keeps the loopback rules
//  - once enabled, a request carrying proxy headers (cf-connecting-ip, x-forwarded-for, ...) can never use the localhost path
//  - session = HttpOnly + Secure + SameSite=Strict cookie, HMAC-signed with a per-boot random key (restart logs everyone out).
//    The token login mints role "admin"; a wallet sign-in mints "admin" (allow-listed address) or "user" (any other address).
//    Only an admin session passes authed(); a user session is identity + public quota and can never reach /api, /v1 or /metrics
//  - token compared in constant time; failed logins are rate-limited per client and globally
//  - writes from a browser must carry an Origin equal to the admin origin (CSRF)
//  - /metrics is never reachable through the admin host
// The token lives only in the environment (EnvironmentFile, chmod 600). It is never logged or returned by any endpoint.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loginPage } from "./login-page.mjs";
import crypto from "node:crypto";
import { HttpError } from "../lib/errors.mjs";
import { log } from "../obs.mjs";
import { createSiwe, parseAdminAddresses } from "./siwe.mjs";

const COOKIE = "elyra_admin";
const SESSION_MS = 12 * 3600_000;
const PROXY_HEADERS = ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"];
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const hostOnly = (h) => String(h ?? "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
const CSP_BASE = "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'";
const CSP_WALLET = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
// the login page's own scripts (wallet sign-in); same-origin external files, never inline
const ASSETS = { "/admin/login.js": "login.js", "/admin/auth.js": "auth.js" };

/** `opts.chainId`: () => id of the configured network (SIWE chain id); `opts.panelDir`: where panel/try/{login,auth}.js live; `opts.accounts`: the username profile store (gateway on) or null; `opts.now` for tests. */
export function createRemote(env = process.env, { chainId = () => 46630, panelDir = "", now = Date.now, accounts = null } = {}) {
  const host = hostOnly(env.ELYRA_ADMIN_HOST);
  const token = env.ELYRA_ADMIN_TOKEN ?? "";
  const { set: admins, rejected } = parseAdminAddresses(env.ELYRA_ADMIN_ADDRESSES);
  const tokenOk = token.length >= 24;
  const requested = Boolean(host || token || env.ELYRA_ADMIN_ADDRESSES);
  const enabled = Boolean(host) && /^[a-z0-9.-]+$/.test(host) && (tokenOk || admins.size > 0);
  if (requested && !enabled) log("error", "remote admin NOT enabled: need ELYRA_ADMIN_HOST (hostname) and ELYRA_ADMIN_TOKEN (>= 24 chars) and/or ELYRA_ADMIN_ADDRESSES (0x addresses)");
  if (!enabled) return { enabled: false };
  if (rejected) log("warn", "ELYRA_ADMIN_ADDRESSES: entries that are not 0x addresses were ignored", { count: rejected });
  if (token && !tokenOk) log("warn", "ELYRA_ADMIN_TOKEN is shorter than 24 characters: token sign-in is off (wallet sign-in only)");

  // wallet sign-in (SIWE) is on when an admin address is listed, the public page (larger quota for signed-in visitors) or the gateway (wallet accounts) is on
  const walletAuth = admins.size > 0 || env.ELYRA_PUBLIC_TRY === "1" || env.ELYRA_GATEWAY === "1";
  const key = crypto.randomBytes(32);
  const tokenHash = tokenOk ? sha(token) : null;
  const origin = `https://${host}`;
  const sign = (payload) => crypto.createHmac("sha256", key).update(payload).digest("base64url");
  const fails = new Map(); // client -> { n, until }
  let globalFails = { n: 0, until: 0 };

  const client = (req) => String(req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?").split(",")[0].trim();
  const isAdminHost = (req) => hostOnly(req.headers.host) === host;
  const isProxied = (req) => PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
  const cookies = (req) => Object.fromEntries(String(req.headers.cookie ?? "").split(";").map((c) => c.trim().split(/=(.*)/s).slice(0, 2)).filter(([k]) => k));
  const sameMac = (want, got) => { const a = Buffer.from(want), b = Buffer.from(got ?? ""); return a.length === b.length && crypto.timingSafeEqual(a, b); };
  const attrs = `Path=/; HttpOnly; Secure; SameSite=Strict`;
  const clearCookie = `${COOKIE}=; ${attrs}; Max-Age=0`;

  /**
   * The verified session of this request, or null: { role: "admin"|"user", address: lowercase 0x | null, exp: ms }.
   * v1.<exp>.<mac>                       token login (admin, no address)
   * v2.<exp>.<role>.<address>.<mac>      wallet sign-in
   */
  const revoked = new Map(); // mac -> exp of cookies that were signed out: dead on the server even if somebody kept a copy
  const parse = (req) => {
    const v = cookies(req)[COOKIE];
    if (!v || v.length > 200) return null;
    const p = v.split(".");
    if (!/^\d{10,}$/.test(p[1] ?? "") || Number(p[1]) < now()) return null;
    if (p[0] === "v1" && p.length === 3) return sameMac(sign("v1." + p[1]), p[2]) ? { mac: p[2], s: { role: "admin", address: null, exp: Number(p[1]) } } : null;
    if (p[0] === "v2" && p.length === 5 && (p[2] === "admin" || p[2] === "user") && /^0x[0-9a-f]{40}$/.test(p[3])) {
      return sameMac(sign(`v2.${p[1]}.${p[2]}.${p[3]}`), p[4]) ? { mac: p[4], s: { role: p[2], address: p[3], exp: Number(p[1]) } } : null;
    }
    return null;
  };
  function session(req) { const c = parse(req); return c && !revoked.has(c.mac) ? c.s : null; }
  /** Sign-out: remember this exact (validly signed) cookie as dead until it would have expired anyway. Bounded: only valid sessions can add entries. */
  function revoke(req) {
    const c = parse(req); if (!c) return;
    const t = now();
    if (revoked.size >= 5000) for (const [m, e] of revoked) if (e < t) revoked.delete(m);
    while (revoked.size >= 5000) revoked.delete(revoked.keys().next().value);
    revoked.set(c.mac, c.s.exp);
  }
  /** An admin session: the only thing that opens the panel, /api and /v1. */
  const authed = (req) => session(req)?.role === "admin";
  function mint(role, address) {
    const exp = now() + SESSION_MS;
    return { exp, cookie: `${COOKIE}=v2.${exp}.${role}.${address}.${sign(`v2.${exp}.${role}.${address}`)}; ${attrs}; Max-Age=${SESSION_MS / 1000}` };
  }

  /** Throws unless this is a same-origin browser write (or a non-browser client with no Origin). */
  function assertOrigin(req) {
    const o = req.headers.origin;
    if (o && o !== origin) throw new HttpError(403, "cross-site request refused", "forbidden");
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(req.headers["sec-fetch-site"])) throw new HttpError(403, "cross-site request refused", "forbidden");
  }

  const page = (res, status, msg = "", extra = {}) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": admins.size ? CSP_WALLET : CSP_BASE, "referrer-policy": "same-origin", ...extra });
    res.end(loginPage(msg, { token: tokenOk, wallet: admins.size > 0 }));
  };

  async function readForm(req) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > 4096) throw new HttpError(413, "body too large"); chunks.push(c); }
    const raw = Buffer.concat(chunks).toString("utf8");
    try { return String(JSON.parse(raw).token ?? ""); } catch { return String(new URLSearchParams(raw).get("token") ?? ""); }
  }

  async function login(req, res) {
    if (req.method !== "POST") return page(res, 200);
    assertOrigin(req);
    if (!tokenHash) return page(res, 401, "Token sign-in is off on this node. Use your wallet.");
    const id = client(req), t = now();
    const f = fails.get(id) ?? { n: 0, until: 0 };
    if (f.until > t || globalFails.until > t) { res.setHeader("retry-after", "600"); return page(res, 429, "Too many attempts. Try again later."); }
    const given = await readForm(req);
    if (crypto.timingSafeEqual(sha(given), tokenHash)) {
      fails.delete(id);
      const exp = String(t + SESSION_MS);
      log("info", "admin login ok");
      return page(res, 303, "", { location: "/app/", "set-cookie": `${COOKIE}=v1.${exp}.${sign("v1." + exp)}; ${attrs}; Max-Age=${SESSION_MS / 1000}` });
    }
    f.n += 1; if (f.n >= 5) { f.until = t + 600_000; f.n = 0; }
    fails.set(id, f); if (fails.size > 1000) fails.clear();
    globalFails.n += 1; if (globalFails.n >= 30) { globalFails = { n: 0, until: t + 600_000 }; log("warn", "admin login globally locked for 10 min"); }
    log("warn", "admin login failed");
    return page(res, 401, "Wrong token.");
  }

  function logout(req, res) {
    if (req.method !== "POST") return page(res, 405, "Use the sign-out button.");
    assertOrigin(req);
    revoke(req);
    return page(res, 303, "", { location: "/admin/login", "set-cookie": clearCookie });
  }

  const siwe = walletAuth ? createSiwe({ host, chainId, admins, now, client, assertOrigin, mint, session, revoke, clearCookie, accounts }) : null;
  /** /auth/*: wallet sign-in, session probe, sign-out. Admin host only (app.mjs). */
  async function auth(req, res, path, url) {
    if (!siwe) throw new HttpError(404, "Not Found");
    return siwe.handle(req, res, path, url);
  }

  /** The two same-origin scripts of the login page (wallet sign-in). Only the names in ASSETS can be read. */
  function asset(req, res, path) {
    if (!admins.size || !panelDir || !ASSETS[path]) throw new HttpError(404, "Not Found");
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
    let src; try { src = readFileSync(join(panelDir, "try", ASSETS[path])); } catch { throw new HttpError(404, "Not Found"); }
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : src);
  }

  return { enabled: true, host, origin, isAdminHost, isProxied, authed, session, assertOrigin, login, logout, auth, asset, isAsset: (p) => p in ASSETS, page };
}
