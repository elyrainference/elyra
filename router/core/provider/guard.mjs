// Provider request admission that needs no chain access: per-consumer rate limit, consumer identity binding,
// per-request signature (the sealing key is public, so without it anyone could speak as `consumer`) and replay protection.
import { canon, sha } from "../../lib/canon.mjs";
import { HttpError } from "../../lib/errors.mjs";

export function createRequestGuard({ identity }) {
  // per-consumer token bucket (requests per minute) so one caller cannot starve a provider
  const buckets = new Map();
  const allow = (id, perMin) => {
    const now = Date.now();
    const b = buckets.get(id) ?? { n: 0, t: now };
    if (now - b.t > 60000) { b.n = 0; b.t = now; }
    buckets.set(id, b);
    if (buckets.size > 5000) buckets.clear();
    return ++b.n <= perMin;
  };

  const seenNonces = new Map(); // request nonce → expiry (replay protection)

  /** Throws HttpError unless `payload` (from the sealed envelope) is a fresh, correctly signed request from `wire.from`. */
  function authenticate(wire, payload) {
    const { consumer, model, body, auth } = payload ?? {};
    if (typeof consumer?.id !== "string" || typeof consumer?.pub !== "string" || consumer.pub.length > 200 || typeof model !== "string" || !model || !body || typeof body !== "object" || Array.isArray(body) || consumer.id !== wire.from) throw new HttpError(400, "bad request");
    if (sha(Buffer.from(consumer.pub, "base64")).slice(0, 16) !== consumer.id) throw new HttpError(400, "consumer id does not match key");
    if (!auth || !Number.isFinite(auth.ts) || Math.abs(Date.now() - auth.ts) > 60000 || typeof auth.nonce !== "string" || !auth.nonce || auth.nonce.length > 64 || typeof auth.sig !== "string" ||
        !identity.verify({ provider: identity.id, ts: auth.ts, nonce: auth.nonce, model, bodyHash: sha(canon(body)) }, auth.sig, consumer.pub)) throw new HttpError(401, "request not authenticated", "unauthenticated");
    const nowMs = Date.now();
    if (seenNonces.has(auth.nonce)) throw new HttpError(409, "request replayed", "replay");
    seenNonces.set(auth.nonce, nowMs + 180000);
    if (seenNonces.size > 20000) {
      for (const [k, exp] of seenNonces) if (exp < nowMs) seenNonces.delete(k);
      for (const k of seenNonces.keys()) { if (seenNonces.size <= 20000) break; seenNonces.delete(k); }
    }
  }

  return { allow, authenticate };
}
