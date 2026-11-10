// Provider side: build and sign the receipt for a served request from the upstream's usage numbers, record the
// earn ledger entry and route (metadata only), and add the amount to the consumer's owed balance (chain mode).
import { rid } from "../../lib/canon.mjs";
import { inc } from "../../obs.mjs";
import { cost } from "../../policy.mjs";
import { nullEvents } from "../events.mjs";

export function createReceiptIssuer({ state, save, identity, chain, events = nullEvents }) {
  /** `u` = {p,c} usage, `m` = offered model, `inv`/`wk` = voucher channel + wallet key (chain mode, else null). */
  return function issueReceipt({ u, m, consumer, auth, model, inv, wk, t0 }) {
    const rest = {
      v: 1, id: rid("rc"), provider: identity.id, consumer: consumer.id, nonce: auth.nonce, model, promptTokens: u.p, completionTokens: u.c,
      price: m.price, amount: cost(m.price, u.p, u.c), ts: Date.now(), tee: m.tee,
    };
    let amountUnits;
    if (inv) { // chain mode at admission time (inv is only set by the credit gate)
      amountUnits = chain.usdToUnits(rest.amount).toString();
      rest.amountUnits = amountUnits;
      rest.providerWallet = chain.address;
      inv.owedUnits = (BigInt(inv.owedUnits) + BigInt(amountUnits)).toString();
    }
    const receipt = { ...rest, sig: identity.sign(rest) };
    state.ledger.push({ id: rid("l"), ts: rest.ts, type: "earn", amount: rest.amount, amountUnits, wallet: wk ?? undefined, peer: "peer " + consumer.id.slice(0, 6), peerId: consumer.id, model, p: u.p, c: u.c, receipt, settled: false });
    inc("elyra_route_total", { result: "ok", kind: "served" });
    inc("elyra_tokens_total", { dir: "in" }, u.p + u.c);
    state.routes.push({ id: rid("r"), ts: rest.ts, dir: "in", requested: model, model, peer: "peer " + consumer.id.slice(0, 6), peerId: consumer.id, kind: "served", price: m.price, p: u.p, c: u.c, amount: rest.amount, ms: Date.now() - t0, tee: m.tee, ok: true });
    events.request({ role: "seller", status: "ok", peer: "peer " + consumer.id.slice(0, 6), model, promptTokens: u.p, completionTokens: u.c, costUsd: rest.amount, latencyMs: Date.now() - t0, simulated: false, counterparty: wk ?? undefined });
    save();
    return receipt;
  };
}
