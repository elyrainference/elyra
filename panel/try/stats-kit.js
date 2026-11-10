// Building blocks for the stats pages: formatters, LIVE/SAMPLE tags, cards, KPI tiles, SVG charts, sortable tables, chips.
// No dependencies, no inline code (CSP), text only via textContent. Charts are hand-built SVG.
import { el } from "./lib.js";

const NS = "http://www.w3.org/2000/svg";
export const svg = (tag, attrs = {}, kids = []) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const k of kids) e.append(k);
  return e;
};
const svgTitle = (t) => { const e = svg("title"); e.textContent = t; return e; };

// ---------- formatting ----------
export const compact = (n) => {
  if (n == null || Number.isNaN(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 1 : 2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 1 : 2) + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 1 : 2) + "k";
  return String(Math.round(n));
};
export const usd = (n) => (n == null ? "—" : n >= 1000 ? "$" + compact(n) : "$" + n.toFixed(n >= 100 ? 0 : n >= 1 ? 2 : 4));
export const price = (n) => (n == null ? "—" : n === 0 ? "Free" : "$" + n.toFixed(n >= 1 ? 2 : n >= 0.01 ? 3 : 4));
export const int = (n) => (n == null ? "—" : Math.round(n).toLocaleString("en-US"));
export const pct = (n, d = 0) => (n == null ? "—" : (n < 0 ? "−" : "") + Math.abs(n).toFixed(d) + "%");
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const dstr = (d) => d.toISOString().slice(0, 10);
export const ago = (mins) => (mins < 1 ? "now" : mins < 60 ? Math.round(mins) + "m ago" : mins < 1440 ? Math.round(mins / 60) + "h ago" : Math.round(mins / 1440) + "d ago");
export const trimAxis = (f) => (n) => f(n).replace(/(\.\d*?)0+(?=[A-Za-z]|$)/, "$1").replace(/\.(?=[A-Za-z]|$)/, "");
export const niceMax = (v) => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)), f = v / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; };
export const shortHash = (h) => h.slice(0, 8) + "…" + h.slice(-4);

// ---------- tags, cards, KPI ----------
export const card = (cls = "") => el("div", "sp-card " + cls);
export const h3 = (text, extra) => { const h = el("h3"); h.append(el("span", null, text)); if (extra) h.append(extra); return h; };
export const section = (text) => el("h2", "sp-h", text);
export const kpi = (label, value, sub, accent) => {
  const k = el("div", "sp-kpi" + (accent ? " accent" : ""));
  k.append(el("div", "l", label), el("div", "v", value), el("div", "c", sub || "")); return k;
};
export const kpiRow = (n, ...kids) => { const g = el("div", "sp-kpis k" + n); g.append(...kids); return g; };
export const grid = (n, ...kids) => { const g = el("div", "sp-g" + n); g.append(...kids); return g; };
export const note = (text) => el("p", "sp-note", text);
export const banner = (title, text) => { const b = el("div", "sp-banner"); b.append(el("b", null, title), el("span", null, " " + text)); return b; };
export function pageHead(title, sub, id) {
  const top = el("div", "sp-top"), tl = el("div"), h = el("h1", "sp-title", title);
  if (id) { h.id = id; h.tabIndex = -1; }
  tl.append(h); if (sub) tl.append(el("p", "sp-sub", sub));
  top.append(tl); return top;
}
export function bars(rows, { fmt = compact, link } = {}) {
  // rows: [{name, value, live, sub?, href?}]
  const ol = el("ol", "sp-list"), mx = Math.max(1, ...rows.map((r) => r.value || 0));
  rows.forEach((r, i) => {
    const li = el("li", "sp-row"), bg = el("span", "sp-bar-bg"), fill = el("span", "sp-bar-fill");
    fill.style.width = Math.max(3, ((r.value || 0) / mx) * 100) + "%"; bg.append(fill);
    const nm = r.href ? Object.assign(el("a", "nm", r.name), { href: r.href }) : el("span", "nm", r.name);
    li.append(el("span", "rank", String(i + 1)), nm, el("span", "val", r.valText ?? fmt(r.value)), bg); ol.append(li);
  });
  return ol;
}

// ---------- gauge ----------
export function gauge(value, text, hueFrom, hueTo) {
  const N = 36, R = 82, C = 100, s = svg("svg", { viewBox: "0 0 200 118", class: "sp-gauge", role: "img", "aria-label": text });
  const lit = Math.round((clamp(value, 0, 100) / 100) * N);
  for (let i = 0; i < N; i++) {
    const a0 = Math.PI * (1 - i / N), a1 = Math.PI * (1 - (i + 0.82) / N), p = (a) => `${(C + R * Math.cos(a)).toFixed(2)} ${(C - R * Math.sin(a)).toFixed(2)}`;
    const on = i < lit, hue = hueFrom + ((hueTo - hueFrom) * i) / (N - 1);
    s.append(svg("path", { d: `M ${p(a0)} A ${R} ${R} 0 0 1 ${p(a1)}`, class: "sp-seg" + (on ? " on" : ""), stroke: on ? `hsl(${hue.toFixed(0)} 78% 58%)` : "currentColor" }));
  }
  const t = svg("text", { x: 100, y: 100, "text-anchor": "middle", class: "sp-gauge-t" }); t.textContent = text; s.append(t); return s;
}
export function dialKpi(label, value, text, sub, hf, ht) {
  const c = el("div", "sp-kpi dial"), d = el("div", "v");
  d.append(gauge(value ?? 0, text, hf, ht)); c.append(el("div", "l", label), d, el("div", "c", sub || "")); return c;
}

