// Health card on Home: model sources, peers, settlement chain, registry. Each row is green (ok), amber (needs attention), red (broken) or grey
// (not in use / still checking), always with the reason. Derived from /api/status, /api/upstreams, /api/peers and the /api/chain snapshot; nothing stored.
import { $, esc, setHtml } from "../lib/dom.js";
import { MIN_GAS_ETH } from "./alerts.js";

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** rows: [state, name, reason, view to open | ""]. `ch` is the chain snapshot or null while unknown. */
export function healthRows(st, { ups, peers, ch }) {
  const real = ups.upstreams.filter((u) => !u.builtin), down = real.filter((u) => u.health?.status === "down");
  const rows = [];
  rows.push(!real.length ? ["warn", "Model sources", "No real model connected: answers come from the built-in demo engine.", "connect"]
    : down.length === real.length ? ["bad", "Model sources", `${real.length === 1 ? "The source is" : "All sources are"} offline: ${down.map((u) => esc(u.name)).join(", ")}.`, "connect"]
      : down.length ? ["warn", "Model sources", `${down.length} of ${real.length} offline: ${down.map((u) => esc(u.name)).join(", ")}.`, "connect"]
        : ["ok", "Model sources", `${plural(real.length, "source")} answering.`, ""]);
  const n = st.network;
  rows.push(n.peersLive ? ["ok", "Peers", `${n.peersLive} of ${n.peersKnown} known peers online.`, ""]
    : n.peersKnown ? ["warn", "Peers", `${plural(n.peersKnown, "known peer")}, none online.`, "network"]
      : ["idle", "Peers", "No peers yet. Add one by URL under Network.", "network"]);
  const mode = ch?.mode ?? null;
  rows.push(!ch ? ["idle", "Chain", "Checking the chain…", ""]
    : mode !== "chain" ? ["idle", "Chain", "Simulated ledger: nothing settles on-chain.", "payments"]
      : !ch.connected ? ["bad", "Chain", `${esc(ch.networkName ?? "Chain")} RPC unreachable${ch.error ? ": " + esc(ch.error) : ""}.`, "payments"]
        : Number(ch.walletEth) < MIN_GAS_ETH ? ["warn", "Chain", `${esc(ch.networkName)} connected, but the wallet holds only ${Number(ch.walletEth).toFixed(5)} ETH for gas.`, "payments"]
          : ch.escrowVerified === false ? ["warn", "Chain", `${esc(ch.networkName)} connected, escrow contract not verified.`, "payments"]
            : ["ok", "Chain", `${esc(ch.networkName)}${ch.real ? " · real money" : ""}, escrow verified.`, ""]);
  const viaReg = peers.peers.filter((p) => p.viaRegistry).length;
  rows.push(!ch ? ["idle", "Registry", "Checking the chain…", ""]
    : !ch.registry ? ["idle", "Registry", "No registry on this network: peers are found by URL and gossip only.", ""]
      : !ch.connected ? ["bad", "Registry", "Registry set, but the chain RPC is unreachable.", ""]
        : ["ok", "Registry", viaReg ? `Discovery on, ${plural(viaReg, "peer")} found through it.` : "Discovery on, no peer found through it yet.", ""]);
  return rows;
}

const worst = (rows) => (rows.some((r) => r[0] === "bad") ? "bad" : rows.some((r) => r[0] === "warn") ? "warn" : "ok");
const HEAD = { ok: ["ok", "All systems normal"], warn: ["warn", "Needs attention"], bad: ["bad", "Something is broken"] };

export function renderHealth(rows) {
  const [k, t] = HEAD[worst(rows)];
  setHtml($("#ov-health"), `<div class="hl-sum ${k}"><i class="hdot ${k}"></i><b>${t}</b></div><ul class="hl">${rows.map(([s, name, why, go]) =>
    `<li class="hl-r"><i class="hdot ${s}" role="img" aria-label="${{ ok: "OK", warn: "Attention", bad: "Broken", idle: "Not in use" }[s]}"></i><div><b>${name}</b><p>${why}</p></div>${go ? `<button type="button" class="btn sm ghost" data-go="${go}">Open</button>` : ""}</li>`).join("")}</ul>`);
}
