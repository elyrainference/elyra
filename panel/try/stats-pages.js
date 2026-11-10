// The stats pages. Every number is measured (see stats-data.js). A page with nothing to show says so and points to the action that fills it.
import { el, chainCfg, PRIV } from "./lib.js";
import * as K from "./stats-kit.js";
import { daily, total, hasTraffic, history } from "./stats-data.js";

const { compact, usd, price, int, pct, card, h3, section, kpi, kpiRow, grid, note, pageHead, bars, dialKpi, chartCard, barChart, table, nameCell, empty } = K;
const mhref = (name) => "#m=" + encodeURIComponent(name);
const tps = (n) => (n == null ? "—" : n >= 100 ? String(Math.round(n)) : n.toFixed(1));
const ms = (n) => (n == null ? "—" : n < 1000 ? Math.round(n) + " ms" : (n / 1000).toFixed(1) + " s");
const SELL = ["Run a node, connect a model, and it is listed here with its real price and a reputation the router measures.", "Sell capacity", "#/sell"];
const explorerOf = (W) => W.info?.walletConnect?.explorer || null;
const noHistory = () => empty(history.status === "loading" ? "Loading traffic history…" : "Traffic history is not available from this node.");

// ---------- overview ----------
function overview(W) {
  const { m, info, offers, models, sellers } = W;
  const savings = models.filter((x) => x.save != null).map((x) => x.save).sort((a, b) => a - b);
  const median = savings.length ? savings[Math.floor(savings.length / 2)] : null;
  const answering = offers.filter((o) => o.chat && typeof o.speed === "number").length;
  const health = offers.length ? (answering / offers.length) * 100 : null;
  const out = [pageHead("Overview", "What this node sees right now: the models on offer, the sellers it can reach, and the traffic it has handled. One node's view, not the whole network.", "h-stats")];
  out.push(kpiRow(6,
    kpi("Models", int(models.length), models.length ? "on offer now" : "none yet", true),
    kpi("Sellers", int(sellers.length), sellers.length ? "reachable" : "none yet"),
    kpi("Cheapest", m?.totals?.cheapest != null ? price(m.totals.cheapest) : "—", "per 1M tokens"),
    dialKpi("Median saving", median ?? 0, median == null ? "–" : pct(median), median == null ? "needs a list price to compare" : "vs list price (avg in/out)", 250, 190),
    dialKpi("Health", health ?? 0, health == null ? "–" : pct(health), offers.length ? `${answering} of ${offers.length} offers answering` : "no offers yet", 8, 140),
    kpi("Free chats left", info?.today ? int(info.today.left) : "—", info?.limits ? `of ${int(info.limits.daily)} today` : "")));

  const rows = daily();
  out.push(section("Last 30 days"));
  if (history.status !== "ok") out.push(noHistory());
  else {
    out.push(kpiRow(4,
      kpi("Requests", int(total(rows, "requests")), `${int(total(rows, "visitor"))} playground · ${int(total(rows, "routed"))} routed · ${int(total(rows, "served"))} served`),
      kpi("Tokens", compact(total(rows, "tokens")), "prompt + completion"),
      kpi("Earned", usd(total(rows, "earned")), "from serving peers"),
      kpi("Spent", usd(total(rows, "spent")), "on paid peers")));
    out.push(grid(2,
      chartCard("Daily requests", rows, (r) => barChart(r, [{ key: "visitor", label: "Playground", cls: "c3" }, { key: "routed", label: "Routed", cls: "c1" }, { key: "served", label: "Served", cls: "c2" }]), [["c3", "Playground"], ["c1", "Routed"], ["c2", "Served"]]),
      chartCard("Daily tokens", rows, (r) => barChart(r, [{ key: "visitorTok", label: "Playground", cls: "c3" }, { key: "routedTok", label: "Routed", cls: "c1" }, { key: "servedTok", label: "Served", cls: "c2" }]), [["c3", "Playground"], ["c1", "Routed"], ["c2", "Served"]])));
    if (!hasTraffic(rows)) out.push(note(`No traffic recorded yet. Counting started ${history.data?.since || "today"}; the charts fill as people use the playground, route requests or serve peers.`));
  }

  const net = card(); net.append(h3("Network"));
  const kv = el("div", "sp-kvgrid");
  for (const [l, v, s] of [["Models", m?.totals?.models ?? "–", "on sale"], ["Sellers", m?.totals?.sellers ?? "–", "online"], ["Offers", m?.totals?.offers ?? "–", "advertised"], ["Peers", info?.peers ?? "–", "connected"]]) { const d = el("div"); d.append(el("div", "l", l), el("div", "n", String(v)), el("div", "c", s)); kv.append(d); }
  net.append(kv);
  const tm = card(); tm.append(h3("Models", Object.assign(el("a", "sp-sub2", "all →"), { href: "#/stats/models" })));
  tm.append(models.length ? bars([...models].sort((a, b) => b.sellers - a.sellers || b.requests - a.requests).slice(0, 6).map((x) => ({ name: x.name, value: x.sellers, valText: `${x.sellers} seller${x.sellers === 1 ? "" : "s"}`, href: mhref(x.name) }))) : el("p", "sp-note", "No models on offer."));
  const sl = card(); sl.append(h3("Sellers", Object.assign(el("a", "sp-sub2", "all →"), { href: "#/stats/sellers" })));
  sl.append(sellers.length ? bars([...sellers].sort((a, b) => (b.rep ?? -1) - (a.rep ?? -1)).slice(0, 6).map((x) => ({ name: x.name, value: x.rep ?? 0, valText: x.rep == null ? "unrated" : "rep " + x.rep.toFixed(1) }))) : el("p", "sp-note", "No sellers."));
  out.push(section("Right now"), grid(3, net, tm, sl));
  if (sellers.length <= 2) out.push(empty(...SELL));
  return out;
}