// ---------- charts ----------
const mon = (d) => d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
export const RANGES = { "7d": 7, "14d": 14, "30d": 30 };

/** stacked bars (+ optional line on a right axis). rows need a `d` Date. series: [{key,label,cls}] */
export function barChart(rows, series, { fmt = compact, line, lineFmt, w = 520, h = 210 } = {}) {
  const L = 40, Rr = line ? 44 : 8, T = 8, B = 24, iw = w - L - Rr, ih = h - T - B;
  const s = svg("svg", { viewBox: `0 0 ${w} ${h}`, class: "sp-chart", role: "img", "aria-label": "Chart" });
  const max = niceMax(Math.max(...rows.map((r) => series.reduce((a, k) => a + r[k.key], 0))) * 1.05);
  for (let i = 0; i <= 4; i++) {
    const y = T + ih - (ih * i) / 4;
    s.append(svg("line", { x1: L, x2: L + iw, y1: y, y2: y, class: "sp-grid" }));
    const t = svg("text", { x: L - 6, y: y + 3.5, "text-anchor": "end", class: "sp-ax" }); t.textContent = trimAxis(fmt)((max * i) / 4); s.append(t);
    if (line) { const t2 = svg("text", { x: L + iw + 6, y: y + 3.5, class: "sp-ax" }); t2.textContent = trimAxis(lineFmt || fmt)((line.max * i) / 4); s.append(t2); }
  }
  const n = rows.length, bw = iw / n, gap = n > 60 ? 0.5 : n > 20 ? 1.5 : 4;
  rows.forEach((r, i) => {
    let y = T + ih; const g = svg("g", {}, [svgTitle(`${dstr(r.d)}\n` + series.map((k) => `${k.label}: ${fmt(r[k.key])}`).join("\n"))]);
    for (const k of series) { const bh = (r[k.key] / max) * ih; y -= bh; g.append(svg("rect", { x: (L + i * bw + gap / 2).toFixed(2), y: y.toFixed(2), width: Math.max(0.6, bw - gap).toFixed(2), height: Math.max(0, bh).toFixed(2), class: "sp-bar " + k.cls })); }
    s.append(g);
  });
  if (line) s.append(svg("polyline", { points: rows.map((r, i) => `${(L + i * bw + bw / 2).toFixed(1)},${(T + ih - (r[line.key] / line.max) * ih).toFixed(1)}`).join(" "), class: "sp-line" }));
  const every = n <= 10 ? 1 : n <= 35 ? 7 : 0; let last = -1;
  rows.forEach((r, i) => {
    const mo = r.d.getUTCMonth(); let show;
    if (every) show = i % every === 0; else { show = mo !== last; last = mo; }
    if (!show) return;
    const t = svg("text", { x: L + i * bw + bw / 2, y: h - 7, "text-anchor": "middle", class: "sp-ax" }); t.textContent = every ? `${mon(r.d)} ${r.d.getUTCDate()}` : mon(r.d); s.append(t);
  });
  return s;
}

/** x/y curves on a 0..1 square (Lorenz curves). curves: [{pts:[[x,y]...], cls, label}] */
export function lorenz(curves, { w = 300, h = 220 } = {}) {
  const L = 34, T = 8, B = 24, Rr = 8, iw = w - L - Rr, ih = h - T - B;
  const s = svg("svg", { viewBox: `0 0 ${w} ${h}`, class: "sp-chart", role: "img", "aria-label": "Lorenz curve" });
  for (let i = 0; i <= 4; i++) {
    const y = T + ih - (ih * i) / 4, x = L + (iw * i) / 4;
    s.append(svg("line", { x1: L, x2: L + iw, y1: y, y2: y, class: "sp-grid" }));
    const t = svg("text", { x: L - 6, y: y + 3.5, "text-anchor": "end", class: "sp-ax" }); t.textContent = i * 25 + "%"; s.append(t);
    const tx = svg("text", { x, y: h - 7, "text-anchor": "middle", class: "sp-ax" }); tx.textContent = i * 25 + "%"; s.append(tx);
  }
  s.append(svg("line", { x1: L, y1: T + ih, x2: L + iw, y2: T, class: "sp-diag" }));
  for (const c of curves) s.append(svg("polyline", { points: c.pts.map(([x, y]) => `${(L + x * iw).toFixed(1)},${(T + ih - y * ih).toFixed(1)}`).join(" "), class: "sp-curve " + c.cls }, [svgTitle(c.label)]));
  return s;
}

