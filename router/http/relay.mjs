// Relay (opt-in, ELYRA_RELAY=1): lets a seller that cannot accept inbound connections (home router, CGNAT) be reached anyway.
//   seller --POST /relay/wait (long poll, signed)--> relay      <-- buyer: POST|GET /r/<sellerId>/p2p/<hello|infer|voucher>
//   seller <-- a queued job (method, path, body) -- relay       seller runs it against its OWN /p2p handler and streams the answer back:
//   seller --POST /relay/reply?job=<id> (signed, streamed)--> relay --> the waiting buyer
// The seller always dials out, so no port forwarding is needed. Traffic through here is already sealed to the seller's key by the peer
// protocol (request and response), so the relay sees sizes, timing and IPs, never prompts. Everything is bounded: sellers, queue, in-flight
// jobs, body sizes, waits. A seller proves it owns an id (= sha256(public key)[:16]) by signing every poll and reply.
import crypto from "node:crypto";
import { HttpError } from "../lib/errors.mjs";
import { canon, sha } from "../lib/canon.mjs";
import { inc } from "../obs.mjs";
import { readJson, send } from "./io.mjs";

/** the only things a relay will carry, and the only things a seller will run for it (a relay must never reach /api or /v1 of a seller) */
export const RELAY_PATHS = { "/p2p/hello": { methods: ["GET", "POST"], limit: 100_000 }, "/p2p/infer": { methods: ["POST"], limit: 8_000_000 }, "/p2p/voucher": { methods: ["POST"], limit: 20_000 } };
export const idOfPub = (pub) => sha(Buffer.from(pub, "base64")).slice(0, 16);
export function verifySigned(pub, obj, sig) {
  try { return crypto.verify(null, Buffer.from(canon(obj)), crypto.createPublicKey({ key: Buffer.from(pub, "base64"), format: "der", type: "spki" }), Buffer.from(sig, "base64")); } catch { return false; }
}
const PASS = ["content-type", "cache-control", "x-elyra-protocol"]; // response headers a seller may set on the buyer's answer