// ---------- network / models / sellers ----------
const privLabel = (p) => (PRIV[p] ?? PRIV.none)[0];
const whereLabel = (w) => (w === "this-node" ? "this node" : w || "—");
function network(W) {
  const out = [pageHead("Network", "One row per model and seller this node can reach, with the price and what the router measured.", "h-stats")];
  const sv = W.services;
  if (!sv.length) return [...out, empty("No offers yet. " + SELL[0], SELL[1], SELL[2])];
  const ok = sv.filter((s) => s.speed != null).length;
  out.push(kpiRow(3, kpi("Offers", int(sv.length), "model × seller", true), kpi("Peers", String(W.info?.peers ?? "–"), "connected to this node"), dialKpi("Answering", (ok / sv.length) * 100, pct((ok / sv.length) * 100), `${ok} of ${sv.length} offers have a measured speed`, 8, 140)));
  const cols = [
    { k: "model", label: "Model", cell: (r) => nameCell(r, r.model, mhref(r.model)) }, { k: "seller", label: "Seller" },
    { k: "where", label: "Where", cell: (r) => whereLabel(r.where) },
    { k: "price", label: "$ / 1M", n: true, cell: (r) => price(r.price) }, { k: "list", label: "List $/1M", n: true, cell: (r) => (r.list == null ? "—" : price(r.list)) },
    { k: "save", label: "Save", n: true, cell: (r) => (r.save == null ? "—" : pct(r.save)) },
    { k: "speed", label: "tok/s", n: true, cell: (r) => tps(r.speed) }, { k: "ttft", label: "First token", n: true, cell: (r) => ms(r.ttft) },
    { k: "privacy", label: "Privacy", cell: (r) => privLabel(r.privacy) }, { k: "rep", label: "Rep", n: true, cell: (r) => (r.rep == null ? "—" : r.rep.toFixed(1)) }, { k: "requests", label: "Requests", n: true }];
  const c = card(); c.append(table({ cols, rows: sv, sort: "price", dir: 1, limit: 25, search: "Search model or seller", searchKey: "model" }).node);
  out.push(c, note("Speed and first-token time are measured by this router on real requests. List price is the OpenRouter reference when this node has one; it is not a seller here."));
  return out;
}

