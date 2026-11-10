// What a peer says about itself is untrusted input: only the identity, box key and wallet are signed. Everything else (name, models,
// prices, gossip list, chain facts) is the peer's claim and may be hostile: wrong types, huge, or markup. This module turns a hello into
// plain, bounded data and drops anything that is not valid; the rest of the node only ever sees the clean copy.
// control characters, line separators, zero-width and bidi override characters (these reorder or hide text on screen: "evil.com" can be made to read as something else)
const CTRL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const str = (v, max) => (typeof v === "string" ? v.replace(CTRL, " ").trim().slice(0, max) : "");
const num = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

export const LIMITS = { models: 200, modelId: 120, name: 60, version: 32, gossip: 20, url: 300 };
const TEE = new Set(["none", "claimed", "demo"]);

/** one advertised model: needs a string id and a plain non-negative price, otherwise it is dropped (a model nobody can price cannot be bought) */
export function cleanModel(m) {
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const id = str(m.id, LIMITS.modelId);
  const price = num(m.price, 0, 1_000_000);
  if (!id || price === null) return null;
  const out = { id, price };
  const tps = num(m.tps, 0, 100_000); if (tps !== null) out.tps = tps;
  if (typeof m.tee === "string" && TEE.has(m.tee)) out.tee = m.tee;
  if (m.demo === true) out.demo = true;
  return out;
}

export function cleanModels(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set(), out = [];
  for (const m of list.slice(0, LIMITS.models * 2)) {
    const c = cleanModel(m);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id); out.push(c);
    if (out.length >= LIMITS.models) break;
  }
  return out;
}

/** settlement facts a peer claims: only the escrow address text and the network label are used elsewhere */
export function cleanChain(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const escrow = str(c.escrow, 64);
  if (!/^0x[0-9a-fA-F]{40}$/.test(escrow)) return null;
  const out = { network: str(c.network, 40), escrow };
  const cap = num(c.maxDepositUsd, 0, 1_000_000_000); if (cap !== null) out.maxDepositUsd = cap;
  return out;
}

/** peer URLs offered for gossip: a short list of short strings (the caller still applies the URL and SSRF rules) */
export function cleanGossip(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((u) => typeof u === "string" && u.length <= LIMITS.url).slice(0, LIMITS.gossip);
}

export function cleanHello(h) {
  return {
    name: str(h.name, LIMITS.name) || "peer", providing: h.providing === true, models: cleanModels(h.models),
    version: str(h.version, LIMITS.version), chain: cleanChain(h.chain), peers: cleanGossip(h.peers),
  };
}
