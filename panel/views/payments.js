// Payments: stat cards, receipt ledger, settlement batches. The escrow/on-chain panel is payments-chain.js.
// Ledger entries are built from signed receipts; simulated entries are shown NOT SETTLED and never settled.
import { api, post } from "../lib/api.js";
import { $, esc, reveal, setHtml } from "../lib/dom.js";
import { ago, fmt, shortAddr, usd } from "../lib/format.js";
import { S } from "../lib/store.js";
import { poll } from "../lib/status.js";
import { badge } from "../components/badge.js";
import { empty, pageHead, skelRows, skelStats, statCard } from "../components/card.js";
import { initTabs, pickTab, tabBar } from "../components/tabs.js";
import { table } from "../components/table.js";
import { TABS } from "../lib/nav.js";
import { guard, toast } from "../components/toast.js";
import { alertsFor, alertsRegion, renderAlerts } from "./alerts.js";
import { bindCap, capCard, renderCap } from "./payments-cap.js";
import { renderChain } from "./payments-chain.js";

const entryRow = (e) =>
  `<tr><td class="mut">${ago(e.ts)}</td><td>${badge(e.type === "earn" ? "Earned" : "Spent", e.type === "earn" ? "live" : "")}</td><td>${esc(e.peer)} ${e.simulated ? '<span class="badge sim">SIM</span>' : ""}</td><td><b>${esc(e.model)}</b></td><td class="r">${fmt(e.p + e.c)}</td><td class="r ${e.type === "earn" ? "up" : ""}">${e.type === "earn" ? "+" : "−"}${usd(e.amount)}</td><td class="mono mut" title="${e.receipt?.sim ? "" : esc(e.receipt?.sig ?? "")}">${e.receipt?.sim ? "unsigned (sim)" : esc((e.receipt?.sig ?? "").slice(0, 18) + ((e.receipt?.sig ?? "").length > 18 ? "…" : ""))}</td><td>${e.simulated ? '<span class="badge sim">NOT SETTLED</span>' : e.settled ? '<span class="badge tee">SETTLED</span>' : '<span class="badge">OPEN</span>'}</td></tr>`;

const batchRow = (b) =>
  `<div class="row"><span class="mn top"><span><b>${b.direction === "earn" ? "Payout" : "Payment"}</b> · ${b.count} receipts · ${usd(b.amount)}${b.gasUsed ? " · gas " + fmt(b.gasUsed) : ""}<span class="sub mono">${b.explorer ? `<a href="${esc(b.explorer)}" target="_blank" rel="noopener">${esc(b.tx)}</a>` : esc(b.tx)}</span></span></span><span class="badge ${b.chain === "sim-testnet" ? "sim" : "tee"}">${esc(b.chain)}</span></div>`;

/** scroll to / focus a control once it exists (the escrow cards fill in after the chain RPC answers); gives up after 4 s */
async function focusSoon(id) {
  for (let i = 0; i < 27 && S.view === "payments"; i++) {
    const el = document.getElementById(id);
    if (el && !el.closest("[hidden]")) return reveal(id);
    await new Promise((r) => setTimeout(r, 150));
  }
}

export const payments = {
  snap: null, // latest /api/chain snapshot (set by renderChain), used for the alerts
  async enter() {
    this.snap = null; this.ck = null;
    const tab = pickTab("payments", TABS.payments);
    $("#v-payments").innerHTML = `
      ${pageHead("Owner · earn &amp; pay", "Payments", "This node's wallet, peer receipts and settlement — separate from a public visitor's browser session. Own local inference needs no escrow deposit. Fund only if this node will buy from paid peers; sellers need settlement and redemption gas.", '<button type="button" class="btn primary" id="pay-settle">Settle batch</button>')}
      <div class="body">
        ${tabBar(TABS.payments, tab)}
        ${alertsRegion("pay-alerts")}
        <div class="grid g4" id="pay-stats">${skelStats(4)}</div>
        <div class="card" id="pay-steps" data-pane="fund" hidden></div>
        <div class="card" id="pay-wallet" data-pane="fund" hidden></div>
        <div class="stackc" data-pane="fund">${capCard()}</div>
        <div id="pay-mode" data-pane="escrow"></div>
        <div class="card" id="pay-chain" data-pane="escrow">${skelRows(4)}</div>
        <div class="card" data-pane="ledger"><h3>Ledger <span class="row-flex"><button type="button" class="btn sm" id="pay-fund">+ $10 testnet funds</button></span></h3><div class="tablewrap" id="pay-led">${skelRows(4)}</div></div>
        <div class="card" data-pane="ledger"><h3>Settlement batches</h3><div id="pay-batches"></div></div>
      </div>`;
    initTabs($("#v-payments"), "payments", tab);
    bindCap(this);
    const focus = S.pre.focus;
    $("#pay-fund").onclick = guard(async () => { await post("/api/ledger/fund", { amount: 10 }); toast("Added $10 testnet funds", "ok"); await this.tick(); poll(); });
    $("#pay-settle").onclick = guard(async () => {
      const { batches } = await post("/api/ledger/settle");
      toast(batches.length ? `Settled ${batches.length} batch(es)` : "Nothing to settle (simulated peers are excluded)", batches.length ? "ok" : "");
      await this.tick();
    });
    await this.tick();
    if (focus) focusSoon(focus);
  },
  /** alerts from the live status plus the last chain snapshot; also called by renderChain when a new snapshot arrives */
  alerts() { renderAlerts($("#pay-alerts"), alertsFor(S.status, this.snap, "payments")); },
  async tick() {
    if (S.view !== "payments") return;
    renderCap(S.status); this.alerts();
    const d = await api("/api/ledger");
    const x = d.stats;
    setHtml($("#pay-stats"),
      statCard(usd(d.balance), d.mode === "chain" ? "Escrow spendable" : "Wallet balance", d.address ? esc(shortAddr(d.address)) : "no wallet", true) +
      statCard(usd(x.spentTotal), "Spent · all time", `${usd(x.unsettled.spend)} unsettled`) +
      statCard(usd(x.earnedTotal), "Earned · all time", `${usd(x.unsettled.earn)} unsettled`) +
      statCard(d.batches.length, "Settlement batches", `chain: ${esc(d.chain)}`));
    setHtml($("#pay-led"), d.entries.length
      ? table(["When", "Type", "Counterparty", "Model", ["Tokens", "r"], ["Amount", "r"], "Receipt", "State"], d.entries.slice(0, 40).map(entryRow))
      : empty("No peer receipts yet", "Paid peer usage creates signed receipts here. Your own local inference does not require a deposit and need not create a peer charge. Review a real offer before funding.", '<button type="button" class="btn sm primary" data-go="models">Compare models &amp; sellers</button>', "payments"));
    setHtml($("#pay-batches"), d.batches.length ? d.batches.map(batchRow).join("") : empty("No batches yet", "Settled receipts are grouped into batches that show up here.", "", "payments"));
    $("#pay-fund").hidden = d.mode === "chain";
    renderChain(this).catch((e) => toast(e.message, "err")); // RPC can be slow; never block the ledger on it
  },
};