function models(W) {
  const out = [pageHead("Models", "Every model on offer, with its cheapest price and how many sellers carry it.", "h-stats")];
  if (!W.models.length) return [...out, empty("No models on offer yet. " + SELL[0], SELL[1], SELL[2])];
  out.push(kpiRow(3, kpi("Models", int(W.models.length), "on offer", true), kpi("Offers", int(W.services.length), "model × seller"), kpi("With a list price", int(W.models.filter((x) => x.list != null).length), "comparable")));
  const cols = [
    { k: "name", label: "Model", cell: (r) => nameCell(r, r.name, mhref(r.name)) }, { k: "sellers", label: "Sellers", n: true },
    { k: "cheapest", label: "Cheapest $/1M", n: true, cell: (r) => price(r.cheapest) }, { k: "list", label: "List $/1M", n: true, cell: (r) => (r.list == null ? "—" : price(r.list)) },
    { k: "save", label: "Save", n: true, cell: (r) => (r.save == null ? "—" : pct(r.save)) },
    { k: "fastest", label: "Fastest tok/s", n: true, cell: (r) => tps(r.fastest) }, { k: "chat", label: "Chat", get: (r) => (r.chat ? 1 : 0), cell: (r) => (r.chat ? "yes" : "—") },
    { k: "priv", label: "Private", get: (r) => (r.priv ? 1 : 0), cell: (r) => (r.priv ? "yes" : "—") }, { k: "requests", label: "Requests", n: true }];
  const c = card(); c.append(table({ cols, rows: W.models, sort: "sellers", limit: 25, search: "Search models" }).node); out.push(c);
  out.push(catalog(W));
  return out;
}

// A catalog of popular open-weight models people can sell here. These are NOT sellers: "Sold here" is joined with the live market, so a
// model shows "yes" only when a seller really offers it. The pull tag is the model's name in the Ollama library.
const CATALOG = [
  ["Llama 3.3 70B", "Meta", "70B", "llama3.3:70b"], ["Llama 3.1 8B", "Meta", "8B", "llama3.1:8b"], ["Llama 3.2 3B", "Meta", "3B", "llama3.2:3b"], ["Llama 3.2 1B", "Meta", "1B", "llama3.2:1b"],
  ["Qwen3 32B", "Alibaba", "32B", "qwen3:32b"], ["Qwen3 8B", "Alibaba", "8B", "qwen3:8b"], ["Qwen2.5 Coder 7B", "Alibaba", "7B", "qwen2.5-coder:7b"],
  ["DeepSeek R1 14B", "DeepSeek", "14B", "deepseek-r1:14b"], ["Mistral Small 24B", "Mistral AI", "24B", "mistral-small:24b"], ["Mixtral 8x7B", "Mistral AI", "47B", "mixtral:8x7b"],
  ["Gemma 3 27B", "Google", "27B", "gemma3:27b"], ["Gemma 3 4B", "Google", "4B", "gemma3:4b"], ["Phi-4 14B", "Microsoft", "14B", "phi4:14b"],
  ["gpt-oss 20B", "OpenAI", "20B", "gpt-oss:20b"], ["gpt-oss 120B", "OpenAI", "120B", "gpt-oss:120b"]];
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
function catalog(W) {
  const sold = new Set(W.models.map((m) => norm(m.name)));
  const rows = CATALOG.map(([name, lab, size, tag]) => ({ name, lab, size, tag, sold: sold.has(norm(tag)) }));
  const c = card(); c.append(h3("Open-weight catalog"));
  c.append(note("Popular models you can sell here. Listing a model in this catalog does not mean anyone sells it: the Sold here column reads the live market."));
  c.append(table({ cols: [
    { k: "name", label: "Model" }, { k: "lab", label: "Lab" }, { k: "size", label: "Size" },
    { k: "sold", label: "Sold here", get: (r) => (r.sold ? 1 : 0), cell: (r) => (r.sold ? "yes" : "not yet") },
    { k: "tag", label: "Get it", cell: (r) => "ollama pull " + r.tag },
    { k: "act", label: "", get: () => 0, cell: (r) => (r.sold ? "" : Object.assign(el("a", "nm", "Sell it →"), { href: "#/sell" })) }],
    rows, sort: "sold", dir: -1, limit: 15, search: "Search catalog", searchKey: "name" }).node);
  return c;
}

