// What this node offers to peers right now (advertised in /p2p/hello and enforced in serve).
// The `tee` label is honest: "claimed" only when this node is attested AND the upstream is local to the workload.
import { isLocalUrl } from "../../lib/url.mjs";

/** Per-model prices: {model: usd per million tokens}. Anything that is not a plain non-negative number for a string key is dropped. */
export function cleanPrices(input) {
  const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [k, v] of Object.entries(input).slice(0, 300)) {
    const n = typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN; // null, "", booleans and objects are not prices (Number(null) would be a free model)
    if (k && k.length <= 120 && Number.isFinite(n) && n >= 0 && n <= 1_000_000) out[k] = n;
  }
  return out;
}

export function createProvideModels({ state, teeMode }, { upstreams = () => [], upstreamById, upstreamUp = () => true, tee }) {
  function activeUpstreams() {
    if (!state.provide.enabled) return [];
    const P = state.provide;
    if (P.upstreamId === "*" && !(Array.isArray(P.upstreamIds) && P.upstreamIds.length)) {
      return upstreams().filter((u) => u && u.kind !== "demo" && isLocalUrl(u.baseUrl) && upstreamUp(u.id));
    }
    const ids = Array.isArray(P.upstreamIds) && P.upstreamIds.length ? P.upstreamIds : [P.upstreamId];
    return ids.map(upstreamById).filter((u) => u && (u.kind === "demo" || upstreamUp(u.id)));
  }

  function entries() {
    const allow = state.provide.models ?? [];
    const seen = new Set();
    const out = [];
    for (const up of activeUpstreams()) {
      for (const m of up.models ?? []) {
        if ((allow.length && !allow.includes(m)) || seen.has(m)) continue;
        seen.add(m);
        out.push({ up, m });
      }
    }
    return out;
  }

  function provideModels() {
    return entries().map(({ up, m }) => {
      const local = up.kind === "demo" || (isLocalUrl(up.baseUrl) && !up.remote);
      return {
        id: m,
        price: state.provide.prices?.[m] ?? state.provide.price,
        tee: !local ? "none" : tee.active() ? "claimed" : teeMode ? "none" : state.provide.tee,
        demo: up.kind === "demo" || undefined,
        tps: Math.round(state.stats[`self:${up.id}:${m}`]?.tps || 0) || undefined,
      };
    });
  }
  provideModels.upstreamFor = (model) => entries().find((e) => e.m === model)?.up ?? null;
  return provideModels;
}