export function spark(vals, up) {
  const w = 64, h = 20, mx = Math.max(...vals, 1e-9), mn = Math.min(...vals), r = mx - mn || 1;
  const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((v - mn) / r) * (h - 4)).toFixed(1)}`).join(" ");
  return svg("svg", { viewBox: `0 0 ${w} ${h}`, class: "sp-spark" + (up ? " up" : ""), width: w, height: h, "aria-hidden": "true" }, [svg("polyline", { points: pts })]);
}

export function chips(options, active, onPick, cls = "") {
  const wrap = el("div", "sp-chips " + cls);
  for (const [k, label] of options) {
    const b = el("button", "sp-chip", label); b.type = "button"; b.dataset.k = k; b.setAttribute("aria-pressed", String(k === active));
    b.addEventListener("click", () => { for (const x of wrap.children) x.setAttribute("aria-pressed", String(x === b)); onPick(k); });
    wrap.append(b);
  }
  return wrap;
}

/** a chart card with 7D/30D/90D/ALL chips; `series` is the full sample series, `build(rows)` returns an svg */
export function chartCard(titleText, series, build, legend) {
  const c = card("sp-chartcard"), head = el("div", "sp-chead"), body = el("div", "sp-chart-body");
  const draw = (k) => body.replaceChildren(build(series.slice(-RANGES[k])));
  head.append(h3(titleText), chips(Object.keys(RANGES).map((k) => [k, k.toUpperCase()]), "30d", draw, "sp-seg-chips"));
  const lg = el("div", "sp-legend"); for (const [cls, label] of legend) lg.append(el("span", "sw " + cls), label);
  c.append(head, body, lg); draw("30d"); return c;
}

// ---------- table ----------
/** cols: [{k,label,n?:right-align,get(row)=>sort value,cell(row)=>string|Node,info?}] ; returns {node,setRows(rows)} */
export function table({ cols, rows, sort, dir = -1, limit = 25, search, searchKey, empty = "Nothing here yet." }) {
  const wrap = el("div", "sp-tablewrap"), tools = el("div", "sp-tools"), t = el("table", "sp-tbl"), thead = el("thead"), tbody = el("tbody"), more = el("button", "sp-more-btn");
  more.type = "button"; more.hidden = true;
  let data = rows, sk = sort ?? cols[0].k, sd = dir, q = "", shown = limit;
  const col = (k) => cols.find((c) => c.k === k);
  const val = (c, r) => (c.get ? c.get(r) : r[c.k]);
  const trh = el("tr"), ths = new Map();
  for (const c of cols) {
    const th = el("th", c.n ? "n" : ""), b = el("button", "sp-th", c.label); b.type = "button"; if (c.title) b.title = c.title;
    b.addEventListener("click", () => { if (sk === c.k) sd = -sd; else { sk = c.k; sd = c.n ? -1 : 1; } paint(); });
    th.append(b); ths.set(c.k, th); trh.append(th);
  }
  thead.append(trh);
  function paint() {
    for (const [k, th] of ths) th.setAttribute("aria-sort", k === sk ? (sd > 0 ? "ascending" : "descending") : "none");
    const c = col(sk);
    let list = data.filter((r) => !q || String(r[searchKey ?? cols[0].k] ?? "").toLowerCase().includes(q));
    list = [...list].sort((a, b) => { const x = val(c, a), y = val(c, b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (typeof x === "string" ? x.localeCompare(y) : x - y) * sd; });
    tbody.replaceChildren();
    if (!list.length) { const tr = el("tr"), td = el("td", "empty", empty); td.colSpan = cols.length; tr.append(td); tbody.append(tr); }
    list.slice(0, shown).forEach((r, ri) => { const tr = el("tr"); for (const cc of cols) { const td = el("td", cc.n ? "n" : ""); const v = cc.index ? ri + 1 : cc.cell ? cc.cell(r) : val(cc, r); if (v instanceof Node) td.append(v); else td.textContent = v == null ? "—" : String(v); tr.append(td); } tbody.append(tr); });
    more.hidden = list.length <= shown; more.textContent = `Show more (${list.length - shown} left)`;
  }
  more.addEventListener("click", () => { shown += limit; paint(); });
  if (search) {
    const i = el("input", "sp-search"); i.type = "search"; i.placeholder = search; i.setAttribute("aria-label", search);
    i.addEventListener("input", () => { q = i.value.trim().toLowerCase(); shown = limit; paint(); }); tools.append(i);
  }
  t.append(thead, tbody); wrap.append(...(search ? [tools] : []), el("div", "sp-scroll", null), more);
  wrap.querySelector(".sp-scroll").append(t);
  paint();
  return { node: wrap, tools, setRows(r) { data = r; paint(); } };
}
/** a name cell: plain text or a link */
export function nameCell(r, text, href) {
  return href ? Object.assign(el("a", "nm", text), { href }) : document.createTextNode(text);
}
/** an empty state with one action */
export function empty(text, actionLabel, href) {
  const c = card("sp-empty"); c.append(el("p", null, text));
  if (actionLabel) c.append(Object.assign(el("a", "btn primary", actionLabel), { href }));
  return c;
}
