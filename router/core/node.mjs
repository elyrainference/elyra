// createNode(opts): the single public entry of the VPR core. Builds the shared context (state, identity, chain handle,
// timers) and wires the cohesive modules together; owns no logic of its own. No req/res here: HTTP lives in http/.
//
// Dependency direction:  lib/ + leaf adapters (chain, tee, seal, vault, obs, policy)  ←  core/*  ←  http/  ←  server.mjs
import { createAccounts } from "./accounts.mjs";
import { depositCapOf } from "./limits.mjs";
import { buildCatalog } from "../catalog.mjs";
import { createChain } from "../chain.mjs";
import { createAttestation } from "./attestation.mjs";
import { createMarket } from "./candidates.mjs";
import { createSessionPay } from "./consumer/session-pay.mjs";
import { createChat } from "./consumer/chat.mjs";
import { createPeerExec } from "./consumer/peer-exec.mjs";
import { createReceiptVerifier } from "./consumer/receipts.mjs";
import { createWallet } from "./consumer/wallet.mjs";
import { createLocalExec } from "./exec-local.mjs";
import { registerGauges } from "./gauges.mjs";
import { createEvents } from "./events.mjs";
import { createSettlement } from "./settlement.mjs";
import { createHello } from "./hello.mjs";
import { loadIdentity } from "./identity.mjs";
import { createLedger } from "./ledger.mjs";
import { createPeers } from "./peers.mjs";
import { createCreditGate } from "./provider/credit.mjs";
import { createRequestGuard } from "./provider/guard.mjs";
import { createProvideModels } from "./provider/models.mjs";
import { createReceiptIssuer } from "./provider/receipt.mjs";
import { createRedeemer } from "./provider/redeem.mjs";
import { createServe } from "./provider/serve.mjs";
import { createVouchersIn } from "./provider/vouchers.mjs";
import { createRegistry } from "./registry.mjs";
import { createReputation } from "./reputation.mjs";
import { createStats } from "./stats.mjs";
import { openStore } from "./store.mjs";
import { createUpstreams } from "./upstreams.mjs";

export async function createNode(opts) {
  const { dataDir, port } = opts;
  const identity = loadIdentity(dataDir, opts.passphrase);
  const { state, save, flush } = openStore({ dataDir, opts, selfId: identity.id });

  const timers = [];
  const every = (ms, fn) => { const t = setInterval(fn, ms); t.unref(); timers.push(t); };
  every(1500, flush);

  /** vouchers are only valid for the escrow they were signed for: a changed escrow/network resets every channel (found live: a stale cumulative over-paid a provider) */
  const escrowId = () => `${state.chain.network}:${String(state.chain.escrow).toLowerCase()}`;
  // on-chain settlement adapter (null-safe: unconfigured = simulated testnet ledger)
  const chain = await createChain({ dataDir, getConfig: () => state.chain, allowMainnet: !!opts.allowMainnet, passphrase: opts.passphrase, getDepositCapUsd: () => depositCapOf(state.provide) });

  const ctx = {
    opts, state, save, flush, identity, chain, escrowId, every, events: createEvents(),
    // behind a relay (no public address of its own): peers reach this node at <relay>/r/<id>
    publicUrl: (opts.publicUrl ?? (opts.relayUrl ? `${opts.relayUrl.replace(/\/$/, "")}/r/${identity.id}` : `http://localhost:${port}`)).replace(/\/$/, ""),
    teeMode: opts.tee === "gcp-confidential-space",
  };
  const catalog = buildCatalog();
  const tee = await createAttestation(ctx);
  const { upstreams, upstreamById, addUpstream, detectLocal, refreshUpstream, upstreamUp, upstreamHealth, probeAll } = createUpstreams(ctx);
  const { repOf, record } = createReputation(ctx);
  const settlement = createSettlement(ctx);
  const { candidates, plan } = createMarket(ctx, { catalog, upstreams, repOf, upstreamUp, settlement });
  const execLocal = createLocalExec({ upstreamById });
  const accounts = process.env.ELYRA_GATEWAY === "1" ? createAccounts({ dataDir, passphrase: opts.passphrase }) : null; // wallet accounts: only when the gateway is switched on
  const provideModels = createProvideModels(ctx, { upstreams, upstreamById, upstreamUp, tee });

  // consumer side
  const wallet = createWallet(ctx);
  const execPeer = createPeerExec(ctx, createReceiptVerifier(ctx));
  const chat = createChat(ctx, { plan, cands: candidates, settlement, execLocal, execPeer, wallet, record });
  const sessionPay = createSessionPay(ctx, { plan, execPeer, record }); // browser pay-per-use gateway (opt-in route: ELYRA_PUBLIC_PAY=1)

  // provider side
  const { redeemEntry, settleChain, maybeAutoRedeem } = createRedeemer(ctx);
  const { acceptVoucher, receiveVoucher } = createVouchersIn(ctx, { maybeAutoRedeem });
  const { serve, inflight } = createServe(ctx, {
    execLocal, upstreamById, provideModels,
    guard: createRequestGuard(ctx),
    credit: createCreditGate(ctx, { acceptVoucher, redeemEntry }),
    issueReceipt: createReceiptIssuer(ctx),
  });

  // network + bookkeeping
  const { helloInfo, fetchHello, peerFields } = createHello(ctx, { provideModels, tee });
  const { addPeer, refreshPeers, announcePeers, peerUrls } = createPeers(ctx, { helloInfo, fetchHello, peerFields });
  const registry = createRegistry(ctx, { addPeer }); // on-chain discovery (opt-out) + seller announce (opt-in); never part of boot
  const { settle } = createLedger(ctx, { settleChain });
  const stats = createStats(ctx);
  registerGauges(ctx, { balance: wallet.balance, inflight, upstreams, upstreamUp });

  return {
    state, selfId: identity.id, address: chain.address, chain, publicUrl: ctx.publicUrl, balance: wallet.balance, plan, cands: candidates,
    chat, sessionPay, serve, receiveVoucher, refreshChainBalance: wallet.refreshChainBalance, helloInfo, addPeer, refreshPeers, announcePeers, save, flush,
    settlement, addUpstream, detectLocal, refreshUpstream, upstreams, upstreamUp, upstreamHealth, probeAll, settle, fund: wallet.fund, stats, provideModels, catalog,
    relayIdentity: { id: identity.id, pub: identity.pub, sign: identity.sign }, // what a relay client needs: no private halves
    port, host: opts.host, peerUrls, upstreamById, execLocal, accounts,
    dataDir, encrypted: !!opts.passphrase, // where identity + wallet live; whether they are encrypted at rest (a boolean only, never the passphrase)
    teeActive: tee.active, teeMode: () => ctx.teeMode,
    registry, events: ctx.events,
    close() { for (const t of timers) clearInterval(t); registry.stop(); flush(); },
  };
}
