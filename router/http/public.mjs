// Public "try it" surface, opt-in (ELYRA_PUBLIC_TRY=1), served on the admin hostname for visitors who are NOT signed in:
//   GET  /            the try page (panel/try/*, also at /try/*)      GET  /pub/info   read-only facts about this node
//   GET  /pub/market  the live listings: this node's own sources and the real peers it is connected to (never simulated)
//   GET  /pub/chain   public facts of the settlement chain, so a visitor can connect a wallet (browser only; the server never sees a key)
//   POST /pub/chat    one real chat on THIS node's own local model, streamed (optional "model": any model this node serves itself)
//   GET  /pub/quota   the caller's tier (visitor per IP, or wallet per signed-in address; see siwe.mjs) and what is left this hour
// Hard rules (each is covered by router/test/public.test.mjs):
//  - it only ever calls a local, non-hosted, non-demo upstream: never a paid peer (that would spend the node's escrow), never a
//    hosted API key, never the simulated market;
//  - per-client hourly limit (a larger one for a wallet sign-in, still bounded, plus an IP cap on the wallet tier), a global daily cap, a small
//    concurrency cap, bounded prompt size, capped max_tokens, fixed system prompt;
//  - same-origin only; the only cookie read is the signed session (via `identify`) to pick the quota tier, which grants nothing else;
//    prompt text is never logged or stored; /api, /v1, /metrics and the panel stay behind the login.
import { HttpError } from "../lib/errors.mjs";
import { buildIndex, lookup } from "../lib/reference.mjs";
import { depositCapOf } from "../core/limits.mjs";
import { abortOnClose, readJson, send, sink } from "./io.mjs";
import { publicWalletConfig, publicWalletPolicy } from "./wallet-policy.mjs";

const int = (v, d, lo, hi) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const SYSTEM = "You are the public demo assistant of Elyra, a peer-to-peer network for AI inference. You run on a small local model, so answer in one to three short sentences, in plain words, and say so if you are unsure. Do not claim to have tools, internet access or memory.";
const TRY_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

const defaultFetchList = async () => { const r = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } }); if (!r.ok) throw new Error("status " + r.status); return (await r.json()).data; };

