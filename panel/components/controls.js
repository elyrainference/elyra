// Interactive pieces: switch row, copy button + clipboard, segmented control wiring.
import { $, $$, esc } from "../lib/dom.js";
import { toast } from "./toast.js";

export const switchRow = (id, on, title, desc) =>
  `<div class="swrow"><div><b>${title}</b><p>${desc}</p></div><button type="button" class="sw ${on ? "on" : ""}" id="${id}" role="switch" aria-checked="${!!on}" aria-label="${esc(title)}"></button></div>`;

/** flip a switch (or set it with `force`); keeps aria-checked in step with the .on class views read. Returns the new state. */
export function toggleSwitch(el, force) {
  const on = el.classList.toggle("on", force);
  el.setAttribute("aria-checked", String(on));
  return on;
}

export const copyBtn = (text) => `<button type="button" class="btn sm cp" data-copy="${esc(text)}" aria-label="Copy to clipboard">Copy</button>`;

export async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied", "ok"); } catch { toast("Copy failed", "err"); }
}

// Segmented control / filter pills: clicking a button marks it .on (and aria-pressed) and calls onPick(button).
export function segment(sel, onPick) {
  const el = $(sel);
  const mark = (on) => $$("button", el).forEach((x) => { x.classList.toggle("on", x === on); x.setAttribute("aria-pressed", String(x === on)); });
  mark($("button.on", el));
  el.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    mark(b);
    onPick(b);
  };
}
