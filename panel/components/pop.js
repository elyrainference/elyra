// Anchored popovers: the account menu, the node switcher and inline help share this one floating panel. One is open at a time;
// Escape, an outside click, Tab, scrolling or a resize closes it and Escape gives focus back to the anchor. Menu content is trusted markup
// (callers esc() dynamic text); items are `.pi` buttons or links with data-pick="value", reported to onPick(value, item).
import { esc } from "../lib/dom.js";
import { icon } from "../lib/icons.js";

let cur = null;

export function closePop(restore = false) {
  if (!cur) return;
  const { el, anchor, off } = cur;
  cur = null; off(); el.remove();
  anchor.setAttribute("aria-expanded", "false");
  if (restore) anchor.focus();
}

/** Open `html` under `anchor` (a second call on the same anchor closes it). align: "start" | "end" (which anchor edge the panel lines up with). */
export function pop(anchor, html, { align = "start", cls = "", onPick } = {}) {
  const same = cur?.anchor === anchor;
  closePop();
  if (same) return null;
  const el = document.createElement("div");
  el.className = "pop " + cls;
  if (!cls.includes("tip")) el.setAttribute("role", "menu");
  el.innerHTML = html;
  document.body.append(el);
  anchor.setAttribute("aria-expanded", "true");
  const r = anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
  const left = Math.max(8, Math.min(innerWidth - w - 8, align === "end" ? r.right - w : r.left));
  const below = r.bottom + 6 + h <= innerHeight - 8;
  el.style.left = left + "px";
  el.style.top = Math.max(8, below ? r.bottom + 6 : r.top - 6 - h) + "px";
  const items = () => [...el.querySelectorAll(".pi")];
  const away = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) closePop(); };
  const key = (e) => {
    if (e.key === "Escape") { e.preventDefault(); closePop(true); return; }
    if (e.key === "Tab") { closePop(); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const list = items(); if (!list.length) return;
    e.preventDefault();
    const i = list.indexOf(document.activeElement);
    list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length].focus();
  };
  const shut = () => closePop();
  document.addEventListener("pointerdown", away, true);
  document.addEventListener("keydown", key);
  addEventListener("resize", shut);
  document.addEventListener("scroll", shut, true);
  cur = { el, anchor, off: () => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", key); removeEventListener("resize", shut); document.removeEventListener("scroll", shut, true); } };
  el.onclick = (e) => {
    const it = e.target.closest("[data-pick]");
    if (!it) return;
    const mine = cur; // closed on the next task: a link or form inside the menu must still be connected when the browser follows it
    setTimeout(() => { if (cur === mine) closePop(); }, 0);
    onPick?.(it.dataset.pick, it);
  };
  items()[0]?.focus({ preventScroll: true });
  return el;
}

/** A small "?" button that opens `text` in a popover (plain text, escaped here). */
export const helpBtn = (text) => `<button type="button" class="hi" data-help="${esc(text)}" aria-label="What is this?" aria-expanded="false">${icon("help")}</button>`;

export function initHelp() {
  document.addEventListener("click", (e) => {
    const b = e.target.closest(".hi");
    if (b) pop(b, `<p>${esc(b.dataset.help)}</p>`, { cls: "tip" });
  });
}
