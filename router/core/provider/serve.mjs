// Provider entry for POST /p2p/infer (sealed-only, protocol v3). Order matters and every step fails closed:
// provider enabled → deny list/rate limit → open envelope → authenticate (guard.mjs) → model + price quote →
// chain credit gate (credit.mjs) → concurrency cap → upstream exec → signed receipt (receipt.mjs).
// Everything inside the envelope is end-to-end encrypted to this node's box key. Never logs prompts.
import { HttpError } from "../../lib/errors.mjs";
import { wholeEvents } from "../../lib/sse.mjs";
import { open as openBox } from "../../seal.mjs";
import { approxTokens, cost } from "../../policy.mjs";
import { outCap, promptEstimate } from "../limits.mjs";
import { nullEvents } from "../events.mjs";

export function createServe({ state, save, identity, chain, events = nullEvents }, { execLocal, upstreamById, provideModels, guard, credit, issueReceipt }) {
  let inflight = 0;

  /** provider side of /p2p/infer. `wire` = { from, sealed }. A request that failed AFTER it authenticated is shown in the owner's feed (refused/error); strangers' failures are not. */
  async function serve(wire, out, ctl) {
    const seen = {}, t0 = Date.now();
    try { await serveRequest(wire, out, ctl, seen); }
    catch (e) {
      if (seen.model !== undefined) events.request({ role: "seller", status: (e.status ?? 500) >= 500 ? "error" : "refused", reason: e.type, peer: seen.peer, model: seen.model, counterparty: seen.wallet, latencyMs: Date.now() - t0, simulated: false });
      throw e;
    }
  }

  async function serveRequest(wire, out, ctl, seen) {
    const P = state.provide;
    if (!P.enabled) throw new HttpError(403, "this node is not providing", "not_providing");
    if (typeof wire?.from !== "string" || !wire.from || wire.from.length > 64 || !wire?.sealed || typeof wire.sealed !== "object") throw new HttpError(400, "sealed envelope required (protocol v3)", "unsealed");
    if (P.deny.includes(wire.from)) throw new HttpError(403, "consumer not allowed", "denied");
    if (!guard.allow(wire.from, P.ratePerMin)) throw new HttpError(429, "rate limit", "rate_limited");
    let payload, session;
    try { ({ obj: payload, session } = openBox(identity.box.priv, identity.box.pub, wire.sealed)); }
    catch { throw new HttpError(400, "cannot open envelope", "bad_envelope"); }
    guard.authenticate(wire, payload);
    const { consumer, model, body, maxPrice, auth } = payload;
    seen.peer = "peer " + consumer.id.slice(0, 6); seen.model = model;
    const m = provideModels().find((x) => x.id === model);
    const up = m ? (provideModels.upstreamFor ? provideModels.upstreamFor(model) : upstreamById(P.upstreamId)) : null;
    if (!m || !up) throw new HttpError(404, `model "${model}" not offered here`, "no_model");
    if (maxPrice != null && maxPrice < m.price) throw new HttpError(409, `price changed: now ${m.price}`, "price_mismatch");

    // bound the work of one request: output is capped, so the worst-case price is known before any compute is spent
    const maxOut = outCap(body);
    const promptEst = promptEstimate(body);
    const work = { ...body, model, max_tokens: maxOut };

    const chainOn = chain.configured();
    let inv = null, wk = null;
    if (chainOn) { ({ inv, wk } = await credit({ consumer, voucher: payload.voucher, m, maxOut, promptEst })); seen.wallet = consumer.wallet; }

    if (inflight >= P.maxConcurrent) throw new HttpError(429, "provider busy", "busy");
    inflight++;
    const t0 = Date.now();
    const cand = { kind: "self", sourceId: up.id, model, key: `self:${up.id}:${model}` };
    let receipted = false, streamedChars = 0;
    try {
      let r;
      try { r = await execLocal(cand, work, ctl); }
      catch (e) { throw new HttpError(502, e.message, "upstream_error"); }
      const mkReceipt = async () => {
        const u = await r.usage;
        const receipt = issueReceipt({ u, m, consumer, auth, model, inv, wk, t0 });
        receipted = true;
        return receipt;
      };
      if (r.json) {
        out.head(200, { "content-type": "application/json" });
        out.json({ enc: session.seal({ completion: r.json, receipt: await mkReceipt() }) });
      } else {
        out.head(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        const enc = (msg) => `event: enc\ndata: ${session.seal(msg)}\n\n`;
        for await (const ev of wholeEvents(r.frames)) { streamedChars += ev.length; out.write(enc({ k: "frame", v: ev })); }
        out.write(enc({ k: "receipt", v: await mkReceipt() }));
        out.end();
      }
    } finally {
      inflight--;
      // work was done but no receipt was issued (consumer hung up mid-stream): still count it as owed so the credit limit sees it
      if (chainOn && !receipted && inv && streamedChars > 0) {
        inv.owedUnits = (BigInt(inv.owedUnits) + chain.usdToUnits(cost(m.price, promptEst, approxTokens("x".repeat(Math.min(streamedChars, 4_000_000)))))).toString();
        save();
      }
    }
  }

  return { serve, inflight: () => inflight };
}
