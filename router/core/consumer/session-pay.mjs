// Pay-per-use from a browser wallet, non-custodial. The visitor's page holds a SESSION key; the visitor deposits into the escrow for that
// session address (depositFor), so only the session key can ever sign vouchers or withdraw. This node is only a gateway: it relays the request
// to a seller under its own peer identity, verifies the seller's signed receipt like any consumer, and hands the verified amount back to the
// page, which signs the next cumulative voucher itself. This node never holds a key that can spend or withdraw the visitor's money.
// Trust note: the page takes the amount from this node, so the page must cap it (see panel/try/pay.js); a seller still can only redeem
// vouchers the session key signed.
import { HttpError } from "../../lib/errors.mjs";
import { sealTo } from "../../seal.mjs";
import { inc } from "../../obs.mjs";
import { cost } from "../../policy.mjs";
import { depositCapOf, outCap, promptEstimate } from "../limits.mjs";

const isUnits = (x) => typeof x === "string" && /^\d{1,30}$/.test(x);

export function createSessionPay({ state, identity, chain }, { plan, execPeer, record }) {
  const busy = new Set(); // session wallets with a request in flight: vouchers are sequential, one request per session at a time

  /** the session's proof of control: its own EIP-191 signature binding THIS node's id to the session wallet (same proof a node wallet gives a seller) */
  function checkSession(s) {
    if (!chain.configured()) throw new HttpError(503, "this node does not settle on-chain, so there is nothing to pay with", "unavailable");
    if (!s || !chain.isAddress(s.wallet) || typeof s.proof !== "string" || !chain.verifyBinding(identity.id, s.wallet, s.proof)) throw new HttpError(400, "bad session proof: create a new session in this browser", "invalid_request_error");
    return { wallet: String(s.wallet), proof: s.proof };
  }
  const voucherFor = (vouchers, peer, wallet) => {
    const v = vouchers && typeof vouchers === "object" ? vouchers[String(peer.wallet).toLowerCase()] : null;
    return v && isUnits(String(v.cumulative)) && chain.verifyVoucher(wallet, peer.wallet, String(v.cumulative), v.sig) ? { cumulative: String(v.cumulative), sig: v.sig } : null;
  };

  /**
   * One paid chat. `out`: { head(status, headers), write(chunk), end() } (a ServerResponse adapter). Fails over between sellers only before the first byte.
   * Streams the answer as SSE and ends with an `event: pay` frame carrying what the page must sign, then `data: [DONE]`.
   */
  async function chat(body, out, ctl) {
    const session = checkSession(body.session);
    const model = typeof body.model === "string" ? body.model.slice(0, 120) : "";
    const maxPrice = Number(body.maxPrice);
    if (!model || !Number.isFinite(maxPrice) || maxPrice < 0) throw new HttpError(400, "model and maxPrice (USD per million tokens) are required", "invalid_request_error");
    const key = session.wallet.toLowerCase();
    if (busy.has(key)) throw new HttpError(429, "this session already has a request in flight", "rate_limited");
    const ranked = plan(model).filter((c) => c.kind === "peer" && !c.simulated && c.price <= maxPrice);
    if (!ranked.length) throw new HttpError(404, `no paid seller of "${model}" at or below $${Number.isFinite(maxPrice) ? maxPrice : "?"} per million tokens right now`, "no_route");
    busy.add(key);
    const errors = []; let lowFunds = null;
    try {
      for (const c of ranked.slice(0, 3)) {
        const peer = state.peers[c.sourceId]; if (!peer) continue;
        const sent = { messages: body.messages, max_tokens: body.max_tokens, temperature: body.temperature, stream: true };
        const worst = chain.usdToUnits(cost(c.price * 1.05, promptEstimate(sent), outCap(sent)));
        let pos; try { pos = await chain.consumerPosition(session.wallet, peer.wallet, { fresh: true }); } catch { throw new HttpError(503, "cannot read the escrow right now, try again", "chain_unavailable"); }
        const capUsd = Number(peer.chain?.maxDepositUsd) > 0 ? Number(peer.chain.maxDepositUsd) : depositCapOf(state.provide);
        if (BigInt(pos.deposit) > chain.usdToUnits(capUsd)) throw new HttpError(402, `The session's escrow deposit ($${chain.unitsToUsd(pos.deposit).toFixed(2)}) exceeds the $${capUsd} per-wallet cap. Withdraw down to $${capUsd} or less first.`, "deposit_cap_exceeded");
        const voucher = voucherFor(body.vouchers, peer, session.wallet);
        const committed = voucher && BigInt(voucher.cumulative) > pos.claimed ? BigInt(voucher.cumulative) - pos.claimed : 0n;
        if (BigInt(pos.deposit) - committed < worst) { lowFunds = { have: chain.unitsToUsd(BigInt(pos.deposit) - committed), need: chain.unitsToUsd(worst) }; errors.push(`${c.peerName}: the session's escrow cannot cover the worst case`); continue; }
        const t0 = Date.now(); let r;
        try { r = await execPeer(c, sent, ctl, { wallet: session.wallet, proof: session.proof, voucher }); }
        catch (e) { record(c.key, false); inc("elyra_paid_chat_total", { result: "error" }); errors.push(`${c.peerName}: ${e.message}`); continue; }
        out.head(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", "x-elyra-route": `peer:${String(c.peerName).replace(/[^\x20-\x7e]/g, "-")}`, "x-elyra-model": c.model, "x-elyra-price": String(c.price), "x-elyra-simulated": "false" });
        let ok = true, firstAt = 0;
        try { for await (const f of r.frames) { if (f.trim() === "data: [DONE]") continue; if (!firstAt) firstAt = Date.now(); out.write(f); } }
        catch (e) { ok = false; out.write(`event: error\ndata: ${JSON.stringify({ message: "the seller's answer could not be verified" })}\n\n`); }
        const receipt = r.receipt ? await r.receipt.catch(() => null) : null;
        const u = await r.usage, ms = Date.now() - t0;
        if (!receipt) ok = false;
        if (ok || !ctl.signal.aborted) record(c.key, ok, ok ? (u.c / Math.max(ms, 1)) * 1000 : 0, ms, ok && firstAt ? firstAt - t0 : 0);
        inc("elyra_paid_chat_total", { result: ok ? "ok" : "fail" });
        if (ok && isUnits(receipt.amountUnits)) {
          out.write(`event: pay\ndata: ${JSON.stringify({ providerId: peer.id, providerWallet: peer.wallet, amountUnits: receipt.amountUnits, claimedUnits: pos.claimed.toString(), promptTokens: receipt.promptTokens, completionTokens: receipt.completionTokens, price: receipt.price, model: c.model })}\n\n`);
        }
        out.write("data: [DONE]\n\n"); out.end();
        return;
      }
      if (lowFunds) throw new HttpError(402, `The session does not hold enough to start this chat (needs about $${lowFunds.need.toFixed(4)}, has $${Math.max(0, lowFunds.have).toFixed(4)}). Add funds to the session first.`, "payment_required");
      throw new HttpError(502, "no seller could answer: " + errors.join(" | "), "upstream_error");
    } finally { busy.delete(key); }
  }

  /** the page signed a voucher for what it just used: check it is a voucher the contract will accept, then hand it (sealed) to the seller */
  async function voucher(b) {
    const session = checkSession(b.session);
    const peer = typeof b.providerId === "string" ? state.peers[b.providerId] : null;
    if (!peer?.box || !peer.wallet) throw new HttpError(404, "unknown seller");
    if (!isUnits(String(b.cumulative)) || !chain.verifyVoucher(session.wallet, peer.wallet, String(b.cumulative), b.sig)) throw new HttpError(400, "that is not a valid voucher for this session and seller", "invalid_request_error");
    const { envelope } = sealTo(peer.box, { consumer: { id: identity.id, wallet: session.wallet, walletProof: session.proof }, cumulative: String(b.cumulative), sig: b.sig });
    let r;
    try { r = await fetch(peer.url + "/p2p/voucher", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: identity.id, sealed: envelope }), signal: AbortSignal.timeout(6000) }); }
    catch { throw new HttpError(502, "the seller could not be reached", "upstream_error"); }
    const j = await r.json().catch(() => ({}));
    inc("elyra_paid_voucher_total", { accepted: String(!!j.accepted) });
    return { accepted: r.ok && j.accepted === true };
  }

  /** what the session holds in the escrow (public chain data; cached by the chain adapter) */
  async function position(wallet) {
    if (!chain.configured() || !chain.isAddress(wallet)) throw new HttpError(400, "a session address is required", "invalid_request_error");
    let p;
    try { p = await chain.consumerPosition(wallet, wallet, { fresh: true }); } // fresh: right after a deposit the page must show it, not a 15 s old zero
    catch { throw new HttpError(503, "cannot read the escrow right now, try again", "chain_unavailable"); }
    const maxDepositUsd = depositCapOf(state.provide);
    return { depositUnits: p.deposit.toString(), depositUsd: chain.unitsToUsd(p.deposit), maxDepositUsd };
  }
  return { chat, voucher, position };
}
