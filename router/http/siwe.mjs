// Sign-In with Ethereum (EIP-4361) for the admin host: GET /auth/nonce, POST /auth/verify, GET /auth/session, POST /auth/logout and, with the gateway on
// (ELYRA_GATEWAY=1), the username profile: GET /auth/username?name=, PUT /auth/username.
// What a signature proves: the signer controls the private key of an EOA address, right now, for THIS host. It moves no funds, approves
// nothing and sends no transaction. What it does not prove: who the person is, or that they own anything. Hence the roles:
//   admin = the address is in ELYRA_ADMIN_ADDRESSES (full control, same as the token)    user = any other address (identity + a larger public quota only)
// Rules enforced here (each one has a test in router/test/siwe.test.mjs, see docs/AUTH.md):
//  - the SERVER builds the message and remembers it per nonce; /auth/verify accepts only that exact text (so domain, uri, chain id,
//    statement, issued-at and expiry cannot be altered), once: the nonce is consumed on the first attempt, valid or not
//  - nonces are 16 random bytes, live 5 minutes, bounded in number; issuing is rate limited per client and globally
//  - only EOA signatures (ecrecover) are accepted; EIP-1271 contract wallets are refused with a clear message
//  - failed verifications lock the client for 10 minutes after 5, and everyone's verification for 10 minutes after 60 (like the token login)
//  - bodies are capped at 4 KiB, same-origin writes only (Origin check), JSON only
//  - logout clears the cookie AND revokes that exact cookie on the server (remote.mjs), so a copied cookie dies with the session
// The session cookie itself is minted by remote.mjs (same HMAC family as the token login); this file never sees the cookie key.
import crypto from "node:crypto";
import { HttpError } from "../lib/errors.mjs";
import { log } from "../obs.mjs";
import { readJson, send } from "./io.mjs";

let E = null;
try { E = await import("ethers"); } catch { /* wallet sign-in answers 503 without ethers */ }

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const STATEMENT = "Sign in to Elyra. This does not move funds or approve anything.";
const NONCE_RE = /\nNonce: ([0-9a-f]{32})\n/;
const NONCE_TTL_MS = 5 * 60_000, FUTURE_SKEW_MS = 60_000, MAX_NONCES = 2048, MAX_MESSAGE = 1024, LOCK_MS = 600_000;

/** "0xA..., 0xB..." -> { set: Set of lowercase addresses, rejected: number of entries that are not addresses (ignored: fails closed) } */
export function parseAdminAddresses(raw) {
  const set = new Set(); let rejected = 0;
  for (const s of String(raw ?? "").split(",").map((x) => x.trim()).filter(Boolean)) { if (ADDRESS_RE.test(s)) set.add(s.toLowerCase()); else rejected++; }
  return { set, rejected };
}

/** The exact EIP-4361 text a wallet shows and signs. `address` must be the EIP-55 form. */
export function buildMessage({ domain, address, uri, chainId, nonce, issuedAt, expiresAt }) {
  return `${domain} wants you to sign in with your Ethereum account:\n${address}\n\n${STATEMENT}\n\nURI: ${uri}\nVersion: 1\nChain ID: ${chainId}\nNonce: ${nonce}\nIssued At: ${new Date(issuedAt).toISOString()}\nExpiration Time: ${new Date(expiresAt).toISOString()}`;
}

/**
 * host: the admin hostname (the SIWE domain); chainId: () => number of the configured network; admins: Set of lowercase addresses;
 * client(req): rate-limit key; assertOrigin(req); mint(role, address) -> { cookie, exp }; session(req) -> { role, address, exp } | null; clearCookie: string.
 */
