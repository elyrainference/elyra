// Global click delegation for navigation and copy buttons (data-view, data-go [+ data-detect, data-focus], data-focus alone, data-try, data-copy,
// data-click="<id>" = press that existing button, used by page-header actions). View-specific buttons are handled inside their view.
import { copy } from "./components/controls.js";
import { guard } from "./components/toast.js";
import { $, reveal } from "./lib/dom.js";
import { go } from "./router.js";

export function installActions() {
  document.addEventListener("click", guard(async (e) => {
    const t = e.target.closest("[data-view],[data-go],[data-try],[data-copy],[data-focus],[data-click]");
    if (!t) return;
    const d = t.dataset;
    if (d.view) { e.preventDefault(); return go(d.view); }
    if (d.go) { e.preventDefault(); return go(d.go, { ...(d.tab ? { tab: d.tab } : {}), ...(d.detect ? { detect: true } : {}), ...(d.focus ? { focus: d.focus } : {}) }); }
    if (d.try) return go("playground", { model: d.try });
    if (d.copy) return copy(d.copy);
    if (d.click) return $("#" + d.click)?.click();
    if (d.focus) return reveal(d.focus);
  }));
}
