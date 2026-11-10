// Hash navigation. Owns: which view is shown (S.view), nav highlight, breadcrumb, scroll reset. Must not: fetch data (views do, in enter()).
import { $, $$, esc, reveal, setHtml } from "./lib/dom.js";
import { groupOf, openGroupOf, VIEWS } from "./lib/nav.js";
import { S } from "./lib/store.js";
import { toast } from "./components/toast.js";
import { views } from "./views/index.js";

const known = (v) => VIEWS.some((x) => x[0] === v);
let tabLabel = "";

/** Node name / group / page [/ tab]. The node name and the page link back to Home / the page; the last segment is the current place. */
export function renderCrumb() {
  const v = VIEWS.find((x) => x[0] === S.view), sep = '<span class="sep-s" aria-hidden="true">/</span>', hsep = sep.replace("sep-s", "sep-s h");
  const head = `<a href="#overview" data-view="overview" class="c-node">${esc(S.status?.node?.name ?? "Router")}</a>${hsep}<span class="c-grp">${esc(groupOf(S.view))}</span>${hsep}`;
  setHtml($("#crumb"), head + (tabLabel ? `<a href="#${S.view}" data-view="${S.view}">${esc(v[1])}</a>${sep}<b aria-current="page">${esc(tabLabel)}</b>` : `<b aria-current="page">${esc(v[1])}</b>`));
  document.title = `${tabLabel ? tabLabel + " · " : ""}${v[1]} · Elyra Router`;
}

function show(view) {
  S.view = view; tabLabel = "";
  $$(".nav").forEach((b) => {
    const on = b.dataset.view === view;
    b.classList.toggle("on", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  $$(".view").forEach((v) => v.classList.toggle("on", v.id === "v-" + view));
  openGroupOf(view);
  renderCrumb();
}

export function go(view, pre = {}) {
  if (!known(view)) view = "overview";
  views[S.view]?.leave?.(); // a view that holds a connection or timers (Live) lets go of them here
  S.pre = pre;
  history.replaceState(null, "", "#" + view);
  show(view);
  $("#scroll").scrollTop = 0;
  Promise.resolve(views[view].enter()).then(() => { if (pre.focus && view !== "payments") reveal(pre.focus); }).catch((e) => toast(e.message, "err"));
}

// pick the initial view from the URL hash; the first successful status poll renders it
export function showInitialView() {
  const start = location.hash.slice(1);
  show(known(start) ? start : "overview");
}

export function watchHash() {
  window.addEventListener("hashchange", () => { const v = location.hash.slice(1); if (v !== S.view && S.online) go(v); });
  document.addEventListener("elyra:tab", (e) => { if (e.detail.view === S.view) { tabLabel = e.detail.label; renderCrumb(); } });
  document.addEventListener("elyra:status", renderCrumb);
}

export const enterCurrent = () => Promise.resolve(views[S.view].enter()).catch((e) => toast(e.message, "err"));
export const tickCurrent = () => { if (S.online && !document.hidden) views[S.view].tick?.()?.catch?.(() => {}); };