export function createPublicTry(node, { staticFile, env = process.env, now = Date.now, fetchList = defaultFetchList, identify = null } = {}) {
  if (env.ELYRA_PUBLIC_TRY !== "1") return { enabled: false };
  const L = {
    perIpHour: int(env.ELYRA_TRY_PER_IP_HOUR, 20, 1, 500), walletPerHour: int(env.ELYRA_TRY_WALLET_PER_HOUR, 100, 1, 2000), daily: int(env.ELYRA_TRY_DAILY, 300, 1, 100000),
    maxTokens: int(env.ELYRA_TRY_MAX_TOKENS, 256, 16, 1024), concurrency: int(env.ELYRA_TRY_CONCURRENCY, 2, 1, 16),
    maxChars: 4000, maxMessages: 12, timeoutMs: 90_000,
  };
  // Wallet accounts (opt-in ELYRA_GATEWAY=1): the ONE sign-in is /auth/* (siwe.mjs); this page only reads the session (`identify`) and the profile store.
  const GATEWAY = env.ELYRA_GATEWAY === "1" && !!node.accounts && !!identify;
  const walletConfig = () => publicWalletConfig(node.state, env);
  /** with the gateway on, chat needs a wallet session with a username (the node's admin sessions are exempt) */
  function requireProfile(req) {
    if (!GATEWAY) return;
    const s = identify(req);
    if (s?.role === "admin") return;
    if (!s?.address) throw new HttpError(401, "Connect your wallet and sign in to chat.", "signin_required");
    if (!node.accounts.byWallet(s.address)?.username) throw new HttpError(403, "Choose a name for your account first.", "profile_required");
  }
  const hits = new Map(); // client -> [timestamps within the last hour]
  const today = { day: "", requests: 0, tokens: 0 };
  let inflight = 0;
  // ---- real history for the public stats page: visitor chats are tallied per UTC day (persisted, 120 days); served/routed come from the route log (last 2000)
  const DAYMS = 86_400_000, dayKey = (t) => new Date(t).toISOString().slice(0, 10);
  function tally(req, tok) {
    const d = (node.state.daily ??= {}), k = dayKey(now()), e = (d[k] ??= { pub: [0, 0] });
    e.pub[0] += req; e.pub[1] += tok;
    const keys = Object.keys(d); if (keys.length > 120) for (const old of keys.sort().slice(0, keys.length - 120)) delete d[old];
    node.save?.();
  }
  function statsView() {
    const N = 30, t = now(), series = [], idx = new Map();
    for (let i = N - 1; i >= 0; i--) { const day = dayKey(t - i * DAYMS), row = { day, pub: { requests: 0, tokens: 0 }, routed: { requests: 0, tokens: 0, usd: 0 }, served: { requests: 0, tokens: 0, usd: 0 } }; idx.set(day, row); series.push(row); }
    for (const [day, e] of Object.entries(node.state.daily ?? {})) { const r = idx.get(day); if (r) { r.pub.requests = Number(e?.pub?.[0]) || 0; r.pub.tokens = Number(e?.pub?.[1]) || 0; } }
    for (const r of node.state.routes ?? []) {
      if (r.simulated || r.ok === false) continue;
      const row = idx.get(dayKey(Number(r.ts) || 0)); if (!row) continue;
      const b = r.dir === "in" ? row.served : r.dir === "out" ? row.routed : null; if (!b) continue;
      b.requests++; b.tokens += (Number(r.p) || 0) + (Number(r.c) || 0); b.usd += Number(r.amount) || 0;
    }
    for (const r of series) { r.routed.usd = +r.routed.usd.toFixed(6); r.served.usd = +r.served.usd.toFixed(6); }
    const sum = (f) => series.reduce((a, r) => a + f(r), 0);
    const allPub = Object.values(node.state.daily ?? {}).reduce((a, e) => [a[0] + (Number(e?.pub?.[0]) || 0), a[1] + (Number(e?.pub?.[1]) || 0)], [0, 0]);
    return {
      at: new Date(t).toISOString(), days: N, since: new Date(Number(node.state.created) || t).toISOString().slice(0, 10), series,
      totals: { visitorChats: allPub[0], visitorTokens: allPub[1], routed: sum((r) => r.routed.requests), routedTokens: sum((r) => r.routed.tokens), served: sum((r) => r.served.requests), servedTokens: sum((r) => r.served.tokens), earnedUsd: +sum((r) => r.served.usd).toFixed(6), spentUsd: +sum((r) => r.routed.usd).toFixed(6) },
      note: "Measured on this node only. visitorChats: free playground chats; routed: requests this node sent out; served: requests peers sent to it. Simulated and failed requests are not counted.",
    };
  }
  const roll = () => { const d = new Date(now()).toISOString().slice(0, 10); if (today.day !== d) Object.assign(today, { day: d, requests: 0, tokens: 0 }); };
  const client = (req) => String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "?").split(",")[0].trim().slice(0, 64);
  const recent = (ip) => { const t = now() - 3_600_000; const a = (hits.get(ip) ?? []).filter((x) => x > t); if (a.length) hits.set(ip, a); else hits.delete(ip); return a; };
  const prune = () => {
    if (hits.size > 5000) {
      for (const ip of hits.keys()) recent(ip);
      for (const ip of hits.keys()) { if (hits.size <= 5000) break; hits.delete(ip); }
    }
  };

  // the only thing a visitor can reach: a self-owned upstream on this machine
  const source = (want) => {
    const ok = node.cands().filter((c) => c.kind === "self" && !c.hosted && !c.simulated && node.upstreamById(c.sourceId)?.kind !== "demo");
    if (want) return ok.find((c) => c.model === want) ?? null; // an explicit choice is exact
    // the default is exact too when pinned: if it is not available the page says offline, it never quietly serves a different (slower, smaller) one
    return env.ELYRA_TRY_MODEL ? ok.find((c) => c.model === env.ELYRA_TRY_MODEL) ?? null : ok[0] ?? null;
  };
  const owns = (p) => p === "/pub/info" || p === "/pub/market" || p === "/pub/stats" || p === "/pub/chain" || p === "/pub/paid-chat" || p === "/pub/voucher" || p === "/pub/session" || p === "/pub/chat" || p === "/pub/quota" || p === "/try" || p.startsWith("/try/") || p === "/robots.txt";
  /** a signed-out visitor asked for something that is neither the try page nor the panel: say so, instead of bouncing them to a login form */
  const missing = (req, res) => {
    const body = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Not found · Elyra</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;color:#1f2430;background:#f7f8fa}main{max-width:26rem;padding:24px}h1{font-size:20px;margin:0 0 8px}a{color:#4338ca}</style><main><h1>Page not found</h1><p>There is nothing at this address. Try the <a href="/">live node</a> or read the <a href="https://elyrainference.com/docs/">docs</a>.</p></main>`;
    res.writeHead(404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": TRY_CSP, "x-content-type-options": "nosniff" });
    res.end(req.method === "HEAD" ? undefined : body);
  };

  // ---- the market view: what is really on offer, as a visitor may see it. Nothing here is invented: a value that was not measured is null.
  const TEAM = new Set(String(env.ELYRA_TEAM_PEERS ?? "").split(",").map((s) => s.trim()).filter(Boolean)); // peer ids or names the operator runs themselves
  const measured = new Map(); // candidate key -> EWMA tokens/s seen on visitor chats
  // reference prices (opt-in: ELYRA_REFERENCE_PRICES=1): one fetch of OpenRouter's public model list every 6 hours; nothing about visitors is sent
  let refIdx = null, refNext = 0, refBusy = false;
  const refresh = () => {
    if (env.ELYRA_REFERENCE_PRICES !== "1" || refBusy || now() < refNext) return;
    refBusy = true;
    Promise.resolve().then(fetchList).then((d) => { refIdx = buildIndex(d); refNext = now() + 6 * 3_600_000; }).catch(() => { refNext = now() + 30 * 60_000; }).finally(() => { refBusy = false; });
  };
  const measuredTtft = new Map(); // candidate key -> EWMA ms to the first token seen on visitor chats
  const clip = (s, n = 40) => String(s ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, n);
  const chatable = (c) => c.kind === "self" && !c.hosted && !c.simulated && node.upstreamById(c.sourceId)?.kind !== "demo";
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

  function market() {
    refresh();
    const offered = new Map((node.provideModels?.() ?? []).map((m) => [m.id, num(m.price) ?? 0]));
    const byModel = new Map(), sellers = new Set();
    for (const c of node.cands()) {
      if (c.simulated || c.explicitOnly) continue;
      let o;
      if (c.kind === "self") {
        if (c.hosted || node.upstreamById(c.sourceId)?.kind === "demo") continue; // an operator's own hosted API key is not for sale
        const s = node.state.stats?.[c.key];
        o = { seller: clip(node.state.name) || "this node", where: "this-node", operator: "team", price: offered.has(c.model) ? offered.get(c.model) : null, chat: true,
          privacy: c.remote ? "remote" : "local", speed: num(s?.tps) ?? num(measured.get(c.key)), speedBasis: num(s?.tps) || measured.has(c.key) ? "measured" : null, ttftMs: num(s?.ttft) ? Math.round(s.ttft) : num(measuredTtft.get(c.key)) ? Math.round(measuredTtft.get(c.key)) : null, uptime: null };
        sellers.add("self");
      } else if (c.kind === "peer") {
        const s = node.state.stats?.[c.key], claimed = num(node.state.peers?.[c.peerId]?.models?.find((m) => m.id === c.model)?.tps);
        o = { seller: clip(c.peerName) || "peer", where: "peer", operator: TEAM.has(c.peerId) || TEAM.has(c.peerName) ? "team" : "community", price: num(c.price) ?? 0, chat: false,
          privacy: c.tee === "verified" ? "tee" : c.tee === "claimed" ? "tee-claimed" : "none", speed: num(s?.tps) ?? claimed, speedBasis: num(s?.tps) ? "measured" : claimed ? "claimed" : null, rttMs: num(c.rtt), ttftMs: num(s?.ttft) ? Math.round(s.ttft) : null, uptime: num(c.uptime) };
        sellers.add(c.peerId);
      } else continue;
      const n = (node.state.stats?.[c.key]?.ok ?? 0) + (node.state.stats?.[c.key]?.fail ?? 0);
      o.reputation = n > 0 ? { score: c.reputation, requests: n } : null;
      const g = byModel.get(c.model) ?? byModel.set(c.model, { model: clip(c.model, 80), offers: [] }).get(c.model);
      g.offers.push(o);
    }
    const priced = (g) => g.offers.map((o) => o.price).filter((p) => p != null);
    const models = [...byModel.values()].map((g) => {
      g.offers.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity) || (b.speed ?? 0) - (a.speed ?? 0));
      const p = priced(g), sp = g.offers.map((o) => o.speed).filter((x) => x != null);
      return { ...g, reference: lookup(refIdx, g.model), sellers: g.offers.length, cheapest: p.length ? Math.min(...p) : null, fastest: sp.length ? Math.max(...sp) : null, chat: g.offers.some((o) => o.chat), private: g.offers.some((o) => ["local", "tee"].includes(o.privacy)) };
    }).sort((a, b) => (a.cheapest ?? Infinity) - (b.cheapest ?? Infinity) || a.model.localeCompare(b.model));
    return { node: { name: clip(node.state.name) || null, settlement: node.chain.configured() ? "chain" : "sim", network: node.state.chain?.network ?? null, escrow: node.chain.configured() ? clip(node.state.chain.escrow, 60) : null },
      totals: { models: models.length, offers: models.reduce((a, g) => a + g.offers.length, 0), sellers: sellers.size, cheapest: models.reduce((m, g) => (g.cheapest != null && (m == null || g.cheapest < m) ? g.cheapest : m), null) },
      models, at: new Date(now()).toISOString() };
  }

  /** The caller's quota: signed in with a wallet (a session carrying an address) = the larger "wallet" tier, counted per address; everyone else is a visitor counted per IP. */
  const who = (req) => { const s = identify?.(req); return s?.address ? { tier: "wallet", key: "w:" + s.address, ip: client(req) } : { tier: "visitor", key: client(req), ip: client(req) }; };
  const tierLimit = (tier) => (tier === "wallet" ? L.walletPerHour : L.perIpHour);
  function quota(req) { roll(); const me = who(req), a = recent(me.key); return { tier: me.tier, used: a.length, limit: tierLimit(me.tier), resetsAt: a.length ? a[0] + 3_600_000 : null }; }

  function info(req) {
    roll();
    const c = source();
    return {
      enabled: true, gateway: GATEWAY, live: !!c, name: node.state.name, model: c?.model ?? null, via: c ? node.upstreamById(c.sourceId)?.name ?? null : null, hosting: c ? (c.remote ? "remote" : "local") : null,
      walletConnect: walletConfig(),
      version: node.state.version ?? undefined, peers: Object.values(node.state.peers ?? {}).filter((p) => p.online).length,
      settlement: { network: node.state.chain?.network ?? null, mode: node.chain.configured() ? "chain" : "sim" },
      limits: { perIpHour: L.perIpHour, walletPerHour: L.walletPerHour, daily: L.daily, maxTokens: L.maxTokens },
      today: { requests: today.requests, left: Math.max(0, L.daily - today.requests) }, you: ((me) => ({ tier: me.tier, limit: tierLimit(me.tier), left: Math.max(0, tierLimit(me.tier) - recent(me.key).length) }))(who(req)),
    };
  }

  /** the shape and size rules for a visitor's conversation (free and paid chat share them) */
  function cleanMessages(msgs) {
    if (!Array.isArray(msgs) || msgs.length < 1 || msgs.length > L.maxMessages) throw new HttpError(400, `send 1 to ${L.maxMessages} messages`, "invalid_request_error");
    let chars = 0;
    const clean = msgs.map((m) => {
      if (!m || typeof m.content !== "string" || !["user", "assistant"].includes(m.role)) throw new HttpError(400, "messages must be {role: user|assistant, content: string}", "invalid_request_error");
      chars += m.content.length; return { role: m.role, content: m.content };
    });
    if (clean.at(-1).role !== "user") throw new HttpError(400, "the last message must be from the user", "invalid_request_error");
    if (chars > L.maxChars || !clean.at(-1).content.trim()) throw new HttpError(400, `keep the conversation under ${L.maxChars} characters`, "invalid_request_error");
    return clean;
  }
  const sameOrigin = (req) => { const o = req.headers.origin; if (o && (() => { try { return new URL(o).host; } catch { return ""; } })() !== req.headers.host) throw new HttpError(403, "cross-site request refused", "forbidden"); };
  const jsonOnly = (req) => { if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "send application/json"); };

  // ---- paying with the visitor's own wallet (opt-in: ELYRA_PUBLIC_PAY=1, needs on-chain settlement). The node is only a gateway: see core/consumer/session-pay.mjs
  const PAY = env.ELYRA_PUBLIC_PAY === "1" && !!node.sessionPay;
  const P = { perIpHour: int(env.ELYRA_PAY_PER_IP_HOUR, 60, 1, 2000), maxTokens: int(env.ELYRA_PAY_MAX_TOKENS, 512, 16, 2048), concurrency: int(env.ELYRA_PAY_CONCURRENCY, 4, 1, 32), voucherPerIpHour: 600, readPerIpHour: 600 };
  const payHits = new Map(); let payInflight = 0;
  const payLimit = (kind, cap, ip, res) => {
    const k = kind + ":" + ip, t = now() - 3_600_000, a = (payHits.get(k) ?? []).filter((x) => x > t);
    if (a.length >= cap) { res.setHeader("retry-after", "60"); throw new HttpError(429, "too many requests from this address, slow down", "rate_limited"); }
    a.push(now()); payHits.set(k, a);
    if (payHits.size > 5000) {
      for (const key of payHits.keys()) { if (!(payHits.get(key) ?? []).some((x) => x > t)) payHits.delete(key); }
      for (const key of payHits.keys()) { if (payHits.size <= 5000) break; payHits.delete(key); }
    }
  };
  async function paidChat(req, res) {
    if (!PAY) throw new HttpError(404, "paying from the browser is not enabled on this node");
    jsonOnly(req); sameOrigin(req);
    const body = await readJson(req, 24_000);
    const clean = cleanMessages(body.messages);
    payLimit("chat", P.perIpHour, client(req), res);
    if (payInflight >= P.concurrency) { res.setHeader("retry-after", "5"); throw new HttpError(503, "the node is busy with other paid chats, try again in a few seconds", "busy"); }
    payInflight++; const ctl = abortOnClose(res);
    try {
      await node.sessionPay.chat({ session: body.session, model: body.model, maxPrice: body.maxPrice, vouchers: body.vouchers, messages: clean, max_tokens: Math.min(Number(body.max_tokens) || P.maxTokens, P.maxTokens), temperature: Math.min(1.2, Math.max(0, Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.7)) }, sink(res), ctl);
    } finally { payInflight--; }
  }
  async function payVoucher(req, res) {
    if (!PAY) throw new HttpError(404, "paying from the browser is not enabled on this node");
    jsonOnly(req); sameOrigin(req); payLimit("voucher", P.voucherPerIpHour, client(req), res);
    return send(res, 200, await node.sessionPay.voucher(await readJson(req, 4_000)));
  }
  async function paySession(req, res, url) {
    if (!PAY) throw new HttpError(404, "paying from the browser is not enabled on this node");
    payLimit("read", P.readPerIpHour, client(req), res);
    return send(res, 200, await node.sessionPay.position(url.searchParams.get("wallet") ?? ""));
  }

  async function chat(req, res) {
    jsonOnly(req); sameOrigin(req);
    requireProfile(req); // with the gateway on, chat needs a wallet session with a username
    const body = await readJson(req, 16_000);
    const clean = cleanMessages(body.messages);

    const want = typeof body.model === "string" && body.model ? body.model.slice(0, 120) : null;
    const c = source(want);
    if (!c) throw new HttpError(want ? 404 : 503, want ? "That model is not available for free chat on this node right now." : "No local model is connected on this node right now.", want ? "model_not_found" : "unavailable");
    roll();
    const me = who(req), limit = tierLimit(me.tier), used = recent(me.key);
    const ipKey = me.tier === "wallet" ? "wip:" + me.ip : null, ipUsed = ipKey ? recent(ipKey) : []; // a signed-in tier is per address; an IP cap stops one machine from minting wallets to dodge the limit
    if (used.length >= limit || ipUsed.length >= L.walletPerHour * 3) { res.setHeader("retry-after", String(Math.max(60, Math.ceil(((used.length >= limit ? used : ipUsed)[0] + 3_600_000 - now()) / 1000)))); throw new HttpError(429, me.tier === "wallet" ? `You have used your ${limit} signed-in requests for this hour. Run your own node to keep going.` : `You have used your ${limit} free requests for this hour. Sign in with a wallet for more, or run your own node to keep going.`, "rate_limited"); }
    if (today.requests >= L.daily) throw new HttpError(429, "Today's free capacity on this node is used up. Try again tomorrow, or run your own node.", "rate_limited");
    if (inflight >= L.concurrency) { res.setHeader("retry-after", "5"); throw new HttpError(503, "The model is busy answering other visitors. Try again in a few seconds.", "busy"); }

    used.push(now()); hits.set(me.key, used); if (ipKey) { ipUsed.push(now()); hits.set(ipKey, ipUsed); }
    today.requests++; tally(1, 0); prune();
    inflight++;
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), L.timeoutMs);
    res.on("close", () => ctl.abort());
    try {
      const t = Math.min(Number(body.max_tokens) || L.maxTokens, L.maxTokens);
      const temp = Math.min(1.2, Math.max(0, Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.7));
      let out;
      const t0 = now();
      try { out = await node.execLocal(c, { messages: [{ role: "system", content: SYSTEM }, ...clean], max_tokens: t, temperature: temp, stream: true, stream_options: { include_usage: true } }, ctl); }
      catch { throw new HttpError(502, "The model could not be reached. Try again in a moment.", "upstream_error"); }
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no",
        "x-elyra-route": `self:${node.upstreamById(c.sourceId)?.name ?? "local"}`, "x-elyra-model": c.model, "x-elyra-simulated": "false", "x-try-left": String(Math.max(0, limit - used.length)),
      });
      let firstAt = 0;
      for await (const chunk of out.frames) { if (!firstAt) firstAt = now(); if (!res.write(chunk)) await new Promise((r) => res.once("drain", r)); }
      const used2 = await out.usage; today.tokens += used2.c ?? 0; tally(0, Number(used2.c) || 0);
      if (firstAt && used2.c >= 1) { const w = firstAt - t0, prevT = measuredTtft.get(c.key); measuredTtft.set(c.key, prevT ? prevT * 0.7 + w * 0.3 : w); }
      const sec = (now() - firstAt) / 1000; // speed seen by a real visitor, shown in the market as "measured"
      if (firstAt && used2.c >= 8 && sec > 0.3) { const t = used2.c / sec, prev = measured.get(c.key); measured.set(c.key, prev ? prev * 0.7 + t * 0.3 : t); }
      res.end();
    } catch (e) {
      if (res.headersSent) { res.end(); return; } // mid-stream failure: the client sees the stream stop
      throw e;
    } finally { clearTimeout(timer); inflight--; }
  }

  // What a visitor's wallet needs to talk to this node's settlement chain. Public facts only: no node balances, no wallet address.
  let chainCache = { at: 0, v: null };
  async function chainFacts() {
    if (now() - chainCache.at < 30_000 && chainCache.v) return chainCache.v;
    let v = { enabled: false };
    try {
      const c = node.chain.configured() ? await node.chain.info() : null;
      const maxDepositUsd = depositCapOf(node.state?.provide);
      if (c?.chainId && c.rpcUrl && c.escrow && c.token) v = { enabled: true, chainId: c.chainId, name: c.networkName, rpcUrl: c.rpcUrl, explorer: c.explorer || null, real: !!c.real, token: c.token, symbol: c.tokenSymbol ?? "USDG", decimals: c.tokenDecimals ?? 6, isMock: !!c.isMock, escrow: c.escrow, maxDepositUsd, pay: PAY, ...(PAY ? { nodeId: node.selfId } : {}) };
    } catch { /* chain unreachable: the wallet card says so */ }
    chainCache = { at: now(), v }; return v;
  }

  async function handle(req, res, path) {
    // wallet sign-in and the username profile are /auth/* (siwe.mjs), served on the admin host before this surface
    if (path === "/pub/paid-chat") { if (req.method !== "POST") throw new HttpError(405, "POST only"); return paidChat(req, res); }
    if (path === "/pub/voucher") { if (req.method !== "POST") throw new HttpError(405, "POST only"); return payVoucher(req, res); }
    if (path === "/pub/session") { if (req.method !== "GET") throw new HttpError(405, "GET only"); return paySession(req, res, new URL(req.url, "http://x")); }
    if (path === "/pub/chain") { if (req.method !== "GET") throw new HttpError(405, "GET only"); return send(res, 200, await chainFacts()); }
    if (path === "/pub/quota") { if (req.method !== "GET") throw new HttpError(405, "GET only"); return send(res, 200, quota(req)); }
    if (path === "/pub/info") { if (req.method !== "GET") throw new HttpError(405, "GET only"); return send(res, 200, info(req)); }
    if (path === "/pub/stats") { if (req.method !== "GET") throw new HttpError(405, "GET only"); return send(res, 200, statsView()); }
    if (path === "/pub/market") { if (req.method !== "GET") throw new HttpError(405, "GET only"); return send(res, 200, market()); }
    if (path === "/pub/chat") { if (req.method !== "POST") throw new HttpError(405, "POST only"); return chat(req, res); }
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method not allowed");
    if (path === "/robots.txt") { res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" }); return res.end("User-agent: *\nAllow: /$\nDisallow: /\n"); }
    // paying from the browser lets the page talk to the settlement chain's RPC directly (the session key signs and sends its own transactions): that one origin, only when paying is on
    if (PAY) await chainFacts();
    const rpc = PAY ? (() => { try { return new URL(chainCache.v?.rpcUrl ?? "").origin; } catch { return ""; } })() : "";
    res.setHeader("content-security-policy", publicWalletPolicy(TRY_CSP, walletConfig(), rpc)); res.setHeader("x-frame-options", "DENY"); res.setHeader("referrer-policy", "same-origin"); res.setHeader("x-content-type-options", "nosniff");
    const rawRel = path === "/" || path === "/try" || path === "/try/" ? "index.html" : path.slice("/try/".length);
    let rel;
    try { rel = decodeURIComponent(rawRel); } catch { throw new HttpError(400, "bad path"); }
    if (!rel || rel.startsWith("/") || rel.includes("..") || rel.includes("\\") || rel.includes("\0") || rel.includes("%")) throw new HttpError(404, "Not Found");
    if (rel === "appkit.js") return staticFile(req, res, "/app/vendor/wallet.js");
    return staticFile(req, res, `/app/try/${rel}`);
  }

  return { enabled: true, owns, handle, missing, market, gateway: GATEWAY, limits: L, stats: () => ({ hits: hits.size, payHits: payHits.size, inflight, payInflight }) };
}
