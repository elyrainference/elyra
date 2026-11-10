// Data for the stats pages. Everything here is measured: the market comes from this node's /pub/market and /pub/info, the history from
// GET /pub/stats (per-day counters the node keeps itself). There is no generated or sample data in this section. When something has not
// been measured yet the pages say so (empty state) instead of showing a number.
import { state } from "./lib.js";

// ---- history: GET /pub/stats ----
export const history = { data: null, status: "loading" }; // status: loading | ok | missing | error
export async function loadHistory() {
  try {
    const r = await fetch("/pub/stats", { cache: "no-store" });
    if (r.status === 404) { history.status = "missing"; history.data = null; return history; }
    if (!r.ok) throw new Error(String(r.status));
    history.data = await r.json(); history.status = "ok";
  } catch { history.status = "error"; }
  return history;
}

/** the 30-day series as flat rows the charts can read; d is a Date at 00:00 UTC */
export function daily() {
  const s = history.data?.series;
  if (!Array.isArray(s)) return [];
  return s.map((r) => ({
    d: new Date(r.day + "T00:00:00Z"),
    visitor: r.pub?.requests || 0, routed: r.routed?.requests || 0, served: r.served?.requests || 0,
    visitorTok: r.pub?.tokens || 0, routedTok: r.routed?.tokens || 0, servedTok: r.served?.tokens || 0,
    earned: r.served?.usd || 0, spent: r.routed?.usd || 0,
    requests: (r.pub?.requests || 0) + (r.routed?.requests || 0) + (r.served?.requests || 0),
    tokens: (r.pub?.tokens || 0) + (r.routed?.tokens || 0) + (r.served?.tokens || 0),
  }));
}
export const total = (rows, k) => rows.reduce((a, r) => a + r[k], 0);
export const hasTraffic = (rows) => rows.some((r) => r.requests > 0);

// ---- market: one row per model, per seller, per (model, seller) ----
export function world() {
  const m = state.market, info = state.info, groups = m?.models || [];
  const offers = groups.flatMap((g) => g.offers.map((o) => ({ ...o, model: g.model, ref: g.reference || null })));
  const refAvg = (ref) => (ref && Number.isFinite(ref.inPerM) && Number.isFinite(ref.outPerM) ? (ref.inPerM + ref.outPerM) / 2 : null);

  const services = offers.map((o) => {
    const avg = refAvg(o.ref);
    return {
      key: o.model + "\u0000" + o.seller, model: o.model, seller: o.seller, where: o.where, operator: o.operator, privacy: o.privacy, chat: !!o.chat,
      price: o.price, list: avg, save: avg && o.price != null ? (1 - o.price / avg) * 100 : null,
      speed: typeof o.speed === "number" ? o.speed : null, speedBasis: o.speedBasis, ttft: o.ttftMs ?? null, uptime: o.uptime ?? null,
      rep: o.reputation?.score ?? null, requests: o.reputation?.requests || 0, free: o.price === 0,
    };
  });

  const models = groups.map((g) => {
    const avg = refAvg(g.reference);
    return { name: g.model, sellers: g.sellers, cheapest: g.cheapest, fastest: g.fastest, list: avg, save: avg && g.cheapest != null ? (1 - g.cheapest / avg) * 100 : null, chat: !!g.chat, priv: !!g.private, free: g.cheapest === 0, requests: g.offers.reduce((s, o) => s + (o.reputation?.requests || 0), 0), ref: g.reference || null };
  });

  const by = new Map();
  for (const s of services) {
    const x = by.get(s.seller) || { name: s.seller, operator: s.operator, where: s.where, models: 0, price: null, speed: null, ttft: null, uptime: null, rep: null, requests: 0, measured: 0 };
    x.models++; x.requests += s.requests;
    if (s.price != null && (x.price == null || s.price < x.price)) x.price = s.price;
    if (s.speed != null) { x.measured++; if (x.speed == null || s.speed > x.speed) x.speed = s.speed; }
    if (s.ttft != null && (x.ttft == null || s.ttft < x.ttft)) x.ttft = s.ttft;
    if (s.uptime != null) x.uptime = x.uptime == null ? s.uptime : Math.min(x.uptime, s.uptime);
    if (s.rep != null && (x.rep == null || s.rep > x.rep)) x.rep = s.rep;
    by.set(s.seller, x);
  }
  return { m, info, offers, services, models, sellers: [...by.values()] };
}
