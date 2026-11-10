// Charts: CSS bar chart (hover text in data-t), its axis, a sparkline and a change chip. Values are numbers; tip(v, i) must return plain text.
import { esc } from "../lib/dom.js";

export const dayLabel = (i, n = 14) => (n - 1 - i ? n - 1 - i + "d ago" : "today");

export function barChart(values, { min, tip, label = "Bar chart, last 14 days", max = Math.max(...values, 1), style }) {
  return `<div class="bars" role="img" aria-label="${esc(label)}"${style ? ` style="${style}"` : ""}>${values.map((v, i) => `<i class="${v ? "" : "z"}" style="height:${v ? Math.max(min, (v / max) * 100) : 2}%" data-t="${esc(tip(v, i))}"></i>`).join("")}</div>`;
}

export const axis = (mid, left = "14 days ago", right = "Today") => `<div class="axis"><span>${left}</span><span>${mid}</span><span>${right}</span></div>`;

/** Tiny trend line for a KPI card (no axes): `values` are numbers, oldest first. A flat series draws a flat line. */
export function sparkline(values, label) {
  const W = 96, H = 30, max = Math.max(...values, 0), n = values.length - 1 || 1;
  const pts = values.map((v, i) => [(i / n) * W, H - 3 - (max ? (v / max) * (H - 6) : 0)].map((x) => x.toFixed(1)));
  const line = pts.map((p, i) => (i ? "L" : "M") + p.join(" ")).join("");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}"><path class="sa" d="${line}L${W} ${H}L0 ${H}Z"/><path class="sl" d="${line}"/></svg>`;
}

/** "▲ 25% vs previous 24 h" chip. `pct`: null = unknown, "new" = it was zero before, else a number. good: is an increase good news (tints it green)? */
export function deltaChip(pct, vs, good = true) {
  if (pct === null) return `<span class="dl na" title="The API has no earlier data for this number">no earlier data</span>`;
  if (pct === 0) return `<span class="dl">no change ${vs}</span>`;
  const up = pct === "new" || pct > 0;
  return `<span class="dl ${good ? (up ? "gain" : "loss") : "flat"}">${up ? "▲" : "▼"} ${pct === "new" ? "new" : Math.abs(pct) > 999 ? ">999%" : Math.abs(pct) + "%"} ${vs}</span>`;
}
