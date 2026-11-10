// Pure data shaping for the Network view: peers + catalog listings -> topology nodes. No DOM, no I/O.
// Remote-supplied fields (names, models, regions) pass through untouched here; escaping happens where they are rendered.

// live peers come from /api/peers; simulated ones (bridges, community GPUs) are grouped out of the catalog listings
export function buildNodes(peers, listings) {
  const live = peers.filter((p) => p.online), sims = new Map(), nodes = {};
  for (const p of live) {
    const ps = p.models.map((m) => m.price);
    nodes[p.id] = {
      id: p.id, kind: "live", name: p.name, url: p.url, rtt: p.rtt, attest: p.attest,
      models: p.models.map((m) => ({ model: m.id, price: m.price, tee: m.tee, tps: m.tps })),
      pmin: ps.length ? Math.min(...ps) : 0, pmax: ps.length ? Math.max(...ps) : 0,
      tee: p.models.some((m) => m.tee && m.tee !== "none"),
    };
  }
  for (const c of listings) {
    if (c.kind !== "sim") continue;
    let n = sims.get(c.peerId);
    if (!n) { n = { id: c.peerId, kind: c.peerKind === "bridge" ? "bridge" : "community", name: c.peerName, region: c.region, logo: c.logo, models: [], tee: false }; sims.set(c.peerId, n); }
    n.models.push({ model: c.model, price: c.price, tee: c.tee, tps: c.tps, logo: c.logo });
    if (c.tee !== "none") n.tee = true;
  }
  for (const n of sims.values()) {
    const ps = n.models.map((m) => m.price);
    n.pmin = Math.min(...ps);
    n.pmax = Math.max(...ps);
    nodes[n.id] = n;
  }
  return { live, nodes };
}

// the last 8 peers we sent traffic to in the past 10 minutes (one route per peer)
export const recentRoutes = (routes) =>
  [...new Map(routes.filter((r) => r.dir === "out" && Date.now() - r.ts < 600000).map((r) => [r.peerId, r])).values()].slice(0, 8);

// a route is "fresh" (animated bold flow) for 20 s
export const isFresh = (r) => Date.now() - r.ts < 20000;