export function createRelay({ env = process.env, now = Date.now, limits = {} } = {}) {
  if (env.ELYRA_RELAY !== "1") return { enabled: false, owns: () => false };
  const L = { maxSellers: 100, waitMs: 25_000, graceMs: 5_000, sellerTtlMs: 60_000, headMs: 120_000, maxQueue: 16, maxInflight: 8, skewMs: 30_000, ...limits };
  const sellers = new Map(); // id -> { pub, seen, waiter, queue: [], inflight: 0 }
  const jobs = new Map();    // jobId -> { seller, res, timer, started }
  const nonces = new Map();  // nonce -> expiry (replay guard)

  const fresh = (ts, nonce) => {
    if (!Number.isFinite(ts) || Math.abs(now() - ts) > L.skewMs || typeof nonce !== "string" || nonce.length < 8 || nonce.length > 64) return false;
    for (const [k, exp] of nonces) if (exp < now()) nonces.delete(k);
    if (nonces.has(nonce) || nonces.size > 20_000) return false;
    nonces.set(nonce, now() + 2 * L.skewMs); return true;
  };
  // a seller is reachable while it has a poll open, or for a few seconds after one ended (a healthy client re-polls within milliseconds)
  const alive = (s) => !!s.waiter || now() - s.seen < L.graceMs;
  const prune = () => { for (const [id, s] of sellers) if (!s.waiter && !s.inflight && now() - s.seen > L.sellerTtlMs) sellers.delete(id); };
  const owns = (p) => p.startsWith("/relay/") || /^\/r\/[0-9a-f]{16}\/p2p\//.test(p);

  /** seller long poll: answers 200 with one job, or 204 after waitMs */
  async function wait(req, res) {
    const b = await readJson(req, 2000);
    if (typeof b.pub !== "string" || b.pub.length > 200) throw new HttpError(400, "pub required");
    const id = idOfPub(b.pub);
    if (!verifySigned(b.pub, { t: "relay-wait", id, ts: b.ts, nonce: b.nonce }, String(b.sig)) || !fresh(b.ts, b.nonce)) throw new HttpError(401, "bad signature", "unauthorized");
    let s = sellers.get(id);
    if (!s) { prune(); if (sellers.size >= L.maxSellers) throw new HttpError(503, "this relay is full", "busy"); s = { pub: b.pub, seen: 0, waiter: null, queue: [], inflight: 0 }; sellers.set(id, s); }
    s.seen = now();
    if (b.quick === true) return res.writeHead(204).end(); // first poll of a client: register now, so it can tell it is connected without sitting through a full poll
    if (s.waiter) { clearTimeout(s.waiter.timer); s.waiter.res.writeHead(204).end(); s.waiter = null; } // a newer poll replaces an older one
    while (s.queue.length && !jobs.has(s.queue[0].id)) s.queue.shift();
    if (s.queue.length) return deliver(s, s.queue.shift(), res);
    const timer = setTimeout(() => { s.waiter = null; s.seen = now(); res.writeHead(204).end(); }, L.waitMs);
    s.waiter = { res, timer };
    res.on("close", () => { if (s.waiter?.res === res) { clearTimeout(timer); s.waiter = null; s.seen = now(); } });
  }
  function deliver(s, j, res) { send(res, 200, { job: j.id, method: j.method, path: j.path, ctype: j.ctype, body: j.body.toString("base64") }); }

  /** buyer side: /r/<id>/p2p/... becomes a job for that seller */
  async function forward(req, res, path) {
    const m = /^\/r\/([0-9a-f]{16})(\/p2p\/[a-z]+)$/.exec(path);
    const spec = m && RELAY_PATHS[m[2]];
    if (!spec || !spec.methods.includes(req.method)) throw new HttpError(spec ? 405 : 404, spec ? "method not allowed" : "no such p2p endpoint");
    const s = sellers.get(m[1]);
    if (!s || !alive(s)) { inc("elyra_relay_jobs_total", { outcome: "offline" }); throw new HttpError(502, "that seller is offline right now", "seller_offline"); }
    if (s.queue.length >= L.maxQueue || s.inflight >= L.maxInflight) { inc("elyra_relay_jobs_total", { outcome: "busy" }); res.setHeader("retry-after", "5"); throw new HttpError(503, "that seller is busy", "busy"); }
    s.inflight++; let released = false;
    const release = () => { if (!released) { released = true; s.inflight--; } };
    try {
      let size = 0; const chunks = [];
      try {
        for await (const c of req) { size += c.length; if (size > spec.limit) throw new HttpError(413, "body too large"); chunks.push(c); }
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, "request aborted");
      }
      const job = { id: crypto.randomBytes(12).toString("hex"), method: req.method, path: m[2], ctype: String(req.headers["content-type"] ?? "application/json").slice(0, 100), body: Buffer.concat(chunks) };
      const unqueue = () => { const i = s.queue.indexOf(job); if (i >= 0) s.queue.splice(i, 1); };
      const rec = { seller: m[1], res, release, started: now(), timer: setTimeout(() => { jobs.delete(job.id); unqueue(); inc("elyra_relay_jobs_total", { outcome: "timeout" }); if (!res.headersSent) { try { send(res, 504, { error: { message: "the seller did not answer in time", type: "timeout" } }); } catch { /* gone */ } } release(); }, L.headMs) };
      jobs.set(job.id, rec);
      res.on("close", () => { clearTimeout(rec.timer); jobs.delete(job.id); unqueue(); release(); });
      if (s.waiter) { const w = s.waiter; s.waiter = null; clearTimeout(w.timer); deliver(s, job, w.res); } else s.queue.push(job);
    } catch (e) { release(); throw e; }
  }

  /** seller side: the streamed answer. First line = JSON head, the rest = raw body */
  async function reply(req, res, url) {
    const jobId = url.searchParams.get("job") ?? "";
    const rec = jobs.get(jobId); const h = req.headers;
    const pub = String(h["x-relay-pub"] ?? "");
    if (!rec) throw new HttpError(410, "no such job (it timed out or the buyer left)");
    const s = sellers.get(rec.seller);
    if (!s || s.pub !== pub || !verifySigned(pub, { t: "relay-reply", job: jobId, ts: Number(h["x-relay-ts"]), nonce: h["x-relay-nonce"] }, String(h["x-relay-sig"] ?? "")) || !fresh(Number(h["x-relay-ts"]), h["x-relay-nonce"])) throw new HttpError(401, "bad signature", "unauthorized");
    jobs.delete(jobId); clearTimeout(rec.timer);
    const buyer = rec.res; let buf = Buffer.alloc(0), headDone = false, gone = false;
    buyer.on("close", () => { if (!buyer.writableEnded) { gone = true; req.destroy(); } });
    try {
      for await (const c of req) {
        if (gone) break;
        if (!headDone) {
          buf = Buffer.concat([buf, c]); const nl = buf.indexOf(10);
          if (nl < 0) { if (buf.length > 8192) throw new Error("head too large"); continue; }
          const head = JSON.parse(buf.subarray(0, nl).toString("utf8")); const rest = buf.subarray(nl + 1);
          const status = Number(head?.status); if (!(status >= 200 && status <= 599)) throw new Error("bad status");
          const out = {}; for (const k of PASS) if (typeof head.headers?.[k] === "string") out[k] = head.headers[k].replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
          out["x-accel-buffering"] = "no"; buyer.writeHead(status, out); headDone = true;
          if (rest.length && !buyer.write(rest)) await new Promise((r) => buyer.once("drain", r));
        } else if (!buyer.write(c)) await new Promise((r) => buyer.once("drain", r));
      }
      if (!headDone) throw new Error("no head");
      buyer.end(); inc("elyra_relay_jobs_total", { outcome: "ok" }); send(res, 200, { ok: true });
    } catch (e) {
      if (!buyer.headersSent) { try { send(buyer, 502, { error: { message: "the seller's answer was malformed", type: "bad_gateway" } }); } catch { /* gone */ } } else buyer.end();
      inc("elyra_relay_jobs_total", { outcome: gone ? "buyer_left" : "error" });
      if (!res.writableEnded && !res.destroyed) { try { send(res, gone ? 410 : 400, { error: { message: "reply rejected" } } ); } catch { /* gone */ } }
    } finally { rec.release(); }
  }

  async function handle(req, res, path, url) {
    if (path === "/relay/wait" && req.method === "POST") return wait(req, res);
    if (path === "/relay/reply" && req.method === "POST") return reply(req, res, url);
    if (path.startsWith("/r/")) return forward(req, res, path);
    throw new HttpError(404, "no such relay endpoint");
  }
  return { enabled: true, owns, handle, stats: () => ({ sellers: [...sellers.values()].filter(alive).length, jobs: jobs.size }) };
}
