// Home dashboard numbers: four KPI cards (value, change vs the previous 24 h, 14-day sparkline) and the usage chart (24 h / 7 d / 14 d).
// Every figure comes from lib/usage.js, which only uses what the API returns; where it cannot answer, the card or chart says so.
import { $, setHtml } from "../lib/dom.js";
import { fmt, kfmt, usd } from "../lib/format.js";
import { amountDaily, change, hourly, lastDays, lastTwo } from "../lib/usage.js";
import { axis, barChart, dayLabel, deltaChip, sparkline } from "../components/chart.js";

const sum = (a) => a.reduce((x, y) => x + y, 0);
const VS = "vs previous 24 h";

const kpi = (label, value, spark, chip, sub, accent) =>
  `<div class="card stat kpi${accent ? " accent" : ""}"><div class="metric"><span class="lbl">${label}</span><div class="kv-row"><b class="val">${value}</b>${spark ?? ""}</div><span class="delta">${chip} <span class="sub">${sub}</span></span></div></div>`;

/** HTML of the four KPI cards. `routes` (newest first) is only needed for the spend change, which the status API has no series for. */
export function kpiCards(st, routes) {
  const x = st.stats, out = x.series.out, spendDaily = amountDaily(routes, "out"), s = lastTwo(spendDaily);
  const trend = (label, a) => sparkline(a, label + ", last 14 days");
  const chip = (cur, prev, good) => deltaChip(change(cur, prev), VS, good);
  return kpi("Requests routed · 24h", fmt(x.requests24h), trend("Requests", out.requests), chip(out.requests[13], out.requests[12], true), x.ok24h == null ? "no traffic yet" : Math.round(x.ok24h * 100) + "% succeeded") +
    kpi("Tokens · 24h", kfmt(x.tokens24h), trend("Tokens", out.tokens), chip(out.tokens[13], out.tokens[12], true), x.avgTps ? "avg " + x.avgTps + " tok/s" : "no speed measured") +
    kpi("Spent · 24h", usd(x.spend24h), spendDaily && trend("Spend", spendDaily), s ? chip(s.cur, s.prev, false) : deltaChip(null, VS), `${usd(st.balance)} wallet`) +
    kpi("Earned · 24h", usd(x.earned24h), trend("Earnings", x.earnDaily), chip(x.earnDaily[13], x.earnDaily[12], true), st.providing.enabled ? fmt(x.served24h) + " served" : "not providing", true);
}

export const RANGES = [["24h", "24h"], ["7d", "7d"], ["14d", "14d"]];

/** Redraw the usage chart for range `range` ("24h" | "7d" | "14d") and direction `dir` ("out" consumed | "in" served). */
export function drawUsage(st, routes, range, dir) {
  const el = $("#ov-chart");
  if (!st || !el) return;
  let v, tip, left, right, label, note = "";
  if (range === "24h") {
    v = hourly(routes, dir);
    tip = (n, i) => `${n} req · ${kfmt(v.tokens[i])} tok · ${23 - i ? 23 - i + "h ago" : "this hour"}`;
    [left, right, label] = ["24 hours ago", "Now", "Bar chart, last 24 hours"];
    if (!v.full) note = '<p class="hint">Hours older than the newest 60 logged requests are not in the log, so they are left empty rather than guessed.</p>';
  } else {
    const n = range === "7d" ? 7 : 14;
    v = lastDays(st.stats.series[dir], n);
    tip = (c, i) => `${c} req · ${kfmt(v.tokens[i])} tok · ${dayLabel(i, n)}`;
    [left, right, label] = [`${n} days ago`, "Today", `Bar chart, last ${n} days`];
  }
  setHtml(el, barChart(v.requests, { min: 4, tip, label }) + axis(`${fmt(sum(v.requests))} requests · ${kfmt(sum(v.tokens))} tokens`, left, right) + note);
}
