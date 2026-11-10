// Chain-mode credit gate for /p2p/infer. Serve only a consumer whose wallet is proven, whose escrow verifiably covers
// everything it already owes us plus this request's worst case, and whose unpaid balance (served but not yet redeemed
// on-chain) stays within the credit limit. Fail closed if the chain cannot answer. Provider credit is per WALLET.
import { HttpError } from "../../lib/errors.mjs";
import { cost } from "../../policy.mjs";
import { depositCapOf } from "../limits.mjs";
import { walletKey } from "./vouchers.mjs";

export function createCreditGate({ state, chain, escrowId }, { acceptVoucher, redeemEntry }) {
  /**
   * Admit one request or throw HttpError. Returns { inv, wk } (the consumer's voucher channel and wallet key).
   * `m` = the offered model (price), `maxOut`/`promptEst` bound the worst-case cost of this request.
   */
  return async function admit({ consumer, voucher, m, maxOut, promptEst }) {
    const P = state.provide;
    const w = consumer.wallet;
    if (!chain.isAddress(w) || !chain.verifyBinding(consumer.id, w, consumer.walletProof)) throw new HttpError(402, "wallet proof required (this provider settles on-chain)", "payment_required");
    const wk = walletKey(w);
    const worst = chain.usdToUnits(cost(m.price, promptEst, maxOut));
    const read = async () => { try { return await chain.consumerPosition(w, chain.address, { fresh: true }); } catch { throw new HttpError(503, "cannot verify the consumer's escrow right now (chain unreachable)", "chain_unavailable"); } };
    let pos = await read();
    const maxDepositUsd = depositCapOf(P);
    if (BigInt(pos.deposit) > chain.usdToUnits(maxDepositUsd)) throw new HttpError(402, `escrow deposit exceeds the $${maxDepositUsd} per-wallet cap (withdraw down to $${maxDepositUsd} or less)`, "deposit_cap_exceeded");
    if (state.vouchersIn[wk] && state.vouchersIn[wk].escrow !== escrowId()) delete state.vouchersIn[wk]; // channel belonged to another escrow
    const inv = state.vouchersIn[wk] ?? { consumerAddress: w, escrow: escrowId(), ids: [], cumulative: "0", sig: "", owedUnits: "0", redeemed: "0", ts: 0 };
    acceptVoucher(inv, voucher);
    inv.redeemed = pos.claimed.toString(); // only we can change claimed(consumer, us): on-chain is the truth
    // the channel baseline is what was already redeemed: owed/cumulative can never sit below it (keeps unpaid >= 0 and matches the consumer's baseline rule)
    if (BigInt(inv.redeemed) > BigInt(inv.cumulative)) inv.cumulative = inv.redeemed;
    if (BigInt(inv.redeemed) > BigInt(inv.owedUnits)) inv.owedUnits = inv.redeemed;
    const unpaid = () => { const o = BigInt(inv.owedUnits), c = BigInt(inv.cumulative); return (o > c ? o : c) - BigInt(inv.redeemed); };
    if (BigInt(pos.deposit) < unpaid() + worst) throw new HttpError(402, "escrow underfunded for this consumer", "payment_required");
    if (!state.vouchersIn[wk]) {
      if (Object.keys(state.vouchersIn).length >= 5000) throw new HttpError(503, "provider consumer table full", "busy");
      state.vouchersIn[wk] = inv; // created only after a funded deposit was verified, so unfunded identities cost us nothing
    }
    if (!inv.ids.includes(consumer.id)) inv.ids = [...inv.ids, consumer.id].slice(-5);
    if (unpaid() + worst > chain.usdToUnits(P.creditUsd)) {
      if (P.autoRedeem && BigInt(inv.cumulative) > BigInt(inv.redeemed)) { try { await redeemEntry(wk); pos = await read(); inv.redeemed = pos.claimed.toString(); } catch { /* reported below */ } }
      if (unpaid() + worst > chain.usdToUnits(P.creditUsd)) throw new HttpError(402, "payment required: sign a voucher for what you already used", "payment_required");
    }
    return { inv, wk };
  };
}
