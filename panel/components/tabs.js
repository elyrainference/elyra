// In-page tabs. tabBar(items, active) draws the tab strip; any element inside the view with data-pane="a b" belongs to those tabs and is shown
// only while one of them is active (class .pane-off, never the `hidden` attribute, which views use for their own state). The choice is kept per
// view in S.tabs, so a view that is re-entered keeps it, and S.pre.tab ("jump to Provide / Go-live") wins once. Breadcrumbs listen for "elyra:tab".
import { $, $$, esc } from "../lib/dom.js";
import { S } from "../lib/store.js";

export const tabBar = (items, active) =>
  `<div class="tabs" role="tablist">${items.map(([id, label]) => `<button type="button" role="tab" class="tab${id === active ? " on" : ""}" data-t="${id}" aria-selected="${id === active}" tabindex="${id === active ? 0 : -1}">${esc(label)}</button>`).join("")}</div>`;

/** The tab to open: a one-shot hint from navigation, else the remembered one, else the first. */
export function pickTab(view, items) {
  const hint = S.pre.tab; delete S.pre.tab; // a navigation hint is used once; later re-renders keep the tab the user chose
  const want = hint ?? S.tabs[view];
  return items.some((x) => x[0] === want) ? want : items[0][0];
}

function apply(root, view, id) {
  S.tabs[view] = id;
  for (const b of $$(".tab", root)) { const on = b.dataset.t === id; b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; }
  for (const p of $$("[data-pane]", root)) p.classList.toggle("pane-off", !p.dataset.pane.split(" ").includes(id));
  document.dispatchEvent(new CustomEvent("elyra:tab", { detail: { view, label: $(`.tab[data-t="${id}"]`, root)?.textContent ?? "" } }));
}

/** Wire the strip inside `root` (a view section) and show tab `id`. Returns a function that switches tab. */
export function initTabs(root, view, id) {
  const bar = $(".tabs", root);
  bar.onclick = (e) => { const b = e.target.closest(".tab"); if (b) apply(root, view, b.dataset.t); };
  bar.onkeydown = (e) => {
    const tabs = $$(".tab", bar), i = tabs.indexOf(document.activeElement);
    if (i < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const n = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[n].focus(); apply(root, view, tabs[n].dataset.t);
  };
  apply(root, view, id);
  return (t) => apply(root, view, t);
}

