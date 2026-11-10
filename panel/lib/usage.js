// Usage numbers for the Home dashboard, derived ONLY from what the API already returns: /api/status stats (14 rolling 24 h buckets, the last one
// is "the last 24 h", the one before it "the 24 h before that") and /api/routes (the newest 60 routes with timestamps). Nothing is estimated:
// when the data cannot answer a question (a period before the log began, an hourly view over more than 60 routes) the result says so (null / full: false).
// Pure: no DOM, no I/O.
const H = 3600e3, DAY = 24 * H;

/** Is the route log complete? /api/routes returns at most 60 routes, newest first: fewer than 60 means that is the whole log. */
export const logIsFull = (routes) => routes.length < 60;

/** Last 24 h in 24 hourly buckets (index 23 = the current hour) for one direction ("out" = consumed, "in" = served). `full` is false when the
 *  60-route window starts after the 24 h window does (older hours are then missing, not zero). */
export function hourly(routes, dir, now = Date.now()) {
  const requests = Array(24).fill(0), tokens = Array(24).fill(0);
  for (const r of routes) {
    if (r.dir !== dir) continue;
    const i = 23 - Math.floor((now - r.ts) / H);
    if (i >= 0 && i < 24) { requests[i]++; tokens[i] += r.p + r.c; }
  }
  return { requests, tokens, full: logIsFull(routes) || routes[routes.length - 1].ts <= now - DAY };
}

/** Last `n` days of a 14-day series (n = 7 or 14). */
export const lastDays = (series, n) => ({ requests: series.requests.slice(-n), tokens: series.tokens.slice(-n) });

/** Money out/in per rolling 24 h bucket (14, last = now), or null when the log is not complete (the status API has no spend series). */
export function amountDaily(routes, dir, now = Date.now()) {
  if (!logIsFull(routes)) return null;
  const a = Array(14).fill(0);
  for (const r of routes) { const i = 13 - Math.floor((now - r.ts) / DAY); if (r.dir === dir && i >= 0 && i < 14) a[i] += r.amount; }
  return a;
}

/** { cur, prev } for the last 24 h and the 24 h before it, from a 14-bucket series; prev is null when the bucket is missing. */
export const lastTwo = (a) => (a ? { cur: a[13], prev: a[12] ?? null } : null);

/** Percent change cur vs prev: null (unknown), "new" (prev was 0), or a rounded number. */
export function change(cur, prev) {
  if (prev == null) return null;
  if (prev === 0) return cur === 0 ? 0 : "new";
  return Math.round(((cur - prev) / prev) * 100);
}