function sellers(W) {
  const out = [pageHead("Sellers", "Who sells on the network this node can reach. A seller that connects shows up here by itself.", "h-stats")];
  if (!W.sellers.length) return [...out, empty("No sellers online. " + SELL[0], SELL[1], SELL[2])];
  out.push(kpiRow(3, kpi("Sellers", int(W.sellers.length), "reachable", true), kpi("Models", int(W.models.length), "on offer"), kpi("Requests measured", int(W.sellers.reduce((a, s) => a + s.requests, 0)), "by this router")));
  const cols = [
    { k: "name", label: "Seller", cell: (r) => nameCell(r, r.name) }, { k: "operator", label: "Operator" }, { k: "where", label: "Where", cell: (r) => whereLabel(r.where) },
    { k: "models", label: "Models", n: true }, { k: "price", label: "From $/1M", n: true, cell: (r) => price(r.price) }, { k: "speed", label: "Best tok/s", n: true, cell: (r) => tps(r.speed) },
    { k: "ttft", label: "First token", n: true, cell: (r) => ms(r.ttft) }, { k: "rep", label: "Rep", n: true, cell: (r) => (r.rep == null ? "—" : r.rep.toFixed(1)) }, { k: "requests", label: "Requests", n: true }];
  const c = card(); c.append(table({ cols, rows: W.sellers, sort: "rep", limit: 25, search: "Search sellers", searchKey: "name" }).node); out.push(c);
  if (W.sellers.length <= 3) out.push(empty(...SELL));
  return out;
}

// ---------- requests / revenue ----------
function requests() {
  const out = [pageHead("Requests", "Traffic this node has handled, per day (UTC): playground chats, requests it routed, and requests peers sent to it.", "h-stats")];
  if (history.status !== "ok") return [...out, noHistory()];
  const rows = daily();
  out.push(kpiRow(4, kpi("Requests · 30d", int(total(rows, "requests")), "all kinds", true), kpi("Playground", int(total(rows, "visitor")), "free visitor chats"), kpi("Routed", int(total(rows, "routed")), "sent out by this node"), kpi("Served", int(total(rows, "served")), "sent to this node by peers")));
  out.push(chartCard("Requests per day", rows, (r) => barChart(r, [{ key: "visitor", label: "Playground", cls: "c3" }, { key: "routed", label: "Routed", cls: "c1" }, { key: "served", label: "Served", cls: "c2" }], { w: 1080, h: 250 }), [["c3", "Playground"], ["c1", "Routed"], ["c2", "Served"]]));
  const c = card(); c.append(table({ cols: [
    { k: "d", label: "Day", get: (r) => r.d.getTime(), cell: (r) => K.dstr(r.d) }, { k: "visitor", label: "Playground", n: true }, { k: "routed", label: "Routed", n: true }, { k: "served", label: "Served", n: true },
    { k: "tokens", label: "Tokens", n: true, cell: (r) => compact(r.tokens) }, { k: "earned", label: "Earned", n: true, cell: (r) => usd(r.earned) }, { k: "spent", label: "Spent", n: true, cell: (r) => usd(r.spent) }],
    rows, sort: "d", dir: -1, limit: 31 }).node); out.push(c);
  out.push(note("Simulated and failed requests are not counted. Playground chats are counted from the day this node was updated; routed and served come from the node's route log (its most recent 2,000 requests)."));
  return out;
}

function revenue() {
  const out = [pageHead("Revenue", "What this node earned by serving peers and what it paid for routing, in USDG per day (UTC).", "h-stats")];
  if (history.status !== "ok") return [...out, noHistory()];
  const rows = daily(), e = total(rows, "earned"), s = total(rows, "spent"), sv = total(rows, "served");
  out.push(kpiRow(4, kpi("Earned · 30d", usd(e), "serving peers", true), kpi("Spent · 30d", usd(s), "paid peers"), kpi("Net", usd(e - s), "earned − spent"), kpi("Avg per served request", sv ? usd(e / sv) : "—", sv ? `${int(sv)} requests` : "none served yet")));
  out.push(grid(2, chartCard("Earned per day", rows, (r) => barChart(r, [{ key: "earned", label: "Earned", cls: "c2" }], { fmt: usd }), [["c2", "Earned"]]), chartCard("Spent per day", rows, (r) => barChart(r, [{ key: "spent", label: "Spent", cls: "c1" }], { fmt: usd }), [["c1", "Spent"]])));
  if (!e && !s) out.push(empty("Nothing earned or spent yet. A seller earns when a peer's paid request is served and its voucher is redeemed.", SELL[1], SELL[2]));
  return out;
}

