// Private realtime feed: an in-memory ring buffer of what this node is doing (requests, peers, vouchers, alerts), the
// source of GET /api/events (SSE) and /api/events/recent. Nothing here is persisted and nothing leaves the owner's session.
//
// Privacy contract (AGENTS.md rules 3, 7, 11): an event is built ONLY from the whitelist in SCHEMA. Callers hand in whatever
// they have; every unknown key is dropped, every value is coerced to its declared type, strings are length-capped and stripped
// of control characters, and anything shaped like a secret is discarded. Prompts, completions, keys, API keys, tx payloads
// and IP addresses have no field, so they cannot be emitted by accident. Wallets and tx hashes are shortened here.
export const RING_MAX = 200;

const REASONS = new Set(["spend_cap", "unfunded", "no_route", "rate_limited", "busy", "payment_required", "denied", "no_model", "price_mismatch", "upstream_error", "unauthenticated", "bad_request", "replay", "other"]);
const ALERTS = new Set(["spend_cap", "low_gas", "upstream_down"]);

// shaped like a secret: provider API keys, bearer tokens, PEM blocks, a full 32-byte hex key / tx payload, a full address
const SECRETISH = /\bsk-[\w-]{12,}|\bbearer\s+\S{8,}|-----BEGIN|\b0x[0-9a-f]{40,}\b/i;

const str = (max, re) => (v) => {
  if (typeof v !== "string") return undefined;
  const s = v.slice(0, 2000).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").trim(); // inspect the whole value before cutting: a truncated key would no longer look like one
  return s && !SECRETISH.test(s) && (!re || re.test(s)) ? s.slice(0, max) : undefined;
};
const int = (max) => (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : undefined);
const usd = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e9 ? Math.round(v * 1e8) / 1e8 : undefined);
const bool = (v) => (typeof v === "boolean" ? v : undefined);
const oneOf = (list) => { const s = new Set(list); return (v) => (typeof v === "string" && s.has(v) ? v : undefined); };
const hexShort = (len, head) => { const re = new RegExp(`^0x[0-9a-fA-F]{${len}}$`); return (v) => (typeof v === "string" && re.test(v) ? `${v.slice(0, head)}…${v.slice(-4)}` : undefined); };
const wallet = hexShort(40, 6), tx = hexShort(64, 10);
const model = str(80, /^[\w.:/@+-]+$/); // an id, never free text: a prompt smuggled into `model` has spaces and punctuation and is dropped

const SCHEMA = {
  request: {
    required: ["role", "status"],
    fields: { role: oneOf(["buyer", "seller"]), peer: str(40), model, promptTokens: int(1e9), completionTokens: int(1e9), costUsd: usd, ttftMs: int(1e7), latencyMs: int(1e7), status: oneOf(["ok", "error", "refused"]), simulated: bool, counterparty: wallet, reason: oneOf(REASONS) },
  },
  peer: { required: ["state", "name"], fields: { state: oneOf(["online", "offline", "discovered"]), name: str(40), viaRegistry: bool, rttMs: int(1e6) } },
  voucher: { required: ["action"], fields: { action: oneOf(["issued", "received", "redeemed"]), amountUsd: usd, tx, counterparty: wallet, peer: str(40) } },
  alert: { required: ["code"], fields: { code: oneOf(ALERTS), subject: str(60), capUsd: usd, spentUsd: usd } },
};

/** The only way an event is built. Returns a plain object without id/ts, or null when the kind is unknown or a required field is missing/invalid. */
export function sanitize(kind, raw) {
  const spec = SCHEMA[kind];
  if (!spec || !raw || typeof raw !== "object") return null;
  const out = {};
  for (const [k, clean] of Object.entries(spec.fields)) {
    if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
    const v = clean(raw[k]);
    if (v !== undefined) out[k] = v;
  }
  if (spec.required.some((k) => out[k] === undefined)) return null;
  if (kind === "request" && out.role !== "seller") delete out.counterparty; // a buyer has no counterparty wallet to show: only a seller learns who pays it
  return out;
}

export function createEvents({ max = RING_MAX } = {}) {
  const ring = [];
  const listeners = new Set();
  const gate = new Map(); // throttle key -> last emit time (bounded)
  let seq = 0;

  /** true at most once per `ms` for this key: keeps a flapping upstream, a capped buyer or a spamming stranger from filling the ring */
  const quiet = (key, ms) => {
    const now = Date.now();
    if (now - (gate.get(key) ?? 0) < ms) return true;
    if (gate.size >= 500) gate.clear();
    gate.set(key, now);
    return false;
  };

  function emit(kind, raw) {
    let body;
    try { body = sanitize(kind, raw); } catch { return null; }
    if (!body) return null;
    if (kind === "alert" && quiet(`alert|${body.code}|${body.subject ?? ""}`, 60_000)) return null;
    if (kind === "request" && body.role === "seller" && body.status !== "ok" && quiet(`seller|${body.peer ?? ""}|${body.reason ?? ""}`, 5_000)) return null;
    const ev = Object.freeze({ id: ++seq, ts: Date.now(), kind, ...body });
    ring.push(ev);
    if (ring.length > max) ring.splice(0, ring.length - max);
    for (const fn of [...listeners]) { try { fn(ev); } catch { /* one broken listener never blocks the feed or the request path */ } }
    return ev;
  }

  return {
    emit,
    request: (f) => emit("request", f),
    peer: (f) => emit("peer", f),
    voucher: (f) => emit("voucher", f),
    alert: (f) => emit("alert", f),
    /** oldest first, at most `max` */
    recent: () => ring.slice(),
    /** events newer than `id`; an id from before a restart (greater than anything issued) replays the whole ring */
    since: (id) => (id > seq ? ring.slice() : ring.filter((e) => e.id > id)),
    lastId: () => seq,
    /** `fn(event)` per new event; returns the unsubscribe function */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    listenerCount: () => listeners.size,
  };
}

/** Same surface, records nothing: the default for modules built without a node (unit tests). */
export const nullEvents = Object.freeze({ emit: () => null, request: () => null, peer: () => null, voucher: () => null, alert: () => null });
