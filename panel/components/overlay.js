// Modal overlay (command palette, shortcut sheet): scrim, `.app` inert while open (focus cannot wander behind it), Escape or a click on the scrim
// closes, and focus goes back to where it was. `inner` is trusted markup. Returns the dialog element and its close().
import { $, esc } from "../lib/dom.js";

export function overlay(inner, label, onClose) {
  const prev = document.activeElement, bg = document.createElement("div");
  bg.className = "cmdk-bg";
  bg.innerHTML = `<div class="cmdk" role="dialog" aria-modal="true" aria-label="${esc(label)}">${inner}</div>`;
  document.body.append(bg);
  $(".app").inert = true;
  const key = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  function close() {
    document.removeEventListener("keydown", key);
    bg.remove();
    $(".app").inert = false;
    prev?.focus?.();
    onClose?.();
  }
  document.addEventListener("keydown", key);
  bg.addEventListener("pointerdown", (e) => { if (e.target === bg) close(); });
  return { el: bg.firstElementChild, close };
}
