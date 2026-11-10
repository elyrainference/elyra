// Toasts and the error guard. Owns: transient messages in #toast. guard() turns a thrown error in an event handler into a red toast.
// toast(msg, kind, { undo }) adds an Undo button (8 s instead of 4 s): `undo` runs the opposite API call of what just happened.
import { $ } from "../lib/dom.js";

const MAX = 4;

export function toast(msg, kind = "", { undo } = {}) {
  const box = $("#toast"), d = document.createElement("div"), t = document.createElement("span");
  d.className = kind;
  if (kind === "err") d.setAttribute("role", "alert");
  t.className = "tm"; t.textContent = msg; d.append(t);
  let timer;
  const close = () => { clearTimeout(timer); d.remove(); };
  const btn = (cls, label, text, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = cls; b.textContent = text; b.setAttribute("aria-label", label); b.onclick = fn; d.append(b); };
  if (undo) btn("tu", "Undo: " + msg, "Undo", () => { close(); guard(undo)(); });
  btn("tx", "Dismiss", "✕", close);
  while (box.childElementCount >= MAX) box.firstElementChild.remove();
  box.append(d);
  timer = setTimeout(close, undo ? 8000 : 4200);
}

export const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, "err"); } };