// ---------- health / settlement / calculator ----------
function health(W) {
  const out = [pageHead("Health", "What the router measured about each seller: whether its offers answer, how fast, and its reputation.", "h-stats")];
  if (!W.sellers.length) return [...out, empty("No sellers to check yet.", SELL[1], SELL[2])];
  const rows = W.sellers.map((s) => ({ ...s, status: s.measured ? "healthy" : "unmeasured" })), ok = rows.filter((r) => r.status === "healthy").length;
  out.push(kpiRow(2, kpi("Sellers checked", int(rows.length), "", true), dialKpi("Healthy", (ok / rows.length) * 100, pct((ok / rows.length) * 100), `${ok} of ${rows.length} answered with a measured speed`, 8, 140)));
  const c = card(); c.append(table({ cols: [{ k: "name", label: "Seller", cell: (r) => nameCell(r, r.name) }, { k: "status", label: "Status" }, { k: "models", label: "Offers", n: true }, { k: "speed", label: "tok/s", n: true, cell: (r) => tps(r.speed) }, { k: "ttft", label: "First token", n: true, cell: (r) => ms(r.ttft) },
    { k: "uptime", label: "Uptime (1h)", n: true, cell: (r) => (r.uptime == null ? "—" : pct(r.uptime * 100)) }, { k: "rep", label: "Rep", n: true, cell: (r) => (r.rep == null ? "—" : r.rep.toFixed(1)) }], rows, sort: "rep", limit: 25 }).node); out.push(c);
  out.push(note("Unmeasured means no real request has been timed against that seller yet, not that it is down."));
  return out;
}

function settlement(W) {
  const out = [pageHead("Settlement", "How paid requests settle: buyers deposit USDG into an escrow contract, sign vouchers per request, sellers redeem them.", "h-stats")];
  const node = W.m?.node, ex = explorerOf(W), c = card(); c.append(h3("This node"));
  const kv = el("div", "sp-kvgrid"), slots = {};
  const put = (l, v, s, key) => { const d = el("div"), n = el("div", "n sm", v); if (key) slots[key] = n; d.append(el("div", "l", l), n, el("div", "c", s || "")); kv.append(d); };
  put("Settlement", node?.settlement === "chain" ? "On-chain" : "Off", "mode");
  put("Network", node?.network || "—", "chain");
  put("Token", "…", "payment token", "token"); put("Deposit cap", "…", "per wallet", "cap");
  c.append(kv); out.push(c);
  chainCfg().then((cfg) => { slots.token.textContent = cfg?.symbol || "—"; slots.cap.textContent = cfg?.maxDepositUsd != null ? "$" + cfg.maxDepositUsd : "—"; }).catch(() => {});
  if (node?.escrow) {
    const e = card(); e.append(h3("Escrow contract"));
    const a = el("a", "nm", node.escrow); if (ex) { a.href = ex + "/address/" + node.escrow; a.target = "_blank"; a.rel = "noopener"; }
    e.append(a, note(ex ? "Opens the contract on the block explorer, where every deposit and redeem is public." : "Block explorer link not available."));
    out.push(e);
  }
  const how = card(); how.append(h3("How a paid request settles"));
  const ol = el("ol", "sp-steps");
  for (const t of ["The buyer deposits USDG into the escrow (capped per wallet while Elyra is in beta).", "For each request the seller returns a signed receipt; the buyer checks the amount itself and signs a voucher for the running total.", "The seller redeems the latest voucher on-chain. Unredeemed vouchers are owed, never lost.", "The buyer can withdraw what is left after a 7-day delay."]) ol.append(el("li", null, t));
  how.append(ol, note("The escrow has had one AI-assisted review, not a professional audit. See the docs before depositing real funds.")); out.push(how);
  return out;
}

