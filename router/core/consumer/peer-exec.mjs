// Consumer side of POST /p2p/infer: seal the request to the provider's box key, authenticate it, stream or read the
// sealed reply and verify the signed receipt (receipts.mjs) before anything is billed. Must not issue vouchers.
import crypto from "node:crypto";
import { canon, sha } from "../../lib/canon.mjs";
import { sseEvents, textOfFrame } from "../../lib/sse.mjs";
import { sealTo } from "../../seal.mjs";
import { outCap, promptEstimate } from "../limits.mjs";

export function createPeerExec({ state, identity, chain, escrowId }, verifyReceipt) {
  /** `payer` (optional) = { wallet, proof, voucher }: a session wallet that is NOT this node's own (browser pay-per-use). The wallet pays; this node only relays and verifies. */
  return async function execPeer(c, body, ctl, payer = null) {
    const peer = state.peers[c.sourceId];
    if (!peer) throw new Error("peer unknown");
    const chainOn = chain.configured();
    const maxPrice = +(c.price * 1.05).toFixed(6);
    const sent = { ...body, model: c.model, max_tokens: outCap(body) };
    const promptEst = promptEstimate(body);
    const nonce = crypto.randomBytes(12).toString("hex"), ts = Date.now();
    const v0 = payer ? null : state.vouchersOut[peer.id];
    const v = v0?.escrow === escrowId() ? v0 : null;
    const payload = {
      consumer: { id: identity.id, pub: identity.pub, ...(payer ? { wallet: payer.wallet, walletProof: payer.proof } : chainOn ? { wallet: chain.address, walletProof: await chain.signBinding(identity.id) } : {}) },
      model: c.model, maxPrice, body: sent, voucher: payer ? (payer.voucher ?? null) : chainOn && v ? { cumulative: v.cumulative, sig: v.sig } : null,
      auth: { ts, nonce, sig: identity.sign({ provider: peer.id, ts, nonce, model: c.model, bodyHash: sha(canon(sent)) }) },
    };
    const { envelope, session } = sealTo(peer.box, payload);
    const r = await fetch(peer.url + "/p2p/infer", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: identity.id, sealed: envelope }), signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`peer ${peer.name}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const check = (receipt, text) => verifyReceipt(receipt, text, { peer, nonce, maxPrice, promptEst, maxTokens: sent.max_tokens, chainOn });
    if (!body.stream) {
      const { enc } = await r.json();
      const { completion, receipt } = JSON.parse(session.open(enc));
      check(receipt, completion.choices?.[0]?.message?.content ?? "");
      return { json: completion, usage: Promise.resolve({ p: receipt.promptTokens, c: receipt.completionTokens }), receipt: Promise.resolve(receipt) };
    }
    let resolveR, rejectR;
    const receipt = new Promise((res, rej) => ((resolveR = res), (rejectR = rej)));
    receipt.catch(() => {});
    const usage = receipt.then((x) => ({ p: x.promptTokens, c: x.completionTokens }), () => ({ p: 0, c: 0 }));
    async function* frames() {
      let got = false, text = "";
      try {
        for await (const ev of sseEvents(r.body)) {
          if (ev.event !== "enc") continue;
          const msg = JSON.parse(session.open(ev.data));
          if (msg.k === "receipt") { resolveR(check(msg.v, text)); got = true; continue; }
          if (msg.v.includes("[DONE]")) continue; // re-emitted after the receipt is verified
          text += textOfFrame(msg.v);
          yield msg.v;
        }
        if (!got) throw new Error("stream ended without receipt");
        yield "data: [DONE]\n\n";
      } catch (e) { rejectR(e); throw e; }
    }
    return { frames: frames(), usage, receipt };
  };
}
