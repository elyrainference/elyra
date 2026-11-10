import { uptimeOf } from "../core/reputation.mjs";
import { isLocalUrl } from "../lib/url.mjs";
// Response shapes for the control API: which fields of a candidate / upstream / peer leave the process.
// Upstream API keys are reduced to `hasKey`; private keys never appear here.
const attestView = (a) => ({ ok: a.ok, platform: a.platform, image: a.image, exp: a.exp, reasons: a.reasons });

export const view = (c) => ({
  key: c.key, kind: c.kind, peerId: c.peerId, peerName: c.peerName, model: c.model, logo: c.logo ?? null, vendor: c.vendor,
  price: c.price, tps: c.tps, ttft: c.ttft ?? null, uptime: c.uptime ?? null, reputation: c.reputation, tee: c.tee, simulated: c.simulated, ctx: c.ctx, region: c.region,
  score: c.score, parts: c.parts, explicitOnly: c.explicitOnly, hosted: c.hosted, remote: c.remote, peerKind: c.peerKind, attest: c.attest ? attestView(c.attest) : undefined,
});

export const upView = (u, health) => ({ ...(health ? { health } : {}), id: u.id, name: u.name, kind: u.kind, baseUrl: u.baseUrl, hasKey: !!u.apiKey, price: u.price, models: u.models, builtin: !!u.builtin, remote: !!u.remote, hosted: u.kind !== "demo" && !isLocalUrl(u.baseUrl) });

export const peerView = (p, settlement) => ({ id: p.id, url: p.url, name: p.name, online: p.online, providing: p.providing, models: p.models, rtt: p.rtt, uptime: uptimeOf(p), lastSeen: p.lastSeen, version: p.version, attest: p.attest ? attestView(p.attest) : null, viaRegistry: !!p.viaRegistry,
  ...(settlement ? { settlement: p.chain?.escrow ? { network: p.chain.network ?? null, escrow: p.chain.escrow } : null, routable: settlement.compatible(p) } : {}) });