function calculator(W) {
  const out = [pageHead("Cost calculator", "Your monthly tokens, priced at a list price and at the cheapest Elyra seller.", "h-stats")];
  const opts = W.models.filter((m) => m.list != null && m.cheapest != null);
  if (!opts.length) return [...out, empty("No model has both a list price and a seller yet, so there is nothing to compare. This fills in when the node's reference prices cover an offered model.")];
  const c = card("sp-calc"), sel = el("select", "sp-input"), inI = el("input", "sp-input"), outI = el("input", "sp-input"), cache = el("input"); cache.type = "checkbox";
  sel.setAttribute("aria-label", "Model"); for (const m of opts) sel.append(Object.assign(el("option", null, m.name), { value: m.name }));
  for (const i of [inI, outI]) { i.type = "number"; i.min = "0"; i.step = "1"; }
  const res = el("div", "sp-calc-res"), set = (a, b) => { inI.value = a; outI.value = b; run(); };
  function run() {
    const m = opts.find((x) => x.name === sel.value); if (!m) return;
    const i = Math.max(0, +inI.value || 0), o = Math.max(0, +outI.value || 0), cs = cache.checked ? 0.6 : 0;
    const bill = (p) => (i * (1 - cs) + i * cs * 0.1 + o) * p, list = bill(m.list), ours = bill(m.cheapest);
    res.replaceChildren(kpi("At list price", usd(list), "per month"), kpi("Cheapest on Elyra", usd(ours), "per month"), kpi("You save", usd(list - ours), list ? pct(((list - ours) / list) * 100) + " less" : "", true));
  }
  const row = (lab, node) => { const d = el("label", "sp-field"); d.append(el("span", null, lab), node); return d; };
  const presets = K.chips([["light", "Light use"], ["coding", "Coding agent"], ["heavy", "Heavy team"]], "coding", (k) => (k === "light" ? set(2, 0.5) : k === "coding" ? set(120, 20) : set(1500, 250)));
  const cl = el("label", "sp-field row"); cl.append(cache, el("span", null, "+ cached input (60% of input tokens billed at 10%)"));
  c.append(presets, row("Model", sel), grid(2, row("Input tokens / month (millions)", inI), row("Output tokens / month (millions)", outI)), cl);
  sel.addEventListener("change", run); inI.addEventListener("input", run); outI.addEventListener("input", run); cache.addEventListener("change", run);
  set(120, 20); out.push(c, res, note("Elyra's market publishes one price per model per million tokens, so input and output are billed at it. List price is the OpenRouter average of input and output. Not a quote; prices change."));
  return out;
}

// ---------- token: $ELYRA is live on Robinhood Chain; the facts below were read from the contract (name, symbol, decimals, total supply) ----------
// Staking, rewards and free-AI-with-stake are NOT live: those pages say so.
const TICKER = "ELYRA";
const CA = "0x42cc3f36bb20481378bc0d84ebdfd4fe8f17fbf5";
const TOKEN_EXPLORER = "https://robinhoodchain.blockscout.com/token/" + CA;
const tk = () => "$" + TICKER;
const NOT_LIVE = ["Not live yet.", "$ELYRA exists on-chain, but this feature is not live. The page shows the plan, with no numbers, until it ships."];
const banner = () => K.banner(...NOT_LIVE);
const draft = (title, items) => { const c = card(); c.append(h3(title)); const ul = el("ul", "sp-steps"); for (const t of items) ul.append(el("li", null, t)); c.append(ul, note("Draft ideas, not decisions. They can change before launch.")); return c; };

