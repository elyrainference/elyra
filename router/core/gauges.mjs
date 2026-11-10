// Prometheus gauges for the node (obs.mjs renders them at GET /metrics). Metadata only: counts and amounts.
import { gauge } from "../obs.mjs";

export function registerGauges({ state, chain }, { balance, inflight, upstreams = () => [], upstreamUp = () => true }) {
  const real = () => upstreams().filter((u) => u.kind !== "demo");
  gauge("elyra_upstreams_up", () => real().filter((u) => upstreamUp(u.id)).length, "Model sources that answered their last health probe");
  gauge("elyra_upstreams_down", () => real().filter((u) => !upstreamUp(u.id)).length, "Model sources that failed two probes in a row (alert on > 0)");
  gauge("elyra_peers_online", () => Object.values(state.peers).filter((p) => p.online).length, "Live peers in the table");
  gauge("elyra_peers_known", () => Object.keys(state.peers).length);
  gauge("elyra_provider_inflight", inflight, "Requests currently being served for peers");
  gauge("elyra_balance_usd", () => balance(), "Spendable balance (escrow in chain mode, testnet ledger otherwise)");
  gauge("elyra_chain_mode", () => (chain.configured() ? 1 : 0), "1 when settling on-chain, 0 when simulated");
  gauge("elyra_unredeemed_usd", () => Object.values(state.vouchersIn).reduce((a, v) => a + chain.unitsToUsd(BigInt(v.cumulative) - BigInt(v.redeemed ?? 0)), 0), "Vouchers held but not yet redeemed on-chain");
}
