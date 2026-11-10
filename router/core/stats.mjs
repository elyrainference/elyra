// Dashboard statistics derived from state.routes / state.ledger (24 h totals, 14-day series, earnings). Read-only.
import { usd } from "../policy.mjs";
import { DAY } from "./limits.mjs";

/** USD paid in the last 24 h (rolling): ledger spend entries, the source of truth for the daily spend cap (chat.mjs) and /api/status. */
export const spentLast24h = (state, now = Date.now()) => usd(state.ledger.reduce((a, e) => (e.type === "spend" && now - e.ts < DAY ? a + e.amount : a), 0));

export function createStats({ state }) {
  return function stats() {
    const now = Date.now();
    const day = state.routes.filter((r) => now - r.ts < DAY);
    const out = day.filter((r) => r.dir === "out"), inn = day.filter((r) => r.dir === "in");
    const sum = (a, f) => a.reduce((x, r) => x + f(r), 0);
    const series = (dir) => {
      const a = Array(14).fill(0), t = Array(14).fill(0);
      for (const r of state.routes) {
        if (r.dir !== dir) continue;
        const d = 13 - Math.floor((now - r.ts) / DAY);
        if (d >= 0 && d < 14) { a[d]++; t[d] += r.p + r.c; }
      }
      return { requests: a, tokens: t };
    };
    const unsettled = state.ledger.filter((e) => !e.settled && !e.simulated);
    return {
      requests24h: out.length, tokens24h: sum(out, (r) => r.p + r.c), spend24h: usd(sum(out, (r) => r.amount)),
      served24h: inn.length, servedTokens24h: sum(inn, (r) => r.p + r.c), earned24h: usd(sum(inn, (r) => r.amount)),
      ok24h: out.length ? out.filter((r) => r.ok).length / out.length : null,
      avgTps: (() => { const m = out.filter((r) => !r.simulated && r.tps > 0); return m.length ? +(sum(m, (r) => r.tps) / m.length).toFixed(1) : null; })(),
      series: { out: series("out"), in: series("in") },
      earnDaily: (() => { const d = Array(14).fill(0); for (const e of state.ledger) { if (e.type !== "earn") continue; const i = 13 - Math.floor((now - e.ts) / DAY); if (i >= 0 && i < 14) d[i] += e.amount; } return d.map((v) => +v.toFixed(8)); })(),
      earnedTotal: usd(state.ledger.filter((e) => e.type === "earn").reduce((a, e) => a + e.amount, 0)),
      spentTotal: usd(state.ledger.filter((e) => e.type === "spend").reduce((a, e) => a + e.amount, 0)),
      unsettled: { spend: usd(unsettled.filter((e) => e.type === "spend").reduce((a, e) => a + e.amount, 0)), earn: usd(unsettled.filter((e) => e.type === "earn").reduce((a, e) => a + e.amount, 0)) },
    };
  };
}
