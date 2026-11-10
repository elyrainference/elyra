// Public page entry: hash router (#/market, #/playground, #/sell), the shared data poll, copy buttons.
// ES modules, no dependencies and no inline code (CSP script-src 'self'). The pages themselves live in market.js, chat.js, wallet.js (wallet, sign-in, username) and pay.js (pay-per-use session).
import { $, $$, state, emit, on, getJson, loadQuota, paidCard, clock, settlement } from "./lib.js";
import { initMarket, openModel } from "./market.js";
import { initChat } from "./chat.js";
import { initWallet } from "./wallet.js";
import { initPay } from "./pay.js";
import { initStats } from "./stats.js";
import { pay } from "./pay.js";

const TITLES = { market: "Market", playground: "Playground", sell: "Sell capacity", stats: "Stats" };

// ---- router ----
function parse() {
  const h = (() => { try { return decodeURIComponent(location.hash || ""); } catch { return ""; } })();
  const m = /^#m=(.{1,120})$/.exec(h); // a link to one model: /#m=llama3.2:1b opens its sellers on the market page
  if (m) return { route: "market", model: m[1] };
  const r = /^#\/?(market|playground|stats|sell)\b/.exec(h);
  return { route: r ? r[1] : "market" };
}
let first = true;
function show() {
  const { route, model } = parse();
  document.body.dataset.route = route;
  for (const p of $$(".page")) p.hidden = p.dataset.page !== route;
  for (const a of $$("#nav a[data-route]")) { if (a.dataset.route === route) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }
  document.title = `${TITLES[route]} · Elyra`;
  if (model) openModel(model);
  if (route === "playground") $("#msgs").scrollTop = $("#empty").hidden ? $("#msgs").scrollHeight : 0; else window.scrollTo(0, 0);
  if (!first) $(`.page[data-page="${route}"] h1`)?.focus({ preventScroll: true }); // announce the new page to keyboard and screen-reader users
  first = false;
}

// ---- data ----
let sig = "";
function footerLine() {
  const i = state.info, m = state.market, n = $("#nodeline");
  if (!i || !m) return;
  n.textContent = [m.node.name || "This node", `${i.peers} ${i.peers === 1 ? "peer" : "peers"} connected`, settlement(m.node).toLowerCase(), `${i.today.left} of ${i.limits.daily} free chats left today`, "Elyra is an early build; answers come from small models and can be wrong"].join(" · ");
}
function accessContext() {
  const gw = !!state.info?.gateway;
  $("#try-access").textContent = gw
    ? "This deployment requires wallet sign-in and a username for its free hosted quota. Browse and compare without signing in. The signature moves no funds; no escrow deposit is needed."
    : "This deployment offers a free hosted quota without sign-in. Wallet sign-in is optional for a larger quota. No escrow deposit is needed.";
  $("#paid-access").textContent = pay.enabled
    ? "Browser paid sessions are enabled here. Choose Review paid on an offer, check the price ceiling, then create and fund a session only if you want to pay. Your own node is another option."
    : "Browser payment is not enabled here. Use your own node for paid peer requests; this public Playground only uses the free hosted quota. Signing in does not unlock paid routing.";
  for (const p of $$("[data-paid-copy]")) p.textContent = pay.enabled
    ? "Paid browser sessions are enabled. Review a model in Market, create a session and deposit USDG in the wallet menu, then send in paid peer mode. Check Session & usage and each answer's Route and cost. Free chat never needs a deposit."
    : "Browser payment is disabled on this deployment. Use your own node for paid peer routing; its Payments view holds your node's escrow and receipt ledger. Free hosted try does not need a deposit.";
}
async function load() {
  const [m, i] = await Promise.allSettled([getJson("/pub/market"), getJson("/pub/info")]);
  state.market = m.status === "fulfilled" ? m.value : null;
  if (i.status === "fulfilled") state.info = i.value;
  await loadQuota(); state.loaded = true;
  const s = JSON.stringify(state.market && { ...state.market, at: 0 }) + "|" + JSON.stringify(state.info?.today) + "|" + JSON.stringify(state.quota);
  $("#updated").textContent = state.market ? "Updated " + clock(new Date().toISOString()) : "";
  if (s !== sig) { sig = s; footerLine(); emit("data"); }
}

// ---- copy buttons: copy the <pre> of the code block they sit in ----
document.addEventListener("click", async (e) => {
  const b = e.target.closest(".copy"); if (!b) return;
  const pre = b.closest(".code")?.querySelector("pre"); if (!pre) return;
  try { await navigator.clipboard.writeText(pre.textContent); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1500); } catch { b.textContent = "Press Ctrl+C"; }
});

initMarket(); initChat(); initWallet(); initPay(); initStats();
$("#market-paid").append(paidCard());
on("reload", load);
on("data", accessContext);
on("pay", accessContext);
addEventListener("hashchange", show);
show();
load();
setInterval(() => { if (document.visibilityState === "visible") load(); }, 20000);