function token() {
  const out = [pageHead("$" + TICKER, "Elyra's token on Robinhood Chain. Facts read from the contract.", "h-stats"), K.banner("Check the contract.", "Always verify the address below on the block explorer. Elyra is an unaudited beta; this is not financial advice.")];
  out.push(kpiRow(4, kpi("Name", "Elyra Inference", "token name", true), kpi("Ticker", "$" + TICKER, "symbol"), kpi("Total supply", "1,000,000,000", "18 decimals"), kpi("Chain", "Robinhood", "mainnet · 4663")));
  const c = card(); c.append(h3("Contract"));
  const row = el("div", "sp-ca"), code = el("code", null, CA), copy = el("button", "sp-more-btn", "Copy"), ex = Object.assign(el("a", "btn sm", "Explorer ↗"), { href: TOKEN_EXPLORER, target: "_blank", rel: "noopener" });
  copy.type = "button"; copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(CA); copy.textContent = "Copied"; } catch { copy.textContent = "Select + copy"; } setTimeout(() => (copy.textContent = "Copy"), 1600); });
  row.append(code, copy, ex); c.append(row, note("Holders, transfers and market data are on the explorer. This page does not repeat numbers it cannot read from the node."));
  out.push(c);
  const f = card(); f.append(h3("How it relates to payments"));
  const ul = el("ul", "sp-steps"); for (const t of ["Inference requests still settle in USDG through the escrow. The token is not needed to buy or sell.", "Staking, rewards and free requests for stake are not live. See those pages for the plan."]) ul.append(el("li", null, t));
  f.append(ul); out.push(f);
  return out;
}
function staking() {
  const out = [pageHead("Staking", `Lock ${tk()} behind a seller. Not live yet.`, "h-stats"), banner()];
  out.push(kpiRow(2, kpi("Total staked", "TBA", "not live", true), kpi("Average lock", "TBA", "not live")));
  out.push(empty("No staking pools yet. Pools appear here once the token and the staking contract are deployed and a seller opens one."));
  out.push(draft("How staking could work", ["A seller opens a pool and says what a staker gets (for example free requests per day).", "A longer lock gives more of that benefit.", "Stake stays in the staker's control and unlocks at the end of the lock."]));
  return out;
}
function freeAi() {
  const out = [pageHead("Free AI with stake", `Lock ${tk()} with a provider and it serves you free requests. Not live yet.`, "h-stats"), banner()];
  out.push(empty("No providers offer free requests for stake yet.", "Sell capacity", "#/sell"));
  out.push(draft("How it could work", ["A provider chooses how many free requests per day each tier of stake unlocks.", "The buyer picks a provider, locks tokens for 1 month, 6 months, 1 year or longer, and gets the free tier.", "Today the playground already gives a free daily quota on this node's own model, with no token."]));
  return out;
}
function rewards() {
  const out = [pageHead("Rewards", "What an epoch's emission could pay, and to whom. Not live yet.", "h-stats"), banner()];
  out.push(kpiRow(3, kpi("Usage vs target", "TBA", "not live", true), kpi("Stake vs target", "TBA", "not live"), kpi("Staker budget", "TBA", "not live")));
  out.push(empty("No emission schedule yet."));
  out.push(draft("How rewards could work", ["Part of each epoch's emission goes to sellers by the usage they served, part to buyers by what they spent, part to stakers.", "Rewards would be computed from on-chain settlements, so anyone can check them."]));
  return out;
}

// ---------- static pages ----------
function faq() {
  const out = [pageHead("FAQ", "Questions about these stats and the data behind them.", "h-stats")];
  const Q = [
    ["Where do these numbers come from?", "From this node only: its market feed (/pub/market, /pub/info) and per-day counters it keeps itself (/pub/stats). Nothing is estimated or generated. If something has not been measured yet, the page says so."],
    ["Why are there so few sellers?", "Elyra is an early beta. Sellers appear here when their node is reachable by this one. The more sellers connect, the more rows and the more traffic show up."],
    ["Can I sell here?", "Yes. Run a node, connect a model and make it reachable (a relay works behind a home router). It is listed with its real price, and the router measures its speed and reputation on real requests. See Sell."],
    ["Can I buy?", "Yes. The playground gives a free quota on this node's own model. To buy from other sellers, run your own node, fund the escrow with USDG and let the router pick a seller by price, speed, reputation or privacy."],
    ["Where does the money settle?", "Paid requests settle in USDG through an escrow contract on Robinhood Chain. The Settlement page links to the contract on the explorer."],
    ["Is there a token?", "Yes: $ELYRA on Robinhood Chain, contract 0x42cc3f36bb20481378bc0d84ebdfd4fe8f17fbf5. Verify it on the explorer. Inference payments still settle in USDG, and the token is not required to buy or sell. Staking and rewards are not live."],
    ["Is this audited?", "No. Elyra is an unaudited beta and the escrow has had one AI-assisted review. Do not deposit more than you can lose."],
    ["Where do list prices come from?", "When enabled, from the OpenRouter public model list, matched on family, version and size. They are references, not a seller on this network."]];
  for (const [q, a] of Q) { const d = el("details", "sp-faq"); d.append(el("summary", null, q), el("p", null, a)); out.push(d); }
  return out;
}
function about() {
  const out = [pageHead("About", "Elyra is an open, peer-to-peer market for AI inference.", "h-stats")], c = card();
  for (const t of ["Sellers run models on their own machines. A router on the buyer's side compares offers by price, speed, reputation and privacy, sends the prompt sealed to the chosen seller, and pays per request through an escrow in USDG.", "These pages show what one node can see and has handled. They are read straight from the node's public endpoints, so anyone running a node sees their own version.", "Source and docs are linked in the top bar."]) c.append(el("p", "sp-p", t));
  out.push(c); return out;
}
function changelog() {
  const out = [pageHead("Changelog", "What changed in the stats section. Newest first.", "h-stats")];
  for (const [d, t] of [["2026-11-10", "Stats show measured data only. New GET /pub/stats serves per-day counters (playground chats, routed and served requests, earned and spent USDG). Pages without a real source were removed."], ["2026-11-10", "Single theme across the public app."], ["2026-11-10", "New favicon."]]) { const c = card("sp-log"); c.append(el("b", null, d), el("p", "sp-p", t)); out.push(c); }
  return out;
}

