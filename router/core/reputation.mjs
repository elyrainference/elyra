// Per-route reputation and speed statistics (state.stats): success counts and EWMA of tokens/s, latency and time to first token,
// plus per-peer uptime from the periodic probes. Metadata only. Feeds candidate scoring; must not decide routing itself (see policy.mjs).

/** a peer needs this many probes (15 s apart: about five minutes) before its uptime is shown or used */
export const MIN_PROBES = 20;
/** count one probe of a peer; the window is bounded (about the last hour) so old history fades */
export function countProbe(peer, ok) {
  peer.probes = (peer.probes ?? 0) + 1; if (!ok) peer.misses = (peer.misses ?? 0) + 1;
  if (peer.probes > 240) { peer.probes = Math.round(peer.probes / 2); peer.misses = Math.round((peer.misses ?? 0) / 2); }
}
/** share of recent probes the peer answered, or null while there is too little data to say */
export const uptimeOf = (peer) => ((peer?.probes ?? 0) >= MIN_PROBES ? +(1 - (peer.misses ?? 0) / peer.probes).toFixed(3) : null);
/** a peer that is often away is worth less: full uptime keeps the score, none halves it; unknown uptime changes nothing */
export const withUptime = (score, uptime) => (uptime == null ? score : +(score * (0.5 + 0.5 * uptime)).toFixed(2));

export function createReputation({ state, save }) {
  const stat = (key) => (state.stats[key] ??= { ok: 0, fail: 0, tps: 0, lat: 0 });
  /** 0–5 score from a Bayesian-smoothed success rate */
  const repOf = (s) => +(5 * ((s.ok + 3) / (s.ok + s.fail + 3.5))).toFixed(2);
  function record(key, ok, tps, ms, ttft = 0) {
    const s = stat(key);
    if (ok) {
      s.ok++;
      if (tps > 0 && ms >= 150) s.tps = Math.min(2000, s.tps ? s.tps * 0.7 + tps * 0.3 : tps); // sub-150ms calls are too short to measure speed
      s.lat = s.lat ? s.lat * 0.7 + ms * 0.3 : ms;
      if (ttft > 0) s.ttft = s.ttft ? s.ttft * 0.7 + ttft * 0.3 : ttft; // streamed answers only: the wait before the first token
    } else s.fail++;
    save();
  }
  return { repOf, record };
}
