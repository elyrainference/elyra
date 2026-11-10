// Control API for on-chain settlement: escrow config, vouchers overview, deposit / mint / withdraw (/api/chain*).
// Route entries for the table in api.mjs. Amounts are USD in, USDG units out; all chain traffic goes through chain.mjs.
import { HttpError } from "../lib/errors.mjs";
import { NETWORKS } from "../chain.mjs";
import { MAX_DEPOSIT_CAP_USD, depositCapOf } from "../core/limits.mjs";

// Reown (WalletConnect) project id: public by design (it is shipped to the browser), 32 hex chars. Anything else disables wallet connect.
export const reownProjectId = (env = process.env) => (/^[a-f0-9]{32}$/i.test(env.ELYRA_REOWN_PROJECT_ID ?? "") ? env.ELYRA_REOWN_PROJECT_ID.toLowerCase() : null);

export function chainRoutes(node) {
  const { state, chain } = node;
  const capOf = () => depositCapOf(state.provide);

  const overview = async () => {
    const cfg = state.chain;
    const nm = (id) => state.peers[id]?.name ?? "peer " + id.slice(0, 6);
    const escrow = `${cfg.network}:${String(cfg.escrow).toLowerCase()}`;
    return {
      ...(await chain.info()), maxDepositUsd: capOf(), walletConnect: { projectId: reownProjectId() }, mode: chain.configured() ? "chain" : "sim", config: cfg, balanceUsd: node.balance(),
      vouchersOut: Object.entries(state.vouchersOut).filter(([, v]) => v.escrow === escrow).map(([id, v]) => ({ peer: nm(id), providerAddress: v.providerAddress, cumulativeUnits: v.cumulative, cumulativeUsd: chain.unitsToUsd(v.cumulative), ts: v.ts })),
      vouchersIn: Object.entries(state.vouchersIn).filter(([, v]) => v.escrow === escrow).map(([wk, v]) => ({ peer: v.ids?.length ? "peer " + v.ids.at(-1).slice(0, 6) : "wallet " + wk.slice(0, 8), consumerAddress: v.consumerAddress, cumulativeUnits: v.cumulative, owedUnits: v.owedUnits, redeemedUnits: v.redeemed, claimableUnits: String(BigInt(v.cumulative) - BigInt(v.redeemed)), claimableUsd: chain.unitsToUsd(BigInt(v.cumulative) - BigInt(v.redeemed)), exposureUsd: chain.unitsToUsd((BigInt(v.owedUnits) > BigInt(v.cumulative) ? BigInt(v.owedUnits) : BigInt(v.cumulative)) - BigInt(v.redeemed)), lastError: v.lastError || undefined })),
    };
  };

  const configure = ({ body }) => {
    const cfg = state.chain;
    if (body.network) { if (!NETWORKS[body.network]) throw new HttpError(400, "unknown network"); cfg.network = body.network; }
    if ("rpcUrl" in body) { if (body.rpcUrl) new URL(body.rpcUrl); cfg.rpcUrl = body.rpcUrl || ""; }
    if ("chainId" in body) cfg.chainId = Math.max(0, Number(body.chainId) || 0);
    if ("escrow" in body) { if (body.escrow && !chain.isAddress(body.escrow)) throw new HttpError(400, "escrow is not an address"); cfg.escrow = body.escrow || ""; }
    if ("registry" in body) { if (body.registry && !chain.isAddress(body.registry)) throw new HttpError(400, "registry is not an address"); cfg.registry = body.registry || ""; }
    if ("registryBlock" in body) cfg.registryBlock = Math.max(0, Math.floor(Number(body.registryBlock)) || 0);
    if ("maxDepositUsd" in body) {
      if (typeof body.maxDepositUsd === "boolean" || body.maxDepositUsd === null || body.maxDepositUsd === "") throw new HttpError(400, "bad deposit cap");
      const n = Number(body.maxDepositUsd);
      if (!Number.isFinite(n) || n <= 0 || n > MAX_DEPOSIT_CAP_USD) throw new HttpError(400, "bad deposit cap");
      state.provide.maxDepositUsd = n;
    }
    chain.bust(); node.save(); node.refreshChainBalance(); node.announcePeers?.();
    return { ...cfg, maxDepositUsd: capOf() };
  };

  const deposit = async ({ body }) => {
    const cap = capOf();
    if (typeof body.usd === "boolean" || body.usd === null || body.usd === "") throw new HttpError(400, `usd must be 0 < x <= ${cap}`);
    const usdAmt = Number(body.usd);
    if (!Number.isFinite(usdAmt) || usdAmt <= 0) throw new HttpError(400, `usd must be 0 < x <= ${cap}`);
    if (usdAmt > cap) throw new HttpError(400, `deposit exceeds the $${cap} per-wallet cap`);
    if (chain.configured() && chain.address) {
      const pos = await chain.consumerPosition(chain.address, chain.address, { fresh: true }).catch((e) => { throw new HttpError(502, e.message, "chain_error"); });
      const addUnits = chain.usdToUnits(usdAmt), capUnits = chain.usdToUnits(cap);
      if (BigInt(pos.deposit) + addUnits > capUnits) {
        const curUsd = chain.unitsToUsd(pos.deposit), roomUsd = Math.max(0, cap - curUsd);
        throw new HttpError(400, `deposit would exceed the $${cap} per-wallet cap (wallet already holds $${curUsd.toFixed(2)} in escrow; at most $${roomUsd.toFixed(2)} left)`);
      }
    }
    const t = await chain.deposit(usdAmt).catch((e) => { throw new HttpError(502, e.message, "chain_error"); });
    await node.refreshChainBalance();
    return { ...t, explorer: chain.explorerTx(t.hash) };
  };

  const mint = async ({ body }) => {
    const usdAmt = Number(body.usd);
    if (!(usdAmt > 0 && usdAmt <= 10000)) throw new HttpError(400, "usd must be 0 < x <= 10000");
    const t = await chain.mint(usdAmt).catch((e) => { throw new HttpError(502, `${e.message} (only the mock test token can be minted)`, "chain_error"); });
    return { ...t, explorer: chain.explorerTx(t.hash) };
  };

  const withdraw = async ({ body }) => {
    const fn = { request: () => chain.requestWithdraw(), cancel: () => chain.cancelWithdraw(), execute: () => chain.withdraw(Number(body.usd)) }[body.action];
    if (!fn) throw new HttpError(400, "action must be request|cancel|execute");
    const t = await fn().catch((e) => { throw new HttpError(502, e.message, "chain_error"); });
    await node.refreshChainBalance();
    return { ...t, explorer: chain.explorerTx(t.hash) };
  };

  /** this node's own listing: no secrets, just state of discovery and announcement */
  const revokeListing = async () => {
    const t = await chain.registryRevoke().catch((e) => { throw new HttpError(502, e.message, "chain_error"); });
    node.registry.clearAnnounce();
    return { ...t, explorer: chain.explorerTx(t.hash) };
  };

  return [
    ["GET", "/api/registry", () => node.registry.status()],
    ["POST", "/api/registry/revoke", revokeListing],
    ["GET", "/api/chain", overview],
    ["PUT", "/api/chain", configure],
    ["POST", "/api/chain/deposit", deposit],
    ["POST", "/api/chain/mint", mint],
    ["POST", "/api/chain/withdraw", withdraw],
  ];
}
