// Node state and its persistence: the single mutable `state` object, debounced atomic save to state.json.
// Upstream API keys are sealed at rest through vault.mjs. Must not know about peers, chain calls or HTTP.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CHAIN } from "../chain.mjs";
import { DEFAULT_POLICY } from "../policy.mjs";
import { DEFAULT_HW } from "../tee.mjs";
import { openField, sealField } from "../vault.mjs";

/**
 * Load (or create) state.json. Returns { state, save, flush }: `save()` marks dirty (flushed every 1.5 s by the caller's timer),
 * `flush()` writes now.
 */
export function openStore({ dataDir, opts, selfId }) {
  const stateFile = join(dataDir, "state.json");
  const fresh = () => ({
    name: opts.name ?? `node-${selfId.slice(0, 4)}`,
    policy: structuredClone(DEFAULT_POLICY),
    upstreams: [],
    provide: { enabled: false, upstreamId: "demo-engine", upstreamIds: [], price: 0.1, prices: {}, tee: "none", models: [], maxConcurrent: 4, creditUsd: 0.5, maxDepositUsd: 20, autoRedeem: true, autoRedeemUsd: 0.25, payout: "", ratePerMin: 120, deny: [] },
    peers: {},
    ledger: [],
    routes: [],
    stats: {},
    daily: {}, // YYYY-MM-DD -> { pub: [visitor chats, tokens] } kept 120 days, read by GET /pub/stats
    batches: [],
    wallet: { funded: 25 },
    chain: { ...DEFAULT_CHAIN },
    trust: { allowedImages: [], allowedHw: [...DEFAULT_HW], jwksInline: null }, // BUYER-side trust anchors for TEE attestation (pinned image digests)
    vouchersOut: {}, // providerId → { providerAddress, cumulative (USDG units, string), sig, ts }
    vouchersIn: {},  // consumerId → { consumerAddress, cumulative, sig, owedUnits, redeemed (USDG units), ts }
    settings: { demoNetwork: opts.demoNetwork ?? true, spendCapUsdDay: null }, // spendCapUsdDay: USD per rolling 24 h on paid outgoing requests, null = no cap
    created: Date.now(),
  });
  let state = fresh();
  if (existsSync(stateFile)) {
    try {
      const raw = JSON.parse(readFileSync(stateFile, "utf8"));
      for (const u of raw.upstreams ?? []) u.apiKey = openField(u.apiKey, opts.passphrase);
      state = { ...fresh(), ...raw };
      state.trust = { ...fresh().trust, ...state.trust };
      state.provide = { ...fresh().provide, ...state.provide }; // pick up new provider settings on old state files
      for (const [k, v] of Object.entries(state.vouchersIn ?? {})) { // legacy: vouchers were keyed by consumer id, now by wallet
        if (!k.startsWith("0x")) { delete state.vouchersIn[k]; state.vouchersIn[String(v.consumerAddress).toLowerCase()] = { ...v, ids: [k] }; }
      }
    } catch (e) {
      if (/ELYRA_PASSPHRASE/.test(e.message)) throw e; // never silently discard an encrypted state
      console.warn("state.json unreadable, starting fresh:", e.message);
    }
  }
  if (opts.demoNetwork === false) state.settings.demoNetwork = false;
  if (opts.name) state.name = opts.name;

  let dirty = false;
  const save = () => { dirty = true; };
  const flush = () => {
    if (!dirty) return;
    dirty = false;
    state.routes = state.routes.slice(-2000);
    state.ledger = state.ledger.slice(-5000);
    const tmp = stateFile + ".tmp";
    writeFileSync(tmp, JSON.stringify({ ...state, upstreams: state.upstreams.map((u) => ({ ...u, apiKey: sealField(u.apiKey, opts.passphrase) })) }), { mode: 0o600 });
    renameSync(tmp, stateFile);
  };
  return { state, save, flush };
}