export function createSiwe({ host, chainId, admins, now = Date.now, client, assertOrigin, mint, session, revoke = () => {}, clearCookie, accounts = null }) {
  const uri = `https://${host}`;
  const nonces = new Map(); // nonce -> { address (lowercase), message, issuedAt, expiresAt }, oldest first
  const issued = new Map(), fails = new Map(); // client -> [timestamps] / { n, until }
  const globalIssued = [], profileReads = new Map(), profileWrites = new Map();
  let globalFails = { n: 0, until: 0 };

  const sweepNonces = () => {
    const t = now();
    for (const [k, v] of nonces) { if (v.expiresAt > t) break; nonces.delete(k); }
    while (nonces.size >= MAX_NONCES) nonces.delete(nonces.keys().next().value);
  };
  /** sliding window: false when `key` already used up `max` in the last `windowMs` */
  const allow = (map, key, windowMs, max) => {
    const t = now(), a = (map.get(key) ?? []).filter((x) => x > t - windowMs);
    if (a.length >= max) { map.set(key, a); return false; }
    a.push(t); map.set(key, a);
    if (map.size > 2000) for (const [k, v] of map) if (!v.some((x) => x > t - windowMs)) map.delete(k);
    if (map.size > 4000) map.clear();
    return true;
  };

  /** One nonce + the exact message for `address`. Throws 400 (not an address), 429 (rate), 503 (no ethers). */
  function issue(address, who = "?") {
    if (!E) throw new HttpError(503, "Wallet sign-in is unavailable on this node (ethers is not installed).", "unavailable");
    if (typeof address !== "string" || !ADDRESS_RE.test(address)) throw new HttpError(400, "send ?address=0x… (your wallet address)", "invalid_request_error");
    const t = now();
    while (globalIssued.length && globalIssued[0] <= t - NONCE_TTL_MS) globalIssued.shift();
    if (globalIssued.length >= 600 || !allow(issued, who, 60_000, 20)) throw new HttpError(429, "Too many sign-in requests. Try again in a minute.", "rate_limited");
    globalIssued.push(t);
    sweepNonces();
    const nonce = crypto.randomBytes(16).toString("hex");
    const expiresAt = t + NONCE_TTL_MS;
    const message = buildMessage({ domain: host, address: E.getAddress(address.toLowerCase()), uri, chainId: chainId(), nonce, issuedAt: t, expiresAt });
    nonces.set(nonce, { address: address.toLowerCase(), message, issuedAt: t, expiresAt });
    return { message, nonce, expiresAt };
  }

  /** Consumes the nonce, checks everything, returns { address (EIP-55), role } or throws HttpError 400/401. Does not touch rate limits. */
  function check({ address, message, signature }) {
    if (!E) throw new HttpError(503, "Wallet sign-in is unavailable on this node (ethers is not installed).", "unavailable");
    if (address !== undefined && (typeof address !== "string" || !ADDRESS_RE.test(address))) throw new HttpError(400, "address is not a valid 0x address", "invalid_request_error"); // optional: the nonce record knows who it was issued for
    if (typeof message !== "string" || message.length > MAX_MESSAGE) throw new HttpError(400, "message is missing or too long", "invalid_request_error");
    if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new HttpError(400, "signature must be a 65-byte hex string", "invalid_request_error");
    const m = NONCE_RE.exec(message);
    const rec = m ? nonces.get(m[1]) : null;
    if (!rec) throw new HttpError(401, "Unknown or already used sign-in request. Start again.", "unauthorized");
    nonces.delete(m[1]); // single use: a failed signature burns it too
    const t = now();
    if (rec.expiresAt <= t) throw new HttpError(401, "This sign-in request expired. Start again.", "unauthorized");
    if (rec.issuedAt > t + FUTURE_SKEW_MS) throw new HttpError(401, "Clock mismatch. Start again.", "unauthorized");
    if (message !== rec.message) throw new HttpError(401, "The message is not the one this node issued (wrong domain or altered text).", "unauthorized");
    if (address !== undefined && address.toLowerCase() !== rec.address) throw new HttpError(401, "This request was issued for a different address.", "unauthorized");
    let signer;
    try { signer = E.verifyMessage(message, signature); } catch { throw new HttpError(401, "Invalid signature.", "unauthorized"); }
    if (signer.toLowerCase() !== rec.address) throw new HttpError(401, "The signature does not match this address. Smart-contract wallets (EIP-1271) are not supported: use a normal account (EOA).", "unauthorized");
    return { address: signer, role: admins.has(rec.address) ? "admin" : "user" };
  }

  /** check() behind the failure counters: 5 failures lock a client, 60 lock everybody, both for 10 minutes. */
  function redeem(input, who = "?") {
    const t = now(), f = fails.get(who) ?? { n: 0, until: 0 };
    if (f.until > t || globalFails.until > t) throw Object.assign(new HttpError(429, "Too many attempts. Try again later.", "rate_limited"), { retryAfter: 600 });
    try { const r = check(input ?? {}); fails.delete(who); return r; }
    catch (e) {
      if (!(e instanceof HttpError) || e.status >= 500) throw e;
      f.n += 1; if (f.n >= 5) { f.until = t + LOCK_MS; f.n = 0; }
      fails.set(who, f); if (fails.size > 1000) fails.clear();
      globalFails.n += 1; if (globalFails.n >= 60) { globalFails = { n: 0, until: t + LOCK_MS }; log("warn", "wallet sign-in globally locked for 10 min"); }
      log("warn", "wallet sign-in failed", { status: e.status });
      throw e;
    }
  }

  const json = (req) => { if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "send application/json"); return readJson(req, 4096); };
  const only = (req, method) => { if (req.method !== method) throw new HttpError(405, method + " only"); };
  /** profile view of a signed-in address (gateway on only): { username, needsName } */
  const profileOf = (address) => { if (!accounts || !address) return {}; const a = accounts.byWallet(address); return { username: a?.username ?? null, needsName: !a?.username }; };
  const limited = (map, who, max) => { if (!allow(map, who, 600_000, max)) throw new HttpError(429, "Too many requests. Try again in a few minutes.", "rate_limited"); };
  const fail = (e) => { if (e instanceof HttpError) throw e; throw new HttpError(e.code === "name_taken" || e.code === "name_set" ? 409 : 400, e.message, e.code ?? "invalid_request_error"); };

  async function handle(req, res, path, url) {
    if (path === "/auth/nonce") {
      only(req, "GET"); assertOrigin(req);
      return send(res, 200, issue(url?.searchParams.get("address") ?? "", client(req)));
    }
    if (path === "/auth/verify") {
      only(req, "POST"); assertOrigin(req);
      const body = await json(req);
      let r;
      try { r = redeem(body && typeof body === "object" ? body : {}, client(req)); }
      catch (e) { if (e.retryAfter) res.setHeader("retry-after", String(e.retryAfter)); throw e; }
      let prof = {};
      if (accounts) { try { accounts.ensure(r.address); } catch (e) { fail(e); } prof = profileOf(r.address); }
      const { cookie, exp } = mint(r.role, r.address.toLowerCase());
      log("info", "wallet sign-in ok", { role: r.role });
      return send(res, 200, { address: r.address, role: r.role, expiresAt: exp, ...prof }, { "set-cookie": cookie });
    }
    if (path === "/auth/session") {
      only(req, "GET");
      const s = session(req);
      return send(res, 200, s ? { signedIn: true, role: s.role, ...(s.address ? { address: E ? E.getAddress(s.address) : s.address, ...profileOf(s.address) } : {}), expiresAt: s.exp } : { signedIn: false });
    }
    if (path === "/auth/logout") {
      only(req, "POST"); assertOrigin(req);
      revoke(req);
      return send(res, 200, { ok: true }, { "set-cookie": clearCookie });
    }
    if (accounts && path === "/auth/username") { // the username profile (gateway on): a name check for anyone, setting the name needs a wallet session
      if (req.method === "GET") { limited(profileReads, client(req), 60); return send(res, 200, accounts.checkName(url?.searchParams.get("name") ?? "")); }
      only(req, "PUT"); assertOrigin(req);
      limited(profileWrites, client(req), 10);
      const s = session(req); if (!s?.address) throw new HttpError(401, "Sign in with your wallet first.", "unauthorized");
      const body = await json(req);
      try { const a = accounts.ensure(s.address); return send(res, 200, accounts.setUsername(a.id, body.username)); } catch (e) { fail(e); }
    }
    throw new HttpError(404, "Not Found");
  }

  return { handle, issue, redeem, size: () => nonces.size };
}
