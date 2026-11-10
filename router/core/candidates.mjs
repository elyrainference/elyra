// Candidate discovery and the routing plan: every way to serve a model right now (own upstreams, online real peers,
// simulated catalog) and the ranked list for a request. Ranking maths lives in policy.mjs; this module only gathers.
import { cleanModels } from "../lib/peer-hello.mjs";
import { uptimeOf, withUptime } from "./reputation.mjs";
import { guessLogo } from "../catalog.mjs";
import { isAuto, rank } from "../policy.mjs";
import { isLocalUrl } from "../lib/url.mjs";
import { createSettlement } from "./settlement.mjs";

export function createMarket({ state, identity, chain }, { catalog, upstreams, repOf, upstreamUp = () => true, settlement = createSettlement({ state, chain }) }) {
  function candidates() {
    const out = [];
    for (const up of upstreams()) {
      if (up.kind === "demo" && state.settings.demoNetwork === false) continue; // a real node (--no-demo) does not offer the built-in stub model to buyers
      if (!upstreamUp(up.id)) continue; // not answering: do not offer it (see upstreams.mjs health)
      const remote = up.remote === true; // an SSH tunnel or VPN to a machine that is not this one: looks local, is not
      const local = up.kind === "demo" || (isLocalUrl(up.baseUrl) && !remote);
      for (const m of up.models ?? []) {
        const s = state.stats[`self:${up.id}:${m}`];
        out.push({
          key: `self:${up.id}:${m}`, kind: "self", sourceId: up.id, peerId: identity.id, peerName: `${remote ? "REMOTE GPU" : local ? "SELF" : "YOUR KEY"} — ${up.name}`, hosted: !local && !remote, remote,
          model: m, logo: guessLogo(m), price: up.modelPrices?.[m] ?? up.price ?? 0, tps: s?.tps || 60, reputation: s ? repOf(s) : 5,
          tee: "none", private: local, privacyScore: local ? 1 : 0, simulated: up.kind === "demo", explicitOnly: up.kind === "demo",
        });
      }
    }
    for (const p of Object.values(state.peers)) {
      if (!p.online || !p.providing || !p.box) continue;
      if (!settlement.compatible(p)) continue; // both sides must settle the same way (same escrow); api /status explains it when a seller is skipped here
      for (const m of cleanModels(p.models)) {
        const key = `peer:${p.id}:${m.id}`;
        const s = state.stats[key];
        const verified = !!(p.attest?.ok && p.attest.exp > Date.now());
        const claimedTee = !!(m.tee && m.tee !== "none");
        const tee = verified && claimedTee ? "verified" : claimedTee ? "claimed" : "none";
        out.push({
          key, kind: "peer", sourceId: p.id, peerId: p.id, peerName: p.name, model: m.id, logo: guessLogo(m.id),
          price: m.price, tps: s?.tps || m.tps || 50, reputation: withUptime(s ? repOf(s) : 4.3, uptimeOf(p)), uptime: uptimeOf(p), ttft: s?.ttft || null,
          tee, private: tee === "verified", privacyScore: tee === "verified" ? 0.95 : tee === "claimed" ? 0.3 : 0, attest: p.attest ?? null, simulated: false, explicitOnly: !!m.demo, rtt: p.rtt,
        });
      }
    }
    if (state.settings.demoNetwork) {
      const t = Date.now() / 1000;
      const byId = Object.fromEntries(catalog.peers.map((p) => [p.id, p]));
      for (const l of catalog.listings) {
        const p = byId[l.peerId];
        const jitter = 1 + 0.06 * Math.sin(t / 40 + l.price * 97);
        out.push({
          key: `sim:${l.peerId}:${l.model}`, kind: "sim", sourceId: l.peerId, peerId: l.peerId, peerName: p.name, model: l.model,
          logo: l.logo, vendor: l.vendorName, price: l.price, tps: Math.round(l.tps * jitter), reputation: l.reputation, ctx: l.ctx,
          tee: l.tee, private: false, privacyScore: l.tee !== "none" ? 0.3 : 0, simulated: true, region: p.region, peerKind: p.kind, // demo "TEE" is never private: only a verified attestation or a local model is
        });
      }
    }
    return out;
  }

  /** Ranked route options for a requested model. Demo engine only serves when asked by name or nothing else exists; simulated peers only when nothing live matches. */
  function plan(model) {
    let ranked = rank(candidates(), state.policy, model);
    if (isAuto(model)) {
      const real = ranked.filter((c) => !c.explicitOnly);
      if (real.length) ranked = real;
    }
    // A live listing (own source or real peer) always beats the simulated market inside one request's candidate set:
    // the demo market only answers when nothing real can, so a user who connected Ollama never gets canned text from `auto`.
    const live = ranked.filter((c) => !c.simulated);
    if (live.length) ranked = live;
    return ranked;
  }

  return { candidates, plan };
}