function status(W) {
  const out = [pageHead("Status", "Live checks of the endpoints these pages read, run from your browser.", "h-stats")];
  const probes = [["Market feed", "/pub/market", (j) => `${j.totals?.models ?? 0} model(s), ${j.totals?.sellers ?? 0} seller(s)`], ["Node info", "/pub/info", (j) => `${j.name || "node"} · ${j.peers ?? 0} peer(s)`], ["Traffic history", "/pub/stats", (j) => `${j.days} days since ${j.since}`], ["Chain config", "/pub/chain", (j) => (j.enabled ? `${j.name} · ${j.symbol}` : "chain off")], ["Free quota", "/pub/quota", (j) => `tier ${j.tier ?? "?"}`]];
  const rows = probes.map(([name]) => ({ name, state: null, ms: null, detail: "" }));
  const tb = table({ cols: [{ k: "name", label: "Check" }, { k: "state", label: "Status", cell: (r) => (r.state == null ? "checking…" : r.state ? "ok" : "failed") }, { k: "ms", label: "Latency", n: true, cell: (r) => (r.ms == null ? "—" : r.ms + " ms") }, { k: "detail", label: "Detail" }], rows, sort: "name", dir: 1, limit: 20 });
  const ok = kpi("Checks passing", "…", "", true), lat = kpi("Slowest", "…", ""), net = kpi("Network", W.m?.node?.network || "–", W.m?.node?.settlement || "");
  out.push(kpiRow(3, ok, lat, net));
  const fin = () => { const done = rows.filter((r) => r.state != null); ok.querySelector(".v").textContent = `${rows.filter((r) => r.state).length}/${rows.length}`; lat.querySelector(".v").textContent = done.length ? Math.max(...done.map((r) => r.ms)) + " ms" : "…"; tb.setRows(rows); };
  probes.forEach(async ([name, url, fmt], i) => {
    const t0 = performance.now();
    try { const r = await fetch(url, { cache: "no-store" }); const j = r.ok ? await r.json() : null; rows[i] = { name, state: r.ok, ms: Math.round(performance.now() - t0), detail: j ? fmt(j) : "HTTP " + r.status }; }
    catch { rows[i] = { name, state: false, ms: Math.round(performance.now() - t0), detail: "no answer" }; }
    fin();
  });
  const c = card(); c.append(tb.node); out.push(c);
  return out;
}

export const PAGES = {
  "": [overview, "Overview"], network: [network, "Network"], models: [models, "Models"], sellers: [sellers, "Sellers"], requests: [requests, "Requests"], revenue: [revenue, "Revenue"],
  staking: [staking, "Staking"], free: [freeAi, "Free AI"], token: [token, "Token"], rewards: [rewards, "Rewards"],
  settlement: [settlement, "Settlement"], health: [health, "Health"], calculator: [calculator, "Calculator"], faq: [faq, "FAQ"], about: [about, "About"], changelog: [changelog, "Changelog"], status: [status, "Status"],
};
