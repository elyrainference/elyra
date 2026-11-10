// Consumer money side: spendable balance (simulated ledger or escrow deposit minus unredeemed vouchers), and signing
// the next cumulative voucher after a verified receipt. Must only be called with receipts that passed receipts.mjs.
import { sealTo } from "../../seal.mjs";
import { inc } from "../../obs.mjs";
import { usd } from "../../policy.mjs";
import { HttpError } from "../../lib/errors.mjs";
import { nullEvents } from "../events.mjs";

const MIN_GAS_ETH = 0.0005; // same threshold as the panel's "no gas" alert (panel/views/alerts.js)

export function createWallet({ state, save, identity, chain, escrowId, every, events = nullEvents }) {
  let chainBalUsd = 0, lowGas = false;
  const balance = () => (chain.configured() ? chainBalUsd : +(state.wallet.funded - state.ledger.filter((e) => e.type === "spend").reduce((a, e) => a + e.amount, 0)).toFixed(8));

  /** chain mode spendable = escrow deposit − vouchers we signed that providers have not redeemed yet */
  async function refreshChainBalance() {
    if (!chain.configured()) return;
    try {
      const inf = await chain.info();
      if (!inf.connected) return;
      const gas = Number(inf.walletEth);
      if (Number.isFinite(gas) && gas < MIN_GAS_ETH !== lowGas) { lowGas = !lowGas; if (lowGas) events.alert({ code: "low_gas" }); } // once per drop, not on every 10 s refresh
      let committed = 0n;
      for (const v of Object.values(state.vouchersOut).filter((x) => x.escrow === escrowId())) {
        const pos = await chain.consumerPosition(chain.address, v.providerAddress);
        committed += BigInt(v.cumulative) - BigInt(pos.claimed);
      }
      chainBalUsd = Math.max(0, chain.unitsToUsd(BigInt(inf.depositUnits) - (committed > 0n ? committed : 0n)));
    } catch { /* keep last known */ }
  }
  every(10000, () => refreshChainBalance());
  refreshChainBalance();

  /** consumer: sign the next cumulative voucher for a provider after a verified receipt, and push it (sealed) to the provider */
  async function issueVoucher(peer, receipt) {
    const add = BigInt(receipt.amountUnits);
    if (chain.unitsToUsd(add) > chainBalUsd + 1e-6) throw new Error("escrow balance too low to cover this receipt; top up the escrow");
    const prev0 = state.vouchersOut[peer.id];
    const prev = prev0?.escrow === escrowId() ? prev0 : null;
    // the channel baseline is whatever the provider has ALREADY redeemed on-chain: a voucher at or below claimed() is worthless (found live: lost/reset local state)
    let claimed = 0n;
    try { claimed = BigInt((await chain.consumerPosition(chain.address, peer.wallet, { fresh: true })).claimed); } catch { /* chain unreachable: fall back to local state */ }
    const base = BigInt(prev?.cumulative ?? 0) > claimed ? BigInt(prev?.cumulative ?? 0) : claimed;
    const cumulative = (base + add).toString();
    const sig = await chain.signVoucher(peer.wallet, cumulative);
    inc("elyra_vouchers_issued_total");
    state.vouchersOut[peer.id] = { providerAddress: peer.wallet, cumulative, sig, escrow: escrowId(), ts: Date.now() };
    chainBalUsd = Math.max(0, chainBalUsd - chain.unitsToUsd(add));
    events.voucher({ action: "issued", amountUsd: chain.unitsToUsd(add), counterparty: peer.wallet, peer: peer.name });
    const { envelope } = sealTo(peer.box, { consumer: { id: identity.id, wallet: chain.address, walletProof: await chain.signBinding(identity.id) }, cumulative, sig });
    fetch(peer.url + "/p2p/voucher", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: identity.id, sealed: envelope }), signal: AbortSignal.timeout(4000),
    }).catch(() => {}); // best effort; the voucher also rides on the next request
  }

  /** simulated-ledger top-up (testnet money); in chain mode the escrow deposit is the only way to add funds */
  function fund(amount) {
    if (chain.configured()) throw new HttpError(400, "chain mode: deposit ETH into the escrow instead (Payments → Escrow)");
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0 || n > 1000) throw new HttpError(400, "amount must be 0 < x <= 1000");
    state.wallet.funded = usd(state.wallet.funded + n);
    save();
    return balance();
  }

  return { balance, refreshChainBalance, issueVoucher, fund };
}
