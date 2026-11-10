// Local control API (/api/*, loopback only; the guard runs in app.mjs). Route table: handlers get
// { body, q, params } and return the JSON to send with 200. Chain/escrow routes live in api-chain.mjs.
import { cleanPrices } from "../core/provider/models.mjs";
import { HttpError } from "../lib/errors.mjs";
import { PROTOCOL, VERSION } from "../core/limits.mjs";
import { spentLast24h } from "../core/stats.mjs";
import { normaliseWeights, usd } from "../policy.mjs";
import { GCP_ISSUER } from "../tee.mjs";
import { chainRoutes } from "./api-chain.mjs";
import { createEventsRoutes } from "./events.mjs";
import { readJson, send } from "./io.mjs";
import { routeTable } from "./table.mjs";
import { peerView, upView, view } from "./views.mjs";

export function createApi(node) {
  const { state } = node;
  const feed = createEventsRoutes(node);

  const status = () => {
    const c = node.cands();
    const peers = Object.values(state.peers);
    return {
      node: { id: node.selfId, address: node.address, name: state.name, version: VERSION, protocol: PROTOCOL, publicUrl: node.publicUrl, port: node.port, dataDir: node.dataDir, encrypted: node.encrypted, relay: node.relay?.status() ?? null },
      endpoint: `http://localhost:${node.port}/v1`,
      spendCap: { usdDay: state.settings.spendCapUsdDay ?? null, spentUsd: spentLast24h(state) }, // 24 h rolling, paid requests only (see core/consumer/chat.mjs)
      balance: node.balance(), stats: node.stats(),
      network: {
        peersLive: peers.filter((p) => p.online).length, peersKnown: peers.length,
        simPeers: state.settings.demoNetwork ? node.catalog.peers.length : 0,
        models: new Set(c.map((x) => x.model)).size, listings: c.length, teeListings: c.filter((x) => x.private && x.kind !== "self").length,
        liveListings: c.filter((x) => !x.simulated).length, demoNetwork: state.settings.demoNetwork,
        blocked: node.settlement.blocked(), // online sellers whose models are hidden because they settle on another escrow
        settlement: node.settlement.self(),
      },
      providing: { enabled: state.provide.enabled, models: node.provideModels().length },
      tee: { mode: node.teeMode() ? "gcp-confidential-space" : null, active: node.teeActive() },
      policy: state.policy,
    };
  };

  const models = ({ q }) => {
    let list = node.plan("auto").length || node.cands().length ? node.cands() : [];
    const ranked = new Map(node.plan("auto").map((c) => [c.key, c]));
    list = list.map((c) => ({ ...c, ...(ranked.get(c.key) ? { score: ranked.get(c.key).score } : {}) }));
    const query = (q.get("q") ?? "").toLowerCase();
    if (query) list = list.filter((c) => c.model.toLowerCase().includes(query) || c.peerName.toLowerCase().includes(query) || (c.vendor ?? "").toLowerCase().includes(query));
    return { models: list.map(view) };
  };

  const routePreview = ({ body }) => {
    const ranked = node.plan(body.model ?? "auto");
    return { model: body.model ?? "auto", options: ranked.slice(0, 6).map(view), total: ranked.length };
  };

  const trust = async ({ req, body }) => {
    if (req.method === "PUT") {
      const T = state.trust;
      if (Array.isArray(body.allowedImages)) {
        if (!body.allowedImages.every((d) => /^sha256:[0-9a-f]{64}$/.test(d))) throw new HttpError(400, "allowedImages must be image digests like sha256:<64 hex>");
        T.allowedImages = [...new Set(body.allowedImages)].slice(0, 50);
      }
      if (Array.isArray(body.allowedHw)) T.allowedHw = body.allowedHw.filter((h) => ["GCP_AMD_SEV", "GCP_INTEL_TDX"].includes(h));
      if ("jwksInline" in body) { if (process.env.ELYRA_ALLOW_TEST_TRUST !== "1") throw new HttpError(403, "inline JWKS is for tests only"); T.jwksInline = body.jwksInline; }
      node.save();
      await node.refreshPeers();
    }
    return { allowedImages: state.trust.allowedImages, allowedHw: state.trust.allowedHw, issuer: GCP_ISSUER, audience: "elyra:v3" };
  };

  const policy = ({ req, body }) => {
    if (req.method === "PUT") {
      if (body.weights) state.policy.weights = normaliseWeights(body.weights);
      if ("teeOnly" in body) state.policy.teeOnly = !!body.teeOnly;
      if ("maxPrice" in body) state.policy.maxPrice = body.maxPrice == null || body.maxPrice === "" ? null : Math.max(0, Number(body.maxPrice));
      node.save();
    }
    return state.policy;
  };

  /** null / "" = no cap; otherwise a finite dollar amount >= 0 (0 blocks every paid route) */
  const parseCap = (v) => {
    if (v === null || v === "") return null;
    const n = typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN;
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, "spendCapUsdDay must be a number of dollars per day, 0 or more (null removes the cap)");
    return usd(n);
  };

  const settings = ({ body }) => {
    const cap = "spendCapUsdDay" in body ? parseCap(body.spendCapUsdDay) : undefined; // validate before changing anything
    if ("demoNetwork" in body) state.settings.demoNetwork = !!body.demoNetwork;
    if (cap !== undefined) state.settings.spendCapUsdDay = cap;
    if ("registryDiscover" in body) state.settings.registryDiscover = !!body.registryDiscover; // on-chain discovery (default on once a registry is configured)
    if ("registryAnnounce" in body) state.settings.registryAnnounce = !!body.registryAnnounce; // seller opt-in: list this node on-chain (costs gas)
    if (typeof body.name === "string" && body.name.trim()) state.name = body.name.trim().slice(0, 40);
    node.save();
    return { settings: state.settings, name: state.name };
  };

  const addPeer = async ({ body }) => {
    try { return peerView(await node.addPeer(String(body.url ?? "")), node.settlement); }
    catch (e) { throw new HttpError(400, `cannot add peer: ${e.message}`); }
  };

  const removeUpstream = ({ params: [id] }) => {
    const i = state.upstreams.findIndex((u) => u.id === id);
    if (i < 0) throw new HttpError(404, "no such upstream (the demo engine cannot be removed)");
    state.upstreams.splice(i, 1);
    if (Array.isArray(state.provide.upstreamIds)) state.provide.upstreamIds = state.provide.upstreamIds.filter((x) => x !== id);
    if (state.provide.upstreamId === id) {
      state.provide.upstreamId = state.provide.upstreamIds?.[0] ?? "demo-engine";
      if (!state.provide.upstreamIds?.length) state.provide.models = [];
    }
    node.save();
    return { ok: true };
  };

  const provide = ({ req, body }) => {
    if (req.method === "PUT") {
      const P = state.provide;
      if ("enabled" in body) P.enabled = !!body.enabled;
      if ("upstreamIds" in body) {
        if (!Array.isArray(body.upstreamIds)) throw new HttpError(400, "upstreamIds must be an array");
        if (body.upstreamIds.includes("*")) {
          if (P.upstreamId !== "*" || P.upstreamIds?.length) P.models = [];
          P.upstreamId = "*";
          P.upstreamIds = [];
        } else {
          const ids = [...new Set(body.upstreamIds.map(String).filter(Boolean))];
          if (!ids.length) throw new HttpError(400, "upstreamIds must not be empty");
          for (const id of ids) if (!node.upstreams().some((u) => u.id === id)) throw new HttpError(400, `unknown upstream: ${id}`);
          const prev = P.upstreamIds?.length ? P.upstreamIds.join(",") : P.upstreamId;
          if (ids.join(",") !== prev) P.models = [];
          P.upstreamIds = ids;
          P.upstreamId = ids[0];
        }
      } else if (body.upstreamId) {
        if (body.upstreamId === "*") {
          if (P.upstreamId !== "*" || P.upstreamIds?.length) P.models = [];
          P.upstreamId = "*";
          P.upstreamIds = [];
        } else {
          if (!node.upstreams().some((u) => u.id === body.upstreamId)) throw new HttpError(400, "unknown upstream");
          if (body.upstreamId !== P.upstreamId || (P.upstreamIds?.length ?? 0) > 1) P.models = [];
          P.upstreamId = body.upstreamId;
          P.upstreamIds = [];
        }
      }
      if ("price" in body) { const n = Number(body.price); if (!Number.isFinite(n) || n < 0) throw new HttpError(400, "bad price"); P.price = n; }
      if ("prices" in body) P.prices = cleanPrices(body.prices); // per-model prices override the default price
      if (body.tee) { if (!["none", "claimed"].includes(body.tee)) throw new HttpError(400, "tee must be none|claimed"); P.tee = body.tee; }
      if (Array.isArray(body.models)) P.models = body.models.map(String);
      if ("maxConcurrent" in body) P.maxConcurrent = Math.max(1, Math.min(64, Number(body.maxConcurrent) || 4));
      if ("creditUsd" in body) { const n = Number(body.creditUsd); if (!Number.isFinite(n) || n < 0) throw new HttpError(400, "bad credit limit"); P.creditUsd = n; }
      if ("maxDepositUsd" in body) {
        if (typeof body.maxDepositUsd === "boolean" || body.maxDepositUsd === null || body.maxDepositUsd === "") throw new HttpError(400, "bad deposit cap");
        const n = Number(body.maxDepositUsd);
        if (!Number.isFinite(n) || n <= 0 || n > 10000) throw new HttpError(400, "bad deposit cap");
        P.maxDepositUsd = n;
      }
      if ("autoRedeem" in body) P.autoRedeem = !!body.autoRedeem;
      if ("payout" in body) { if (body.payout && !node.chain.isAddress(body.payout)) throw new HttpError(400, "payout must be an address"); P.payout = body.payout || ""; }
      if ("autoRedeemUsd" in body) { const n = Number(body.autoRedeemUsd); if (!Number.isFinite(n) || n < 0) throw new HttpError(400, "bad auto-redeem threshold"); P.autoRedeemUsd = n; }
      if ("ratePerMin" in body) P.ratePerMin = Math.max(1, Math.min(10000, Number(body.ratePerMin) || 120));
      if (Array.isArray(body.deny)) P.deny = body.deny.map(String).slice(0, 500);
      node.save();
      node.announcePeers?.();
    }
    return { ...state.provide, offered: node.provideModels(), publicUrl: node.publicUrl };
  };

  const ledger = () => {
    const strip = (e) => ({ ...e, receipt: e.receipt ? { sim: !!e.receipt.sim, id: e.receipt.id, sig: e.receipt.sig ? e.receipt.sig.slice(0, 24) + "…" : undefined, price: e.receipt.price } : undefined });
    return { balance: node.balance(), funded: state.wallet.funded, address: node.address, chain: node.chain.configured() ? state.chain.network : "sim-testnet", mode: node.chain.configured() ? "chain" : "sim", entries: state.ledger.slice(-100).reverse().map(strip), batches: state.batches.slice(-20).reverse(), stats: node.stats() };
  };

  const match = routeTable([
    ["GET", "/api/status", status],
    ["GET", "/api/models", models],
    ["POST", "/api/route/preview", routePreview],
    ["*", "/api/trust", trust],
    ["*", "/api/policy", policy],
    ["PUT", "/api/settings", settings],
    ["POST", "/api/peers", addPeer],
    ["*", "/api/peers", () => ({ peers: Object.values(state.peers).map((p) => peerView(p, node.settlement)), self: node.settlement.self() })],
    ["DELETE", /^\/api\/peers\/([\w-]+)$/, ({ params: [id] }) => { delete state.peers[id]; node.save(); return { ok: true }; }],
    ["POST", "/api/peers/refresh", async () => { await node.refreshPeers(); return { ok: true }; }],
    ["POST", "/api/upstreams", async ({ body }) => { const u = await node.addUpstream(body); return upView(u, node.upstreamHealth(u.id)); }],
    ["*", "/api/upstreams", () => ({ upstreams: node.upstreams().filter((u) => u.kind !== "demo" || node.state.settings.demoNetwork !== false).map((u) => upView(u, u.kind === "demo" ? undefined : node.upstreamHealth(u.id))) })],
    ["GET", "/api/upstreams/detect", async () => ({ found: await node.detectLocal() })],
    ["DELETE", /^\/api\/upstreams\/([\w-]+)$/, removeUpstream],
    ["POST", /^\/api\/upstreams\/([\w-]+)\/refresh$/, async ({ params: [id] }) => upView(await node.refreshUpstream(id))],
    ["*", "/api/provide", provide],
    ["GET", "/api/ledger", ledger],
    ["POST", "/api/ledger/fund", ({ body }) => ({ balance: node.fund(body.amount ?? 10) })],
    ["POST", "/api/ledger/settle", async () => { const batches = await node.settle(); return { batches, failed: state.lastSettleErrors ?? [] }; }],
    ...chainRoutes(node),
    ["GET", "/api/routes", () => ({ routes: state.routes.slice(-60).reverse() })],
    ["GET", "/api/events/recent", feed.recent],
  ]);

  return async function api(req, res, path, q) {
    if (req.method === "GET" && path === "/api/events") return feed.stream(req, res, q); // long-lived: written to the socket, not returned as JSON
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJson(req);
    const hit = match(req.method, path);
    if (!hit) throw new HttpError(404, "no such endpoint");
    const out = await hit.handler({ req, body, q, params: hit.params });
    if (req.method !== "GET") node.flush(); // owner configuration must survive a hard kill, not wait for the 1.5 s timer
    return send(res, 200, out);
  };
}
