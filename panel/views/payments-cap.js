// "Daily spend cap" card on Payments: the buyer-side limit on paid requests (24 h rolling). The form is rendered once per visit; only the usage
// bar is refreshed on the poll (setHtml), so typing is never interrupted. The router enforces the cap (core/consumer/chat.mjs); this is the control.
import { put } from "../lib/api.js";
import { $, setHtml } from "../lib/dom.js";
import { usd } from "../lib/format.js";
import { poll } from "../lib/status.js";
import { S } from "../lib/store.js";
import { field, nonNegative, watchField } from "../components/form.js";
import { helpBtn } from "../components/pop.js";
import { guard, toast } from "../components/toast.js";

export const capCard = () => `<div class="card" id="pay-cap"><h3><span>Daily spend cap ${helpBtn("A hard stop for what this node may spend on other peers in any rolling 24 hours. Empty means no cap. Requests over the cap are refused, not queued.")}</span> <span class="badge" id="pc-state">No cap</span></h3>
  <p class="help">A paid request is refused when what you spent in the last 24 hours plus its worst-case cost would pass the cap. Free and local models are never limited. The count includes simulated test money, like the ledger below.</p>
  <div id="pc-use"></div>
  <div class="form" style="margin-top:14px">${field("pc-cap", "Cap per rolling 24 hours", `<div class="inp"><span class="pre">$</span><input class="txt" id="pc-cap" type="number" min="0" step="0.5" placeholder="No cap" style="max-width:160px"><button type="button" class="btn primary" id="pc-save">Save cap</button><button type="button" class="btn" id="pc-clear">Remove cap</button></div>`, "Leave empty for no cap. 0 blocks every paid request.")}</div></div>`;

/** wire the form once, after capCard() is in the page */
export function bindCap(view) {
  const input = $("#pc-cap"), ok = watchField(input, nonNegative);
  const draw = () => { input.value = S.status?.spendCap?.usdDay ?? ""; };
  draw();
  const save = (value) => guard(async () => {
    const r = await put("/api/settings", { spendCapUsdDay: value() });
    toast(r.settings.spendCapUsdDay == null ? "Spend cap removed" : `Daily spend cap set to ${usd(r.settings.spendCapUsdDay)}`, "ok");
    await poll(); draw(); renderCap(S.status); await view.tick();
  });
  $("#pc-save").onclick = save(() => { if (!ok()) throw new Error("Enter a number, 0 or more."); return input.value.trim() === "" ? null : Number(input.value); });
  $("#pc-clear").onclick = save(() => null);
}

/** refresh the usage bar from /api/status (called on every poll) */
export function renderCap(st) {
  const c = st?.spendCap;
  if (!c) return;
  const state = $("#pc-state");
  if (c.usdDay == null) {
    state.textContent = "No cap"; state.className = "badge";
    setHtml($("#pc-use"), `<div class="pw"><div class="t"><span>Spent in the last 24 hours</span><b>${usd(c.spentUsd)}</b></div><div class="bar"><i style="width:0"></i></div></div>`);
    return;
  }
  const pct = c.usdDay > 0 ? Math.min(100, Math.round((c.spentUsd / c.usdDay) * 100)) : 100;
  state.textContent = pct >= 100 ? "Reached" : pct >= 80 ? "Almost used" : "Active";
  state.className = "badge " + (pct >= 100 ? "bad" : pct >= 80 ? "warn" : "ok");
  setHtml($("#pc-use"), `<div class="pw"><div class="t"><span>Spent in the last 24 hours</span><b>${usd(c.spentUsd)} of ${usd(c.usdDay)}</b></div><div class="bar"><i style="width:${pct}%"></i></div></div>`);
}
