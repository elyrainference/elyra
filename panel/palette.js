// Command palette (Ctrl/Cmd+K, or "/"): jump to any view or tab, run the handful of actions people repeat. Every entry is
// { g: group, t: title, s: hint, ic: icon, run() | href }. Typing filters (every word must match); arrows + Enter run; Escape closes.
import { copy } from "./components/controls.js";
import { overlay } from "./components/overlay.js";
import { toast } from "./components/toast.js";
import { toolUrl } from "./lib/config.js";
import { $, esc } from "./lib/dom.js";
import { icon } from "./lib/icons.js";
import { TABS, VIEWS } from "./lib/nav.js";
import { S } from "./lib/store.js";
import { currentDensity, currentTheme, toggleDensity, toggleTheme } from "./lib/theme.js";
import { go } from "./router.js";

export const DOCS = "https://elyrainference.com/docs/";
export const REPO = "https://github.com/elyrainference/elyra";
let open = null;

export function commands() {
  const light = currentTheme() === "light", compact = currentDensity() === "compact", c = [];
  for (const [id, label, grp] of VIEWS) {
    c.push({ g: "Go to", t: label, s: grp, ic: id, run: () => go(id) });
    for (const [tab, name] of TABS[id] ?? []) c.push({ g: "Go to", t: `${label} · ${name}`, s: grp, ic: id, run: () => go(id, { tab }) });
  }
  c.push(
    { g: "Actions", t: "Send a test request", s: "Playground", ic: "send", run: () => go("playground", { focus: "pg-in" }) },
    { g: "Actions", t: "Copy endpoint URL", s: toolUrl(S.status?.node?.port), ic: "copy", run: () => copy(toolUrl(S.status?.node?.port)) },
    { g: "Actions", t: light ? "Switch to dark theme" : "Switch to light theme", ic: light ? "moon" : "sun", run: () => toast(toggleTheme() === "light" ? "Light theme" : "Dark theme") },
    { g: "Actions", t: compact ? "Use comfortable density" : "Use compact density", ic: "density", run: () => toast(toggleDensity() === "compact" ? "Compact density" : "Comfortable density") },
    { g: "Help", t: "Keyboard shortcuts", s: "?", ic: "keyboard", run: () => document.dispatchEvent(new CustomEvent("elyra:shortcuts")) },
    { g: "Help", t: "Open the docs", s: "elyrainference.com", ic: "book", href: DOCS },
    { g: "Help", t: "Open GitHub", s: "elyrainference/elyra", ic: "github", href: REPO });
  return c;
}

/** Entries matching every word of `q` (title, hint or group), best first: title prefix, then earlier match, then original order. */
export function filter(list, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  const rank = (c) => { const t = c.t.toLowerCase(); return t.startsWith(words[0]) ? 0 : t.includes(words[0]) ? 1 : 2; };
  return list.map((c, i) => [c, i]).filter(([c]) => { const h = `${c.t} ${c.s ?? ""} ${c.g}`.toLowerCase(); return words.every((w) => h.includes(w)); })
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([c]) => c);
}

export function openPalette() {
  if (open) return;
  const all = commands();
  let shown = all, sel = 0;
  const { el, close } = overlay(`<div class="ck-in">${icon("search")}<input id="ck-q" type="text" role="combobox" aria-expanded="true" aria-controls="ck-list" aria-autocomplete="list" aria-label="Search commands" placeholder="Search views and actions…" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div>
    <div class="ck-list" id="ck-list" role="listbox" aria-label="Commands"></div><div class="ck-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>Esc</kbd> close</span></div>`, "Command palette", () => { open = null; });
  open = close;
  const q = $("#ck-q", el), list = $("#ck-list", el);
  const paint = () => {
    let g = "";
    list.innerHTML = shown.length ? shown.map((c, i) => {
      const head = c.g !== g ? `<div class="cg" role="presentation">${esc(c.g)}</div>` : ""; g = c.g;
      return `${head}<div class="ci" role="option" id="ci-${i}" data-i="${i}" aria-selected="${i === sel}">${icon(c.ic)}<span class="ct">${esc(c.t)}</span>${c.s ? `<span class="cs">${esc(c.s)}</span>` : ""}</div>`;
    }).join("") : '<p class="ck-none">Nothing matches. Try a view name like “payments”.</p>';
    q.setAttribute("aria-activedescendant", shown.length ? "ci-" + sel : "");
    $(".ci[aria-selected=true]", list)?.scrollIntoView({ block: "nearest" });
  };
  const run = (c) => { close(); if (!c) return; if (c.href) window.open(c.href, "_blank", "noopener"); else c.run(); };
  q.oninput = () => { shown = filter(all, q.value); sel = 0; paint(); };
  q.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (shown.length) { sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % shown.length; paint(); } }
    else if (e.key === "Enter") { e.preventDefault(); run(shown[sel]); }
  };
  list.onmousemove = (e) => { const i = e.target.closest(".ci"); if (i && Number(i.dataset.i) !== sel) { sel = Number(i.dataset.i); paint(); } };
  list.onclick = (e) => { const i = e.target.closest(".ci"); if (i) run(shown[Number(i.dataset.i)]); };
  paint();
  q.focus();
}
