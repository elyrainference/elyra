// The one banner at the top of Home, derived from live state (nothing stored): sellers you cannot reach yet, or "your real model is connected".
// Owns its two actions: adopt a seller's settlement, and hide the simulated market (with Undo).
import { put } from "../lib/api.js";
import { $, esc, setHtml } from "../lib/dom.js";
import { poll } from "../lib/status.js";
import { guard, toast } from "../components/toast.js";

const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const box = (kind, label, title, text, actions) => `<div class="card next ${kind}"><div class="tx"><small>${label}</small><b>${title}</b><p>${text}</p></div><div class="act">${actions}</div></div>`;

/** `ups`: the /api/upstreams answer. */
export function renderNext(st, ups) {
  const live = ups.upstreams.filter((u) => !u.builtin).length + st.network.peersLive;
  const bl = st.network.blocked ?? [], b0 = bl[0];
  const sellers = bl.slice(0, 3).map((b) => esc(b.name || "a seller")).join(", ") + (bl.length > 3 ? ` and ${bl.length - 3} more` : "");
  const blocked = !bl.length ? "" : b0.escrow
    ? box("warn", "Cannot reach these models yet", `${sellers} ${bl.length === 1 ? "sells" : "sell"} models you cannot use`,
      `${bl.length === 1 ? "It settles" : "They settle"} on ${esc(b0.network ?? "another network")} with escrow <code>${esc(short(b0.escrow))}</code>. Your node ${st.network.settlement?.configured ? "settles on a different escrow" : "settles on a simulated ledger"}, so their models are hidden. Switch to the same escrow to use them.`,
      `<button type="button" class="btn sm primary" id="ov-adopt" data-net="${esc(b0.network ?? "")}" data-esc="${esc(b0.escrow)}">Use this settlement</button><button type="button" class="btn sm" data-go="payments">Open Payments</button>`)
    : box("warn", "Cannot reach these models yet", `${sellers} ${bl.length === 1 ? "settles" : "settle"} with a simulated ledger`,
      "Your node settles on-chain, and a simulated seller cannot be paid on-chain, so its models are hidden.", '<button type="button" class="btn sm" data-go="payments">Open Payments</button>');
  setHtml($("#ov-next"), blocked || (live && st.network.demoNetwork && st.network.simPeers
    ? box("ok", "Ready", "Your real model is connected", `Requests to <code>auto</code> now go to your live sources only. ${esc(String(st.network.simPeers))} simulated demo peers are still listed in Models and Network; hide them if you do not need the demo market.`,
      '<button type="button" class="btn sm primary" data-go="playground">Try it</button><button type="button" class="btn sm" id="ov-hide-sim">Hide simulated market</button>')
    : ""));
}

/** Click handling for the banner; `refresh` re-draws Home after a change. */
export function bindNext(refresh) {
  $("#ov-next").onclick = guard(async (e) => {
    const adopt = e.target.closest("#ov-adopt");
    if (adopt) {
      const { net, esc: addr } = adopt.dataset;
      if (!confirm(`Switch this node's settlement to ${net || "that network"}, escrow ${addr}?\n\nOnly do this if you trust this seller or the address matches the one in the Elyra docs. Payments on another escrow stay separate.`)) return;
      await put("/api/chain", { ...(net ? { network: net } : {}), escrow: addr });
      toast("Settlement switched. Their models will appear in a moment.", "ok");
    } else if (e.target.closest("#ov-hide-sim")) {
      await put("/api/settings", { demoNetwork: false });
      toast("Simulated market hidden. Only your real sources and live peers remain.", "ok", { undo: async () => { await put("/api/settings", { demoNetwork: true }); await poll(); await refresh(); } });
    } else return;
    await poll();
    await refresh();
  });
}
