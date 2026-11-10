// Stats section (#/stats and #/stats/<page>): sub-navigation + router. The pages themselves are in stats-pages.js, data in stats-data.js,
// building blocks in stats-kit.js. Rows tagged Live come from this node's /pub/market and /pub/info; rows tagged Sample are seeded placeholders.
// No dependencies, no inline code (CSP), text only via textContent.
import { $, el, on } from "./lib.js";
import { PAGES } from "./stats-pages.js";
import { world, loadHistory } from "./stats-data.js";

const MAIN = ["", "network", "models", "sellers", "staking", "free", "token"];
const MORE = ["requests", "revenue", "rewards", "settlement", "health", "calculator", "faq", "about", "changelog", "status"];
const NAMES = { "": "Home", free: "Free AI", token: "Token" };
const label = (k) => NAMES[k] ?? PAGES[k][1];
const hrefOf = (k) => "#/stats" + (k ? "/" + k : "");

function current() {
  const m = /^#\/?stats(?:\/([a-z]+))?/.exec(location.hash || "");
  const k = m?.[1] ?? "";
  return PAGES[k] ? k : "";
}

function subnav(active) {
  const nav = el("nav", "sp-nav"); nav.setAttribute("aria-label", "Stats");
  for (const k of MAIN) { const a = el("a", "sp-pill", label(k)); a.href = hrefOf(k); if (k === active) a.setAttribute("aria-current", "page"); nav.append(a); }
  const d = el("details", "sp-moremenu"), s = el("summary", "sp-pill", "More ▾"), menu = el("div", "sp-menu");
  for (const k of MORE) { const a = el("a", "sp-item", label(k)); a.href = hrefOf(k); if (k === active) a.setAttribute("aria-current", "page"); menu.append(a); }
  if (MORE.includes(active)) s.setAttribute("data-on", "1");
  d.append(s, menu); nav.append(d); return nav;
}

let busy = false;
function render() {
  const root = $("#stats-root"); if (!root || busy) return;
  const k = current(), [build, name] = PAGES[k];
  const sx = window.scrollX, sy = window.scrollY;
  const frag = document.createDocumentFragment();
  frag.append(subnav(k), ...build(world()));
  root.replaceChildren(frag);
  if (document.body.dataset.route === "stats") document.title = (k ? name + " · " : "") + "Stats · Elyra";
  return [sx, sy];
}

let lastKey = null;
export function initStats() {
  const go = () => { const k = current(); const pos = render(); if (k !== lastKey) { lastKey = k; window.scrollTo(0, 0); } else if (pos) window.scrollTo(pos[0], pos[1]); };
  on("data", () => { if (document.body.dataset.route === "stats" && !document.querySelector(".sp-moremenu[open]") && !document.activeElement?.closest?.(".sp-tools, .sp-calc, .sp-chips")) go(); });
  addEventListener("hashchange", () => { if (document.body.dataset.route === "stats") go(); });
  document.addEventListener("click", (e) => { const d = $(".sp-moremenu[open]"); if (d && !d.contains(e.target)) d.removeAttribute("open"); else if (d && e.target.closest(".sp-item")) d.removeAttribute("open"); });
  // traffic history: fetched when the page opens and then every 30 s while it is the visible route
  const refresh = () => loadHistory().then(() => { if (document.body.dataset.route === "stats" && !document.activeElement?.closest?.(".sp-tools, .sp-calc, .sp-chips")) go(); });
  refresh(); setInterval(() => { if (document.body.dataset.route === "stats" && document.visibilityState === "visible") refresh(); }, 30000);
  go();
}
