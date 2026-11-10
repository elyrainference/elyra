// DOM helpers. Owns: selectors and THE escaping helper. Every remote-supplied string (peer names, model ids, receipts, errors)
// MUST go through esc() before it is interpolated into an HTML template; never put untrusted data into innerHTML any other way.
import { S } from "./store.js";
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// innerHTML only when the markup changed: polled regions keep hover/focus/scroll and never shift when nothing changed. `html` must already be escaped.
export const setHtml = (el, html) => { if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; } };
// Scroll an element into view (opening any <details> around it) and focus it when it is a control. Used by data-focus buttons and `S.pre.focus`.
export function reveal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const pane = el.closest("[data-pane]"); // a control on another tab: open that tab first (components/tabs.js)
  if (pane?.classList.contains("pane-off")) document.querySelector(`#v-${S.view} .tab[data-t="${pane.dataset.pane.split(" ")[0]}"]`)?.click();
  for (let d = el.closest("details"); d; d = d.parentElement?.closest("details")) d.open = true;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  if (/^(INPUT|BUTTON|SELECT|TEXTAREA|A)$/.test(el.tagName)) el.focus({ preventScroll: true });
}
