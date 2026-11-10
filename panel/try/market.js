// Market page: stats strip, model list with per-seller detail. Data comes from GET /pub/market (real offers only; a value that was not
// measured is null and is shown as such). Re-rendered from the "data" event, never on a timer of its own.
import { $, $$, el, icon, state, emit, on, price, tps, badge, settlement } from "./lib.js";
import { pay } from "./pay.js";

const view = { filter: "all", sort: "price", q: "", open: new Set() };

const speedCell = (o) => {
  const c = el("div", "cell num");
  if (o.speed == null) { c.textContent = "Not measured yet"; c.classList.add("muted"); }
  else { c.textContent = tps(o.speed); c.append(el("span", "sub", o.speedBasis === "claimed" ? "claimed by the seller" : "measured by this node")); }
  return c;
};
const refText = (r) => `${price(r.inPerM)} in / ${price(r.outPerM)} out`;

/** Try buttons: pick the model, then go to the playground */
function tryBtn(model) {
  const b = el("button", "btn primary sm", "Try"); b.type = "button"; b.setAttribute("aria-label", `Try ${model} in the playground`);
  b.addEventListener("click", (e) => { e.stopPropagation(); state.sel = model; state.pay = false; emit("choose", model); location.hash = "#/playground"; });
  return b;
}

/** Review a model's paid route before asking for a wallet or moving any funds. The router, not this row, selects the seller. */
function payBtn(model) {
  const b = el("button", "btn sm", "Review paid"); b.type = "button"; b.title = "Review the model's price limit and session funding in Playground"; b.setAttribute("aria-label", `Review paid routing for ${model}`);
  b.addEventListener("click", (e) => { e.stopPropagation(); state.sel = model; state.pay = true; emit("choose", model); location.hash = "#/playground"; });
  return b;
}

function priceCell(g) {
  const c = el("div", "cell num c-price");
  if (g.cheapest != null) { c.textContent = (g.offers.length > 1 ? "from " : "") + price(g.cheapest); if (g.chat) c.append(el("span", "sub", "free to try here")); }
  else if (g.chat) { c.textContent = "Free to try"; c.append(el("span", "sub", "not for sale yet")); }
  else c.textContent = "-";
  if (g.reference) { const r = el("span", "sub ref", "OpenRouter " + refText(g.reference)); r.title = `What ${g.reference.id} lists for on OpenRouter, per 1M tokens (input / output). A model of the same family and size at other providers; our sellers charge one price for both.`; c.append(r); }
  return c;
}

function detail(g) {
  const d = el("div", "detail");
  const prices = g.offers.filter((o) => o.price != null).map((o) => o.price);
  const summary = el("p", "refnote");
  summary.textContent = `${g.offers.length} reachable ${g.offers.length === 1 ? "offer" : "offers"}` + (prices.length ? ` · ${price(Math.min(...prices))}${Math.max(...prices) !== Math.min(...prices) ? "–" + price(Math.max(...prices)) : ""} / 1M tokens (input + output)` : " · no seller price published") + ". Compare each seller below; speed and reputation describe this node's observations, not a network-wide guarantee.";
  d.append(summary);
  if (pay.enabled && pay.payable(g.model, state.market)) d.append(el("p", "refnote", `Paid routing ceiling: $${pay.priceLimit(g.model, state.market)}/1M tokens, including the 5% quote allowance. Review paid selects the model, not this seller. The actual route and charge appear under the answer.`));
  if (g.reference) { const n = el("p", "refnote"); n.append("For reference, OpenRouter lists ", el("b", null, g.reference.id), ` at ${refText(g.reference)} per 1M tokens. Same family and size, other providers; for context, not a seller here.`); d.append(n); }
  for (const o of g.offers) {
    const r = el("div", "srow");
    const who = el("div", "who");
    const sub = el("span", "sub muted", o.reputation ? `★ ${o.reputation.score.toFixed(1)} · ${o.reputation.requests} requests` : "New, no history yet");
    { const bits = []; if (o.ttftMs != null) bits.push(`first token ${o.ttftMs} ms`); if (o.uptime != null) bits.push(`up ${Math.round(o.uptime * 100)}%`); if (bits.length) sub.textContent += " · " + bits.join(" · "); }
    who.append(el("b", null, o.seller), " ", el("span", "badge team", o.operator === "team" ? "Elyra team" : "Community"), o.where === "this-node" ? el("span", "muted", " · this node") : "", sub);
    const p = el("div", "cell num s-price", o.price == null ? (o.chat ? "Free to try" : "-") : price(o.price) + " / 1M");
    const sp = speedCell(o); sp.classList.add("s-speed");
    const pr = el("div", "cell s-priv"); pr.append(badge(o.privacy));
    const a = el("div", "cell act");
    if (o.chat) a.append(tryBtn(g.model));
    else if (o.where === "peer" && o.price != null && pay.enabled) a.append(payBtn(g.model));
    else { const s = el("span", "muted small", "Buy via your node"); s.title = "Peers are paid per token from your own wallet, so you reach them through your own Elyra node, not from this page."; a.append(s); }
    r.append(who, p, sp, pr, a); d.append(r);
  }
  return d;
}

