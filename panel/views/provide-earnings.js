// Earnings card on the Provide view: totals, 14-day chart, per-buyer voucher state and the REDEEM NOW action.
// Paints immediately from the ledger, then again once /api/chain answers (the RPC may be slow).
import { api, post } from "../lib/api.js";
import { $, esc } from "../lib/dom.js";
import { shortAddr, usd } from "../lib/format.js";
import { poll } from "../lib/status.js";
import { axis, barChart, dayLabel } from "../components/chart.js";
import { table } from "../components/table.js";
import { guard, toast } from "../components/toast.js";

const stat = (v, label) => `<div class="metric"><span class="lbl">${label}</span><b class="val">${v}</b></div>`;

function buyerRows(rows, ch) {
  const dec = 10 ** (ch.tokenDecimals ?? 6);
  return rows.map((r) =>
    `<tr><td class="mono mut">${esc(shortAddr(r.consumerAddress, 10, 4))}</td><td class="r">${usd(Number(r.owedUnits) / dec)}</td><td class="r">${usd(Number(r.redeemedUnits) / dec)}</td><td class="r ${r.exposureUsd > 0 ? "warn" : ""}">${usd(Math.max(0, r.exposureUsd))}</td><td>${r.lastError ? `<span class="badge bad" title="${esc(r.lastError)}">Redeem failed</span>` : r.claimableUsd > 0 ? '<span class="badge live">Ready to redeem</span>' : '<span class="badge tee">Paid</span>'}</td></tr>`);
}

function redeemToast(r) {
  if (r.batches.length) return [`Redeemed ${r.batches.length} batch(es) on-chain`, "ok"];
  if (r.failed?.length) return ["Redeem failed: " + r.failed[0].error.slice(0, 90), "err"];
  return ["Nothing to redeem yet", ""];
}

// view.p holds the latest /api/provide settings (autoRedeem); view.chain the last /api/chain snapshot, so a refresh repaints from it
// (no flash back to the "no chain yet" state) and only touches the DOM when the markup changed.
export async function renderEarnings(view) {
  const el = $("#pv-earn");
  if (!el) return;
  const led = await api("/api/ledger");
  const x = led.stats, bars = x.earnDaily ?? [];
  const paint = (ch) => {
    const rows = ch?.vouchersIn ?? [];
    const claimable = rows.reduce((a, r) => a + Math.max(0, r.claimableUsd), 0), unpaid = rows.reduce((a, r) => a + Math.max(0, r.exposureUsd), 0);
    const gas = ch?.connected ? Number(ch.walletEth) : null;
    const chainMode = ch?.mode === "chain", auto = view.p?.autoRedeem !== false;
    const html = `<h3>Your earnings <span class="row-flex">${chainMode ? `<span class="badge ${auto ? "tee" : ""}">Auto-redeem ${auto ? "on" : "off"}</span><button type="button" class="btn sm primary" id="pv-redeem">Redeem now</button>` : '<span class="badge sim">SIMULATED LEDGER</span>'}</span></h3>
      <div class="grid g4" style="margin-bottom:16px">
        ${stat(usd(x.earnedTotal), "Earned · all time")}${stat(usd(x.earned24h), "Earned · 24h")}
        ${stat(chainMode ? usd(claimable) : usd(x.unsettled.earn), chainMode ? "Vouchers to redeem" : "Unsettled")}${stat(chainMode ? usd(unpaid) : "—", "Served, not yet vouchered")}
      </div>
      ${barChart(bars, { min: 6, max: Math.max(...bars, 1e-9), tip: (v, i) => `${usd(v)} · ${dayLabel(i)}`, style: "height:80px" })}
      ${axis("Earnings per day")}
      ${chainMode && gas !== null && gas < 0.0005 && (claimable > 0 || unpaid > 0) ? `<div class="note bad"><b>Low gas.</b> You have ${gas.toFixed(5)} ETH. Redeeming costs a little ETH on Robinhood Chain; top up the wallet or earnings stay unredeemed.</div>` : ""}
      ${rows.length ? `<div class="tablewrap" style="margin-top:16px">${table(["Buyer wallet", ["Served", "r"], ["Paid out", "r"], ["Owed to you", "r"], "State"], buyerRows(rows, ch))}</div>` : `<p class="help" style="margin:16px 0 0">${chainMode ? "No buyer has paid you yet. Once a buyer sends a request, their wallet shows up here." : "Settlement is simulated on this node; switch on-chain under Payments to get paid in USDG."}</p>`}`;
    if (el.dataset.h !== html) { el.dataset.h = html; el.innerHTML = html; }
    const b = $("#pv-redeem");
    if (b) b.onclick = guard(async () => {
      b.disabled = true;
      try {
        const [msg, kind] = redeemToast(await post("/api/ledger/settle"));
        toast(msg, kind);
        await renderEarnings(view);
        poll();
      } finally { b.disabled = false; }
    });
  };
  paint(view.chain ?? null);
  api("/api/chain").then((ch) => { view.chain = ch; paint(ch); }).catch(() => {});
}
