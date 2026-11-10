// Consumer entry: route one chat completion. plan → (budget check) → exec → stream/answer → record, route log, ledger
// spend and (chain mode) the voucher. Prompts are never stored: routes and ledger hold metadata only.
import { HttpError } from "../../lib/errors.mjs";
import { rid } from "../../lib/canon.mjs";
import { inc } from "../../obs.mjs";
import { cost } from "../../policy.mjs";
import { outCap, promptEstimate } from "../limits.mjs";
import { nullEvents } from "../events.mjs";
import { spentLast24h } from "../stats.mjs";

export function createChat({ state, save, chain, events = nullEvents }, { plan, cands, settlement, execLocal, execPeer, wallet, record }) {
  const exec = (c, body, ctl) => (c.kind === "peer" ? execPeer(c, body, ctl) : execLocal(c, body, ctl));
  let reservedUsd = 0; // worst-case cost of paid requests in flight: counts against the daily cap so parallel requests cannot all pass it

  function noRouteError(requested) {
    const bl = settlement?.blocked?.() ?? [];
    if (bl.length) {
      const b0 = bl[0], names = bl.slice(0, 3).map((b) => b.name || "peer").join(", ");
      const theirs = b0.escrow ? `${b0.network || "chain"} escrow ${b0.escrow}` : "a simulated ledger";
      const ours = chain.configured() ? `escrow ${state.chain.escrow}` : "a simulated ledger";
      return new HttpError(404, `no route for model "${requested}" under current policy: ${bl.length} online seller${bl.length === 1 ? "" : "s"} (${names}) settle on ${theirs} while this node uses ${ours} — match settlement in the panel (Overview or Payments) or set ELYRA_ESCROW`, "no_route");
    }
    const all = cands ? cands().filter((c) => !c.explicitOnly) : [];
    const hint = all.length
      ? " (check model name, TEE-only or max-price rules under Routing)"
      : " (no live model source or online seller is connected — add Ollama under Connect or a peer under Network)";
    return new HttpError(404, `no route for model "${requested}" under current policy${hint}`, "no_route");
  }

  /**
   * Route a chat completion. Calls `out.head(status, headers)` once, then `out.json(obj)` or `out.write(chunk)`/`out.end()`.
   * Tries up to 3 candidates before first byte; after streaming starts there is no failover.
   */
  return async function chat(body, out, ctl) {
    const requested = body.model ?? "auto";
    const ranked = plan(requested);
    if (!ranked.length) { events.request({ role: "buyer", status: "refused", reason: "no_route", model: requested }); throw noRouteError(requested); }
    const errors = [], unfunded = [], capped = []; // unfunded / capped: routes skipped only because the wallet, escrow or daily spend cap cannot cover them
    for (const c of ranked.slice(0, 3)) {
      let held = 0; // worst-case cost of this request, reserved against the daily cap until it lands in the ledger
      if (c.price > 0 && c.kind !== "self") {
        const worst = cost(c.price * 1.05, promptEstimate(body), outCap(body));
        if (c.kind === "peer" && chain.configured()) {
          if (wallet.balance() < worst) { errors.push(`${c.peerName}: escrow too low for the worst-case cost ($${worst.toFixed(4)})`); unfunded.push(c); continue; }
        } else if (wallet.balance() <= 0) { errors.push("wallet empty"); unfunded.push(c); continue; }
        const cap = state.settings?.spendCapUsdDay;
        if (cap != null) {
          const spent = spentLast24h(state) + reservedUsd;
          if (spent + worst > cap + 1e-9) { errors.push(`${c.peerName}: daily spend cap ($${cap}) would be exceeded`); capped.push({ c, spent, worst }); events.alert({ code: "spend_cap", subject: c.peerName, capUsd: cap, spentUsd: spent }); continue; }
        }
        held = worst; reservedUsd += held;
      }
      try {
        const t0 = Date.now();
        let r;
        try { r = await exec(c, body, ctl); }
        catch (e) { record(c.key, false); inc("elyra_route_total", { result: "error", kind: c.kind }); errors.push(`${c.peerName}: ${e.message}`); events.request({ role: "buyer", status: "error", reason: "upstream_error", peer: c.peerName, model: c.model, simulated: c.simulated, latencyMs: Date.now() - t0 }); continue; }
        const routeInfo = `${c.kind}:${c.peerName}`.replace(/[^\x20-\x7e]/g, "-");
        const headers = {
          "x-elyra-route": routeInfo, "x-elyra-model": c.model, "x-elyra-price": String(c.price),
          "x-elyra-tee": c.tee, "x-elyra-simulated": String(c.simulated),
        };
        let ok = true, firstAt = 0;
        try {
          if (r.json) {
            r.json.elyra = { route: routeInfo, model: c.model, price_per_mtok: c.price, tee: c.tee, simulated: c.simulated, failover: errors };
            out.head(200, { ...headers, "content-type": "application/json" });
            out.json(r.json);
          } else {
            out.head(200, { ...headers, "content-type": "text/event-stream", "cache-control": "no-cache" });
            for await (const f of r.frames) { if (!firstAt) firstAt = Date.now(); out.write(f); }
            out.end();
          }
        } catch (e) { ok = false; errors.push(e.message); }
        const u = await r.usage;
        const ms = Date.now() - t0;
        const amount = c.kind === "self" ? 0 : cost(c.price, u.p, u.c);
        const receipt = r.receipt ? await r.receipt.catch(() => null) : null;
        if (r.receipt && !receipt) ok = false;
        if (ok || !ctl.signal.aborted) record(c.key, ok, ok ? (u.c / Math.max(ms, 1)) * 1000 : 0, ms, ok && firstAt ? firstAt - t0 : 0); // client hang-up is not the peer's fault
        inc("elyra_route_total", { result: ok ? "ok" : "fail", kind: c.kind });
        inc("elyra_tokens_total", { dir: "out" }, u.p + u.c);
        state.routes.push({
          id: rid("r"), ts: Date.now(), dir: "out", requested, model: c.model, peer: c.peerName, peerId: c.peerId, kind: c.kind,
          price: c.price, p: u.p, c: u.c, amount, ms, tps: +((u.c / Math.max(ms, 1)) * 1000).toFixed(1), tee: c.tee,
          simulated: c.simulated, ok, failover: errors.length,
        });
        events.request({
          role: "buyer", status: ok ? "ok" : "error", ...(ok ? {} : { reason: "upstream_error" }), peer: c.peerName, model: c.model, simulated: c.simulated,
          promptTokens: u.p, completionTokens: u.c, costUsd: amount, ttftMs: firstAt ? firstAt - t0 : ms, latencyMs: ms,
        });
        if (ok && c.kind === "peer" && chain.configured() && receipt?.amountUnits) {
          try { await wallet.issueVoucher(state.peers[c.sourceId], receipt); } catch (e) { errors.push("voucher: " + e.message); }
        }
        if (amount > 0 && ok) {
          state.ledger.push({
            id: rid("l"), ts: Date.now(), type: "spend", amount, peer: c.peerName, peerId: c.peerId, model: c.model, p: u.p, c: u.c,
            simulated: c.simulated, receipt: receipt ?? { sim: true }, amountUnits: receipt?.amountUnits, settled: false,
          });
        }
        save();
        if (!ok && !r.json) return; // stream already started; cannot fail over
        if (ok) return;
      } finally { reservedUsd = Math.max(0, reservedUsd - held); } // the ledger now holds the real amount (or the request failed): drop the reservation
    }
    if (capped.length && capped.length + unfunded.length === errors.length) { // every route was skipped by the cap or by lack of funds: the cap is what the user can change
      const names = [...new Set(capped.map((x) => x.c.peerName))].slice(0, 3).join(", "), cap = state.settings.spendCapUsdDay, k = capped[0];
      events.request({ role: "buyer", status: "refused", reason: "spend_cap", peer: capped[0].c.peerName, model: capped[0].c.model, simulated: capped[0].c.simulated });
      throw new HttpError(402, `Daily spend cap reached: $${k.spent.toFixed(4)} spent in the last 24 hours against a cap of $${cap}, and this request to ${names} could cost up to $${k.worst.toFixed(4)} more. To raise it, open your Elyra panel, go to Payments and change "Daily spend cap", or send PUT /api/settings with {"spendCapUsdDay": <dollars per day>} (null removes the cap). Free models on your own machine are not limited.`, "spend_cap_reached");
    }
    if (unfunded.length && unfunded.length === errors.length) { // every route was skipped for lack of funds: say what to do instead of "all routes failed"
      const names = [...new Set(unfunded.map((c) => c.peerName))].slice(0, 3).join(", "), c0 = unfunded[0];
      events.request({ role: "buyer", status: "refused", reason: "unfunded", peer: c0.peerName, model: c0.model, simulated: c0.simulated });
      throw new HttpError(402, `Not enough funds to pay ${names} (${c0.price ? "$" + c0.price + " per million tokens" : "paid"}). Your balance is $${wallet.balance().toFixed(4)}. Fund it first: open your Elyra panel, go to Payments, connect a wallet and deposit USDG. Free models on your own machine need no funds.`, "payment_required");
    }
    throw new HttpError(502, "all routes failed: " + errors.join(" | "), "upstream_error");
  };
}
