// Network view side panels: stat cards, this-node + peer list, peer detail table, hover tooltip.
// They take the view object only to reset its redraw signatures after a mutation. Must not: fetch topology (network.js does).
import { put } from "../lib/api.js";
import { $, esc, setHtml } from "../lib/dom.js";
import { fmt, price, shortAddr } from "../lib/format.js";
import { poll } from "../lib/status.js";
import { fromRegistry, logo, privacy } from "../components/badge.js";
import { empty, kv, statCard } from "../components/card.js";
import { switchRow } from "../components/controls.js";
import { table } from "../components/table.js";
import { guard } from "../components/toast.js";

export function renderStats(st, live, listings) {
  const rtts = live.map((p) => p.rtt).filter(Boolean).sort((a, b) => a - b);
  const priv = listings.filter((c) => c.tee !== "none" || (c.kind === "self" && !c.hosted && !c.remote)).length;
  setHtml($("#nw-stats"),
    statCard(live.length, "Live peers", live.length ? "gossip every 15 s" : "none yet · add one →") +
    statCard(st.network.simPeers, "Simulated peers", st.network.demoNetwork ? "demo market on" : "demo market off") +
    statCard(fmt(st.network.listings), "Listings", `${st.network.models} distinct models`) +
    statCard(fmt(priv), "Private listings", "TEE claims + local upstreams") +
    statCard(rtts.length ? rtts[Math.floor(rtts.length / 2)] + " ms" : "—", "Median RTT", "live peers only"));
}

const modelCount = (p) => `${p.models.length} model${p.models.length === 1 ? "" : "s"}`;

// "this node" card + peer list; skipped when nothing relevant changed so the demo switch / remove buttons survive polls
export function renderSide(view, st, peers) {
  const sig = JSON.stringify([st.node.name, st.network.demoNetwork, peers.map((p) => [p.id, p.online, p.rtt, p.models.length, !!p.viaRegistry]), st.node.publicUrl, st.node.relay?.connected, st.node.relay?.error]);
  if (sig === view.sideSig) return;
  view.sideSig = sig;
  const rl = st.node.relay;
  $("#nw-self").innerHTML = kv("Name", esc(st.node.name)) + kv("Node ID", `<span class="mono">${esc(st.node.id)}</span>`) + kv("Wallet", st.node.address ? esc(shortAddr(st.node.address)) : "—") + kv("Peer URL", `<span class="mono">${esc(st.node.publicUrl)}</span> <button type="button" class="btn sm" data-copy="${esc(st.node.publicUrl)}">Copy</button>`) +
    (rl ? kv("Relay", rl.connected ? `Connected · ${esc(rl.relay)}` : `Reconnecting · ${esc(rl.error || rl.relay)}`) : "") +
    switchRow("nw-sim", st.network.demoNetwork, "Demo network", "Adds simulated peers so routing has a market to choose from. Always labelled, never settled.");
  $("#nw-sim").onclick = guard(async () => {
    await put("/api/settings", { demoNetwork: !$("#nw-sim").classList.contains("on") });
    view.key = ""; view.sideSig = "";
    await poll();
    await view.tick();
  });
  $("#nw-peers").innerHTML = peers.length
    ? peers.map((p) => `<div class="row"><span class="mn top"><span class="dot peer-dot ${p.online ? "" : "off"}" style="margin-top:7px"></span><span><b>${esc(p.name)}</b> ${fromRegistry(p)}<span class="sub mono">${esc(p.url)}</span><span class="sub">${p.online ? esc(p.rtt) + " ms" : "offline"} · ${modelCount(p)}</span></span></span><button type="button" class="btn sm ghost" data-rmpeer="${esc(p.id)}" aria-label="Remove peer ${esc(p.name)}" title="Remove peer">×</button></div>`).join("")
    : empty("No live peers yet", "Start a second node: <code>npm run node2</code>, or paste a seller's URL above.", "", "network");
}

export function renderDetail(n) {
  $("#nw-seltag").textContent = n ? n.kind[0].toUpperCase() + n.kind.slice(1) : "Click a node";
  if (!n) { $("#nw-detail").innerHTML = empty("Pick a peer", "Click any node in the topology to see what it serves, at what price, and route to it.", "", "network"); return; }
  const where = n.kind === "live" ? esc(n.url) + " · " + esc(n.rtt ?? "?") + " ms" : n.kind + " · simulated · " + esc(n.region ?? "");
  $("#nw-detail").innerHTML = `<div class="mn" style="margin-bottom:16px">${logo(n.logo ?? n.models[0]?.logo, n.name, true)}<span><b style="font-size:15px">${esc(n.name)}</b><span class="sub">${where}</span></span></div>` +
    (n.models.length
      ? `<div class="tablewrap">${table(["Model", ["$ / MTok", "r"], ["Speed", "r"], "Privacy", ""], n.models.map((m) =>
        `<tr><td><span class="mn">${logo(m.logo, m.model)}<b>${esc(m.model)}</b></span></td><td class="r">${price(m.price)}</td><td class="r">${m.tps ? esc(m.tps) + " t/s" : "—"}</td><td>${privacy({ kind: n.kind, tee: n.kind === "live" ? (n.attest?.ok && m.tee && m.tee !== "none" ? "verified" : m.tee) : m.tee, attest: n.attest })}</td><td class="r"><button type="button" class="btn sm" data-try="${esc(m.model)}">Try</button></td></tr>`))}</div>`
      : empty("Not offering", "This peer is online but has nothing enabled under Provide.", "", "provide"));
}

export function tooltipHtml(p) {
  const meta = p.kind === "live" ? "live peer · " + esc(p.rtt ?? "?") + " ms" : p.kind + " · simulated · " + esc(p.region ?? "");
  const range = p.models.length ? " · " + (p.pmin === p.pmax ? price(p.pmin) : price(p.pmin) + "–" + price(p.pmax)) + "/MTok" : "";
  return `<b>${esc(p.name)}</b><br><span class="mut">${meta}</span><br>${modelCount(p)}${range}${p.tee ? " · TEE" : ""}`;
}
