// Settlement entry point. Simulated mode batches unsettled non-sim ledger entries under a deterministic fake tx id;
// chain mode delegates to the redeemer (provider/redeem.mjs). Simulated peers are never settled.
import { rid, sha } from "../lib/canon.mjs";
import { usd } from "../policy.mjs";

export function createLedger({ state, save, chain }, { settleChain }) {
  async function settle() {
    if (chain.configured()) return settleChain();
    const open = state.ledger.filter((e) => !e.settled && !e.simulated && (e.type === "spend" || e.type === "earn"));
    const made = [];
    for (const dir of ["spend", "earn"]) {
      const es = open.filter((e) => e.type === dir);
      if (!es.length) continue;
      const tx = "0x" + sha(es.map((e) => e.id).join(",")).slice(0, 64);
      const b = { id: rid("b"), ts: Date.now(), tx, chain: "sim-testnet", direction: dir, count: es.length, amount: usd(es.reduce((a, e) => a + e.amount, 0)), peers: [...new Set(es.map((e) => e.peer))] };
      for (const e of es) { e.settled = true; e.tx = tx; }
      state.batches.push(b);
      made.push(b);
    }
    save();
    return made;
  }
  return { settle };
}
