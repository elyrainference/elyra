// "Do we settle the same way as this peer?" One definition, used by routing and by every view that has to explain a missing route.
// Two nodes can only trade when they use the same escrow (vouchers are signed for one escrow). Addresses are compared case-insensitively:
// 0xAbC... and 0xabc... are the same contract.
const key = (escrow) => String(escrow ?? "").trim().toLowerCase();

export function createSettlement({ state, chain }) {
  /** our settlement key: the escrow when on-chain settlement is configured, otherwise "" (simulated ledger) */
  const ours = () => (chain.configured() ? key(state.chain.escrow) : "");
  const theirs = (p) => key(p?.chain?.escrow);
  const compatible = (p) => theirs(p) === ours();
  /** peers that are online and sell models we cannot reach, grouped by their settlement, for the explanation and the one-click fix */
  const blocked = () => {
    const rows = Object.values(state.peers).filter((p) => p.online && p.providing && (p.models?.length ?? 0) > 0 && !compatible(p));
    return rows.map((p) => ({ name: String(p.name ?? "").slice(0, 40), models: p.models.length, network: p.chain?.network ?? null, escrow: p.chain?.escrow ?? null }));
  };
  const self = () => ({ configured: chain.configured(), network: state.chain?.network ?? null, escrow: chain.configured() ? state.chain.escrow : null });
  return { ours, theirs, compatible, blocked, self };
}