function mrow(g) {
  const open = view.open.has(g.model);
  const li = el("li", "mrow" + (open ? " open" : ""));
  const head = el("div", "head");
  const name = el("button", "mname"); name.type = "button"; name.setAttribute("aria-expanded", String(open)); name.append(icon("M6 3l5 5-5 5", "chev"), el("span", null, g.model)); name.title = g.model;
  const sellers = el("div", "cell num c-sellers", String(g.sellers));
  const fastest = g.offers.filter((o) => o.speed != null).sort((a, b) => b.speed - a.speed)[0];
  const speed = speedCell(fastest ?? { speed: null }); speed.classList.add("c-speed");
  const priv = el("div", "cell c-priv"); for (const p of [...new Set(g.offers.map((o) => o.privacy))]) priv.append(badge(p), " ");
  const act = el("div", "cell act"); if (g.chat) act.append(tryBtn(g.model));
  if (pay.enabled && pay.payable(g.model, state.market)) act.append(g.chat ? " " : "", payBtn(g.model));
  head.append(name, sellers, priceCell(g), speed, priv, act);
  head.addEventListener("click", (e) => { if (!e.target.closest(".act")) toggle(g.model); });
  li.append(head);
  if (open) li.append(detail(g));
  return li;
}

function toggle(model) {
  view.open.has(model) ? view.open.delete(model) : view.open.add(model);
  const focused = document.activeElement?.classList.contains("mname") ? document.activeElement.title : null;
  renderList();
  if (focused) $$(".mname").find((b) => b.title === focused)?.focus({ preventScroll: true });
}

function renderList() {
  const m = state.market, list = $("#mlist"); list.replaceChildren();
  if (!m) { list.append(el("li", "mempty", "Could not reach the node. Retrying…")); return; }
  const needle = view.q.trim().toLowerCase();
  let models = m.models.filter((g) => (view.filter === "private" ? g.private : view.filter === "try" ? g.chat : true) && (!needle || g.model.toLowerCase().includes(needle)));
  // models nobody has priced yet sort last, not first
  const by = { price: (a, b) => (a.cheapest ?? Infinity) - (b.cheapest ?? Infinity), speed: (a, b) => (b.fastest ?? -1) - (a.fastest ?? -1), sellers: (a, b) => b.sellers - a.sellers };
  models = models.slice().sort((a, b) => by[view.sort](a, b) || a.model.localeCompare(b.model));
  if (!models.length) { list.append(el("li", "mempty", m.models.length ? needle ? `No model matches "${view.q.trim().slice(0, 40)}".` : "Nothing matches this filter." : "No models are online on this node right now. A seller's machine may be offline; it comes back on its own.")); return; }
  for (const g of models) list.append(mrow(g));
}

function renderStats() {
  const m = state.market, t = m?.totals;
  $("#s-models").textContent = t ? String(t.models) : "-";
  $("#s-sellers").textContent = t ? String(t.sellers) : "-";
  const c = $("#s-cheapest");
  if (!t) { c.textContent = "-"; c.title = ""; } else if (t.cheapest == null) { c.textContent = "-"; c.title = "No seller has priced a model yet"; } else { c.title = ""; c.textContent = price(t.cheapest); }
  const s = $("#s-settle"); s.textContent = m ? settlement(m.node) : "-"; s.classList.add("small");
  const live = $("#live"); live.classList.remove("on", "off");
  if (!m) { live.classList.add("off"); $("#live-t").textContent = "Could not reach the node"; }
  else if (t.sellers > 0) { live.classList.add("on"); $("#live-t").textContent = `Live · ${t.sellers} ${t.sellers === 1 ? "seller" : "sellers"} online · ${t.models} ${t.models === 1 ? "model" : "models"}`; }
  else { live.classList.add("off"); $("#live-t").textContent = "No seller online right now"; }
}

/** a link to one model (#m=llama3.2:1b) opens its sellers */
export function openModel(model) { view.open.add(model); renderList(); }

export function initMarket() {
  $$(".seg button").forEach((b) => b.addEventListener("click", () => {
    view.filter = b.dataset.f;
    $$(".seg button").forEach((x) => { x.classList.toggle("on", x === b); x.setAttribute("aria-pressed", String(x === b)); });
    renderList();
  }));
  $("#sort").addEventListener("change", (e) => { view.sort = e.target.value; renderList(); });
  $("#search").addEventListener("input", (e) => { view.q = e.target.value; renderList(); });
  on("data", () => { renderStats(); renderList(); });
  on("pay", renderList);
}
