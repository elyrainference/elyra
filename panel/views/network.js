// Network view: topology ring + peer detail + this-node / peers / TEE trust cards. tick() refetches peers, routes and listings every few seconds;
// the SVG is only rebuilt when `key` changes so hover/selection and CSS animations are not reset by polls.
import { label } from "../lib/format.js";
import { api, del, post } from "../lib/api.js";
import { $ } from "../lib/dom.js";
import { S } from "../lib/store.js";
import { poll } from "../lib/status.js";
import { pageHead, skelStats } from "../components/card.js";
import { segment } from "../components/controls.js";
import { field, httpUrl, watchField } from "../components/form.js";
import { helpBtn } from "../components/pop.js";
import { initTabs, pickTab, tabBar } from "../components/tabs.js";
import { guard, toast } from "../components/toast.js";
import { TABS } from "../lib/nav.js";
import { graphSvg } from "./network-graph.js";
import { buildNodes, isFresh, recentRoutes } from "./network-model.js";
import { renderDetail, renderSide, renderStats, tooltipHtml } from "./network-panels.js";
import { loadTrust } from "./network-trust.js";

const FILTERS = ["ALL", "LIVE", "BRIDGES", "COMMUNITY"];

export const network = {
  f: "ALL", sel: null, key: "", sideSig: "", data: null, nodes: {},
  async enter() {
    this.key = ""; this.sideSig = "";
    const tab = pickTab("network", TABS.network);
    $("#v-network").innerHTML = `
      ${pageHead("Set up", "Network", "Peers find each other by gossip: add one node by URL and you learn the rest. Every node has its own key, prompts travel sealed, and every answer comes with a signed receipt.", '<button type="button" class="btn primary" data-focus="nw-url">Add a peer</button>')}
      <div class="body">
        ${tabBar(TABS.network, tab)}
        <div class="grid g5" id="nw-stats">${skelStats(5)}</div>
        <div class="card" data-pane="topology"><h3>Topology
            <span class="seg" id="nw-seg" role="group" aria-label="Filter">${FILTERS.map((x) => `<button type="button" data-k="${x}" class="${x === this.f ? "on" : ""}">${label(x)}</button>`).join("")}</span></h3>
            <div class="graphbox"><div class="graph" id="nw-graph" role="img" aria-label="Network topology: you in the centre, peers around you"></div><div class="nw-tip" id="nw-tip" hidden></div></div>
            <div class="legend"><span><i class="lg-you"></i>You</span><span><i class="lg-live"></i>Live peer</span><span><i class="lg-bridge"></i>Bridge · API access (simulated)</span><span><i class="lg-comm"></i>Community GPU (simulated)</span><span><i class="lg-flow"></i>Recent route</span></div>
        </div>
        <div class="card" data-pane="topology"><h3>Peer detail <span class="badge count" id="nw-seltag">Click a node</span></h3><div id="nw-detail"></div></div>
        <div class="grid g2" data-pane="peers">
          <div class="card"><h3>This node</h3><div id="nw-self"></div></div>
          <div class="card"><h3>Add a peer</h3>
            ${field("nw-url", "Peer URL", '<div class="inp"><input class="txt" id="nw-url" placeholder="http://host:8546" autocomplete="off" inputmode="url"><button type="button" class="btn primary" id="nw-add">Add</button></div>', "Add one node and the rest are learned by gossip.")}
            <div id="nw-peers" class="mt"></div></div>
        </div>
        <div class="card" data-pane="trust"><h3><span>TEE trust list ${helpBtn("Image digests you accept as genuine Elyra builds. A seller counts as TEE · VERIFIED only when its Google-signed attestation matches a digest you pinned here.")}</span> <span class="badge count" id="nw-trustn"></span></h3><div id="nw-trust"></div></div>
      </div>`;
    initTabs($("#v-network"), "network", tab);
    $("#v-network").onclick = guard(async (e) => {
      const rm = e.target.closest("[data-rmpeer]");
      if (!rm) return;
      const gone = this.data?.peers.find((p) => p.id === rm.dataset.rmpeer);
      await del("/api/peers/" + rm.dataset.rmpeer);
      await this.tick();
      poll();
      toast(`Removed ${gone?.name ?? "the peer"}`, "", gone && { undo: async () => { await post("/api/peers", { url: gone.url }); this.key = ""; this.sideSig = ""; await this.tick(); poll(); } });
    });
    const urlOk = watchField($("#nw-url"), httpUrl);
    $("#nw-add").onclick = guard(async () => {
      if (!urlOk()) return;
      const p = await post("/api/peers", { url: $("#nw-url").value.trim() });
      $("#nw-url").value = "";
      toast("Peer added: " + p.name, "ok");
      this.key = ""; this.sideSig = "";
      await this.tick();
      poll();
    });
    segment("#nw-seg", (b) => { this.f = b.dataset.k; this.key = ""; this.draw(); });
    this.bindGraph();
    await loadTrust(this);
    await this.tick();
  },
  bindGraph() {
    const g = $("#nw-graph"), tip = $("#nw-tip");
    g.onmousemove = (e) => {
      const n = e.target.closest(".nd");
      const p = n && this.nodes?.[n.dataset.id];
      if (!p) { tip.hidden = true; return; }
      const r = $(".graph").parentElement.getBoundingClientRect();
      tip.hidden = false;
      tip.style.left = Math.min(e.clientX - r.left + 16, r.width - 240) + "px";
      tip.style.top = e.clientY - r.top + 14 + "px";
      tip.innerHTML = tooltipHtml(p);
    };
    g.onmouseleave = () => (tip.hidden = true);
    g.onclick = (e) => { const n = e.target.closest(".nd"); this.sel = n ? n.dataset.id : null; this.key = ""; this.draw(); };
    g.onkeydown = (e) => { if (e.key !== "Enter" && e.key !== " ") return; const n = e.target.closest(".nd"); if (!n) return; e.preventDefault(); this.sel = n.dataset.id; this.key = ""; this.draw(); };
  },
  async tick() {
    if (S.view !== "network") return;
    const [{ peers }, { routes }, models] = await Promise.all([api("/api/peers"), api("/api/routes"), api("/api/models")]);
    this.data = { peers, routes, models: models.models };
    this.draw();
  },
  draw() {
    const st = S.status, D = this.data;
    if (!st || !D) return;
    const { live, nodes } = buildNodes(D.peers, D.models);
    this.nodes = nodes;
    if (this.sel && !nodes[this.sel]) this.sel = null;
    const recent = recentRoutes(D.routes);
    renderSide(this, st, D.peers);
    renderStats(st, live, D.models);
    const key = JSON.stringify([this.f, this.sel, Object.keys(nodes), recent.map((r) => r.peerId + isFresh(r)), live.map((p) => p.rtt), st.node.name]);
    if (key === this.key) return;
    this.key = key;
    $("#nw-graph").innerHTML = graphSvg({ nodes, filter: this.f, sel: this.sel, hot: new Map(recent.map((r) => [r.peerId, isFresh(r)])), youName: st.node.name });
    renderDetail(this.sel && nodes[this.sel]);
  },
};
