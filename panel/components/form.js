// Form building blocks: a labelled field (label, control, helper text, inline error) and inline validation.
// Labels/hints are trusted markup (callers esc() dynamic parts). The control must carry the same id passed to field().

// field("pv-price", "Default price", `<input class="txt" id="pv-price" …>`, "Dollars per million tokens.", { opt: true })
export const field = (id, label, control, hint = "", { opt = false, cls = "" } = {}) =>
  `<div class="field ${cls}"><label for="${id}">${label}${opt ? ' <span class="opt">(optional)</span>' : ""}</label>${control}${hint ? `<span class="hint" id="${id}-hint">${hint}</span>` : ""}<span class="err" id="${id}-err" role="alert"></span></div>`;

/** Validate `input` on input/blur. check(value) returns an error message or "". Returns run(): validates now, true when valid. */
export function watchField(input, check) {
  const err = document.getElementById(input.id + "-err");
  const run = () => {
    const m = check(input.value);
    input.setAttribute("aria-invalid", String(!!m));
    if (err) err.textContent = m;
    return !m;
  };
  input.addEventListener("input", run);
  input.addEventListener("blur", run);
  return run;
}

export const nonNegative = (v) => (v.trim() !== "" && !(Number(v) >= 0) ? "Enter a number, 0 or more." : "");
export const positive = (v) => (!(Number(v) > 0) ? "Enter an amount above 0." : "");
export const httpUrl = (v) => {
  if (!v.trim()) return "Required.";
  try { return /^https?:$/.test(new URL(v.trim()).protocol) ? "" : "Use an http:// or https:// address."; } catch { return "Not a valid address. Start with http:// or https://."; }
};
export const required = (v) => (v.trim() ? "" : "Required.");
