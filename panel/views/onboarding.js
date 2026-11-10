// The guided checklist ("Get started" on Home, "Go-live checklist" on Provide). Every step is derived from live state; nothing is stored.
// It answers one question for a new user: what do I do next? The first unfinished step is highlighted with a single primary action.
import { api } from "../lib/api.js";
import { ENDPOINT } from "../lib/config.js";
import { $, $$, esc, setHtml } from "../lib/dom.js";
import { S } from "../lib/store.js";
import { MIN_GAS_ETH } from "./alerts.js";

const isLocalUrl = (u) => /localhost|127\.0\.0\.1/.test(u ?? "");

// steps: [title, description, done, targetView?, ctaLabel?, extraButtonAttrs?]
function localSteps(st, ctx) {
  return [
    ["Connect your own model source", "Detect Ollama or add LM Studio / an OpenAI-compatible source. Your own local inference needs no escrow or USDG deposit; hosted APIs retain their own provider charges.", ctx.ups.upstreams.some((u) => !u.builtin), "connect", "Connect source"],
    ["Test and inspect the answer", "Browse Models & sellers, select your source in Playground, then expand the answer's route footer for source, tokens and cost. Home shows this node's usage; Private Live is owner-only.", ctx.routes.some((r) => r.dir === "out" && r.kind === "self" && !r.simulated && r.ok), "models", "Compare models"],
  ];
}

function buySteps(st, ctx) {
  const { ch, onchain, routes, peers } = ctx;
  return [
    ["Find a reachable seller", "Compare Models & sellers. Add a seller URL under Network if needed. These are this node's known offers, not a global index; SIM listings are not real inference.", peers.peers.some((p) => p.online !== false && !p.simulated), "models", "Compare offers"],
    ["Fund only for paid peers", onchain ? "Match the seller's settlement, review the network and per-wallet cap, then deposit USDG. Your own local model does not need this step." : "Paid peers need the same escrow settlement as the seller. Choose it under Payments → Escrow; simulated ledger funds are not real USDG.", onchain && (ch?.depositUsd ?? 0) > 0, "payments", onchain ? "Review funding" : "Set settlement", onchain ? ' data-tab="fund"' : ' data-tab="escrow"'],
    ["Send and check the actual route", "Choose a model in Playground. The answer's route footer identifies the seller, tokens and cost; no seller is pinned just by opening its offer.", routes.some((r) => r.dir === "out" && r.kind === "peer" && !r.simulated && r.ok), "playground", "Open Playground"],
    ["Review receipts and spending", "Payments → Ledger records this node's signed peer receipts. Set a daily spend cap under Fund before sustained paid usage.", routes.some((r) => r.dir === "out" && !r.simulated && r.amount > 0), "payments", "Open ledger", ' data-tab="ledger"'],
  ];
}

function sellSteps(st, ctx) {
  const { ch, onchain, ups } = ctx;
  const relayed = !!st.node.relay?.connected, reachable = !isLocalUrl(st.node.publicUrl) || relayed;
  return [
    ["Connect the model you will sell", "Your own Ollama, LM Studio or OpenAI-compatible compute (including a GPU reached over a tunnel). Hosted API keys are for personal routing, not resale.", ups.upstreams.some((u) => !u.builtin && !u.hosted), "connect", "Detect Ollama", ' data-detect="1"'],
    ["Choose models, prices and enable selling", "Select sources and model offers; set a default USDG price per million tokens or per-model overrides, then save. Connecting a source alone does not publish an offer.", !!(st.providing.enabled && st.providing.models > 0), "provide", "Models & pricing", ' data-tab="offer"'],
    ["Make this node reachable", relayed ? "Buyers reach you through relay <code>" + esc(st.node.relay.relay) + "</code>, no port forwarding needed." : reachable ? "Buyers reach you at " + esc(st.node.publicUrl) : "Your peer URL is " + esc(st.node.publicUrl) + ", which only this computer can open. Start with <code>--relay https://app.elyrainference.com</code> (no port forwarding), <code>--public-url</code> (a Cloudflare or Tailscale tunnel works from home) or another relay.", reachable, null],
    ["Configure settlement and redemption gas", "Use Payments → Escrow to match buyers' settlement; keep ETH for voucher redemption. Sellers do not need a buyer deposit just to serve their own model.", !!(onchain && ch?.connected && Number(ch.walletEth) >= MIN_GAS_ETH), "payments", "Review settlement", ' data-tab="escrow"'],
    ["Track earnings", "Review served usage, signed vouchers and paid-out USDG in Earnings. This step completes after the node records earnings; publishing an offer does not guarantee demand.", st.stats.earnedTotal > 0, "provide", "See earnings", ' data-tab="earnings"'],
  ];
}

/** Fetch what the steps need. The chain RPC can be slow: never hold the page up for more than 1.5 s. */
export async function guideContext() {
  const [routes, peers, ups, ch] = await Promise.all([
    api("/api/routes").then((r) => r.routes),
    api("/api/peers"),
    api("/api/upstreams"),
    Promise.race([api("/api/chain").catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))]),
  ]);
  return { ch, onchain: ch?.mode === "chain", routes, ups, peers };
}

export const stepsFor = (role, ctx) => (role === "sell" ? sellSteps : role === "local" ? localSteps : buySteps)(S.status, ctx);

/** Render a checklist into `el` (re-rendered only when its markup changes, so the 3 s refresh never shifts the page). The first unfinished step is NEXT. */
export function renderGuide(el, steps) {
  const done = steps.filter((s) => s[2]).length, nextIdx = steps.findIndex((s) => !s[2]);
  const pct = Math.round((done / steps.length) * 100);
  setHtml(el, `<div class="guide-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${done}" aria-label="Setup progress"><i style="width:${pct}%"></i></div>
    <div class="guide-meta">${done === steps.length ? "All set." : `${done} of ${steps.length} done`}</div><div class="steps">` +
    steps.map(([t, d, ok, go, cta, attrs = ""], i) =>
      `<div class="step ${ok ? "done" : ""} ${i === nextIdx ? "next" : ""}"><span class="no">${ok ? "✓" : i + 1}</span><div><h4>${t}${i === nextIdx ? ' <span class="badge live">Next</span>' : ""}</h4><p>${d}</p></div>${!ok && go ? `<button class="btn sm ${i === nextIdx ? "primary" : ""}" data-go="${go}"${attrs}>${cta}</button>` : ""}</div>`).join("") + "</div>");
  return { done, total: steps.length, next: nextIdx < 0 ? null : steps[nextIdx][0] };
}

export async function renderSteps(ctx) {
  const role = S.role;
  const r = renderGuide($("#ov-steps"), stepsFor(role, ctx));
  $$("#ov-role button").forEach((b) => {
    const selected = b.dataset.r === role;
    b.classList.toggle("on", selected);
    b.setAttribute("aria-pressed", String(selected));
  });
  return r;
}
