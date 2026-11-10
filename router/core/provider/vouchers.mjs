// Provider side of incoming vouchers: accept only a strictly higher cumulative voucher whose EIP-712 signature
// recovers to the consumer wallet and names this provider. Never trusts a peer-sent amount (see credit.mjs for admission).
import { HttpError } from "../../lib/errors.mjs";
import { nullEvents } from "../events.mjs";
import { open as openBox } from "../../seal.mjs";

export const walletKey = (a) => String(a).toLowerCase();

export function createVouchersIn({ state, save, identity, chain, events = nullEvents }, { maybeAutoRedeem }) {
  function acceptVoucher(inv, v) {
    if (!v?.sig || !/^\d+$/.test(String(v?.cumulative ?? ""))) return false;
    try {
      if (BigInt(v.cumulative) > BigInt(inv.cumulative) && chain.verifyVoucher(inv.consumerAddress, chain.address, v.cumulative, v.sig)) {
        const add = BigInt(v.cumulative) - BigInt(inv.cumulative);
        inv.cumulative = String(BigInt(v.cumulative));
        inv.sig = v.sig;
        inv.ts = Date.now();
        save();
        events.voucher({ action: "received", amountUsd: chain.unitsToUsd(add), counterparty: inv.consumerAddress });
        return true;
      }
    } catch { /* malformed voucher */ }
    return false;
  }

  /** POST /p2p/voucher: consumer pushes its latest voucher after a receipt. Sealed like infer; wallet control is proven, not claimed. */
  function receiveVoucher(wire) {
    if (!wire?.sealed) throw new HttpError(400, "sealed envelope required", "unsealed");
    let p;
    try { ({ obj: p } = openBox(identity.box.priv, identity.box.pub, wire.sealed)); } catch { throw new HttpError(400, "cannot open envelope", "bad_envelope"); }
    const w = p?.consumer?.wallet;
    if (!chain.configured() || !chain.verifyBinding(p?.consumer?.id, w, p?.consumer?.walletProof)) throw new HttpError(402, "wallet proof required", "payment_required");
    const inv = state.vouchersIn[walletKey(w)];
    if (!inv) throw new HttpError(404, "unknown consumer");
    const ok = acceptVoucher(inv, p);
    if (ok) maybeAutoRedeem(walletKey(w));
    return { accepted: ok };
  }

  return { acceptVoucher, receiveVoucher };
}
