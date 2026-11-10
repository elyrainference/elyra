// Peer table and gossip: add a peer (operator-typed = trusted; gossip-learned = public hosts only, SSRF guard),
// refresh liveness every 15 s, mark peers offline after repeated failures. Message verification lives in hello.mjs.
import { nullEvents } from "./events.mjs";
import { countProbe } from "./reputation.mjs";
import { cleanChain, cleanGossip, cleanModels } from "../lib/peer-hello.mjs";
import { assertPublicUrl, normUrl } from "../lib/url.mjs";
import { inc, log } from "../obs.mjs";

export function createPeers({ opts, state, save, identity, publicUrl, every, events = nullEvents }, { helloInfo, fetchHello, peerFields }) {
  const isTrustedRelay = (url) => {
    try {
      const u = new URL(url);
      if (!/^\/r\/[0-9a-f]{16}$/.test(u.pathname)) return false;
      const p = new URL(publicUrl);
      const localHost = (h) => h === "localhost" || h === "127.0.0.1";
      if (u.origin === p.origin || (localHost(u.hostname) && localHost(p.hostname) && (u.port || "80") === (p.port || "80"))) return true;
      return Object.values(state.peers).some((peer) => {
        try { return new URL(peer.url).origin === u.origin; } catch { return false; }
      });
    } catch { return false; }
  };

  // a state file written by an older build may hold a peer entry the current rules would refuse: clean it once at start
  for (const p of Object.values(state.peers)) { p.models = cleanModels(p.models); p.chain = cleanChain(p.chain); p.name = typeof p.name === "string" ? p.name.slice(0, 60) : "peer"; }

  // gossip is the peers' claim: bound how much of it we act on at once (a hostile list must not turn this node into a request cannon)
  let gossipInflight = 0;
  const learn = (u, depth) => {
    if (gossipInflight >= 8) return;
    gossipInflight++;
    addPeer(u, depth, false).catch(() => {}).finally(() => { gossipInflight--; });
  };

  function announceTo(url) {
    fetch(url + "/p2p/hello", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(helloInfo()), signal: AbortSignal.timeout(3000) }).catch(() => {});
  }

  function announcePeers() {
    for (const p of Object.values(state.peers)) announceTo(p.url);
  }

  /** `trusted` = the operator typed it in (API/CLI seed); gossip-learned URLs get the public-host check.
   *  `extra.check(h)` (registry discovery) may reject a verified hello before the peer is stored; `extra.viaRegistry` tags the peer. */
  async function addPeer(rawUrl, depth = 0, trusted = depth === 0, extra = {}) {
    const url = normUrl(rawUrl);
    if (url === publicUrl) throw new Error("that is this node");
    if (!trusted && !isTrustedRelay(url)) await assertPublicUrl(url, opts.allowPrivatePeers);
    const { h, rtt, attest } = await fetchHello(url);
    if (h.id === identity.id) throw new Error("that is this node");
    extra.check?.(h);
    if (Object.keys(state.peers).length >= 200 && !state.peers[h.id]) {
      // never evict a live peer for a newcomer; a dead one makes room (otherwise a swarm of throwaway identities can lock everyone else out)
      const dead = Object.values(state.peers).filter((x) => !x.online).sort((a, b) => (a.lastSeen ?? 0) - (b.lastSeen ?? 0))[0];
      if (!dead) throw new Error("peer table full");
      delete state.peers[dead.id];
    }
    const prev = state.peers[h.id];
    state.peers[h.id] = { id: h.id, url, pubkey: h.pub, ...peerFields(h, attest), online: true, fails: 0, rtt, lastSeen: Date.now(), added: prev?.added ?? Date.now(), ...(extra.viaRegistry || prev?.viaRegistry ? { viaRegistry: true } : {}), probes: prev?.probes, misses: prev?.misses };
    const now = state.peers[h.id], seen = { name: now.name, viaRegistry: !!now.viaRegistry, rttMs: rtt };
    if (!prev) { inc("elyra_peer_events_total", { event: "added" }); log("info", "peer added", { peer: h.name, url }); events.peer({ state: "discovered", ...seen }); }
    else if (!prev.online) events.peer({ state: "online", ...seen });
    save();
    if (!prev) {
      announceTo(url);
      if (depth < 2) for (const u of cleanGossip(h.peers)) learn(u, depth + 1);
    }
    return state.peers[h.id];
  }

  async function refreshPeers() {
    await Promise.all(Object.values(state.peers).map(async (p) => {
      try {
        const { h, rtt, attest } = await fetchHello(p.url);
        if (h.id !== p.id) throw new Error("identity changed");
        const wasUp = p.online;
        Object.assign(p, peerFields(h, attest), { online: true, fails: 0, rtt, lastSeen: Date.now() }); countProbe(p, true);
        if (!wasUp) events.peer({ state: "online", name: p.name, viaRegistry: !!p.viaRegistry, rttMs: rtt });
        if ((state.provide.enabled || !/localhost|127\.0\.0\.1/.test(publicUrl)) && !cleanGossip(h.peers).includes(publicUrl)) announceTo(p.url);
        for (const u of cleanGossip(h.peers)) if (!Object.values(state.peers).some((x) => x.url === u) && u !== publicUrl) learn(u, 1);
      } catch (e) { countProbe(p, false); p.fails = (p.fails ?? 0) + 1; if (p.fails >= 2 && p.online) { p.online = false; inc("elyra_peer_events_total", { event: "offline" }); log("warn", "peer offline", { peer: p.name, reason: e.message }); events.peer({ state: "offline", name: p.name, viaRegistry: !!p.viaRegistry }); } }
    }));
    save();
  }
  every(15000, () => refreshPeers().catch(() => {}));
  refreshPeers().catch(() => {}); // re-contact remembered peers on startup

  const peerUrls = () => Object.values(state.peers).filter((p) => p.online).map((p) => p.url);

  return { addPeer, refreshPeers, announcePeers, peerUrls };
}
