// Keyboard shortcuts: Ctrl/Cmd+K or "/" opens the palette, "?" lists the shortcuts, "g" then a letter jumps to a view (Linear style).
// Ignored while typing in a field and while an overlay is open. Registered once from main.js.
import { overlay } from "./components/overlay.js";
import { closePop } from "./components/pop.js";
import { openPalette } from "./palette.js";
import { go } from "./router.js";

const GO = { h: ["overview", "Home"], l: ["live", "Live"], c: ["connect", "Connect"], n: ["network", "Network"], p: ["playground", "Playground"], m: ["models", "Models"], r: ["routing", "Routing"], o: ["provide", "Provide"], y: ["payments", "Payments"] };
const kb = (...k) => k.map((x) => `<kbd>${x}</kbd>`).join("");
const ROWS = [[kb("Ctrl", "K"), "Open the command palette"], [kb("/"), "Open the command palette"], [kb("?"), "Show this list"], [kb("Esc"), "Close a menu or dialog"],
  ...Object.entries(GO).map(([k, [, name]]) => [kb("g") + " then " + kb(k), "Go to " + name])];

export function openShortcuts() {
  const { el } = overlay(`<div class="ck-in sc-h"><b>Keyboard shortcuts</b><kbd>Esc</kbd></div><dl class="sc">${ROWS.map(([k, d]) => `<div><dt>${d}</dt><dd>${k}</dd></div>`).join("")}</dl>`, "Keyboard shortcuts");
  el.tabIndex = -1; el.focus();
}

export function initShortcuts() {
  let chord = 0;
  document.addEventListener("elyra:shortcuts", openShortcuts);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); closePop(); openPalette(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    if (e.target.closest?.("input,textarea,select,[contenteditable]") || document.querySelector(".cmdk-bg")) return;
    if (e.key === "/") { e.preventDefault(); openPalette(); }
    else if (e.key === "?") { e.preventDefault(); openShortcuts(); }
    else if (chord && Date.now() - chord < 1200 && GO[e.key]) { chord = 0; go(GO[e.key][0]); }
    else chord = e.key === "g" ? Date.now() : 0;
  });
}
