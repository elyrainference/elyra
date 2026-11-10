// Provider payout path: redeem the highest voucher held for a consumer wallet, mark ledger earn entries settled
// (FIFO up to the redeemed amount), sweep to the payout address, and auto-redeem past a threshold.
import { rid } from "../../lib/canon.mjs";
import { inc, log } from "../../obs.mjs";
import { nullEvents } from "../events.mjs";
import { usd } from "../../policy.mjs";

export function createRedeemer({ state, save, chain, escrowId, every, events = nullEvents }) {
  const redeeming = new Set();

  /** Redeem the highest voucher of one consumer wallet; marks ledger entries settled. Throws on chain errors. */
  async function redeemEntry(wk) {
    const v = state.vouchersIn[wk];
    if (!v?.sig || v.escrow !== escrowId() || BigInt(v.cumulative) <= BigInt(v.redeemed ?? 0) || redeeming.has(wk)) return null;
    redeeming.add(wk);
    try {
      let t;
      try { t = await chain.redeem(v.consumerAddress, v.cumulative, v.sig); inc("elyra_redeem_total", { result: "ok" }); v.lastError = ""; }
      catch (e) { inc("elyra_redeem_total", { result: "error" }); v.lastError = e.message; log("error", "redeem failed", { wallet: wk, reason: e.message }); throw e; }
      const pos = await chain.consumerPosition(v.consumerAddress, chain.address, { fresh: true });
      const before = BigInt(v.redeemed ?? 0);
      v.redeemed = pos.claimed.toString();
      const paid = BigInt(v.redeemed) - before;
      let run = before;
      const es = state.ledger.filter((e) => e.type === "earn" && e.wallet === wk && !e.settled && !e.simulated);
      const done = [];
      for (const e of es) { run += BigInt(e.amountUnits ?? 0); if (run > BigInt(v.redeemed)) break; e.settled = true; e.tx = t.hash; done.push(e); }
      const b = { id: rid("b"), ts: Date.now(), tx: t.hash, chain: state.chain.network, direction: "earn", count: done.length, amount: usd(chain.unitsToUsd(paid)), paidUnits: paid.toString(), gasUsed: t.gasUsed, peers: ["wallet " + wk.slice(0, 8)], explorer: chain.explorerTx(t.hash) };
      // earnings are swept to the seller-controlled payout address, so a node whose key is ephemeral (TEE) never sits on money
      if (state.provide.payout && paid > 0n) {
        try { const sw = await chain.sendToken(state.provide.payout, paid); b.swept = { to: state.provide.payout, tx: sw.hash, explorer: chain.explorerTx(sw.hash) }; }
        catch (e) { b.sweepError = e.message; log("error", "payout sweep failed", { reason: e.message }); }
      }
      state.batches.push(b);
      events.voucher({ action: "redeemed", amountUsd: b.amount, tx: b.tx, counterparty: v.consumerAddress });
      save();
      return b;
    } finally { redeeming.delete(wk); }
  }

  /** chain mode: redeem every voucher we hold; one failing consumer never blocks the others */
  async function settleChain() {
    const made = [];
    state.lastSettleErrors = [];
    for (const wk of Object.keys(state.vouchersIn)) {
      try { const b = await redeemEntry(wk); if (b) made.push(b); }
      catch (e) { state.lastSettleErrors.push({ wallet: wk, error: e.message }); }
    }
    save();
    return made;
  }

  const maybeAutoRedeem = (wk) => {
    const v = state.vouchersIn[wk], P = state.provide;
    if (!P.autoRedeem || !v || v.escrow !== escrowId() || !chain.configured()) return;
    if (BigInt(v.cumulative) - BigInt(v.redeemed ?? 0) >= chain.usdToUnits(P.autoRedeemUsd)) redeemEntry(wk).catch(() => {});
  };
  every(60000, () => { for (const wk of Object.keys(state.vouchersIn)) maybeAutoRedeem(wk); });

  return { redeemEntry, settleChain, maybeAutoRedeem };
}
