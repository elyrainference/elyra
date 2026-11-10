// Models & peers: searchable/filterable list of every listing the router can reach. Read-only; "Try" jumps to the playground (see actions.js).
import { api } from "../lib/api.js";
import { $, esc, setHtml } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { label, price } from "../lib/format.js";
import { S } from "../lib/store.js";
import { logo, origin, privacy } from "../components/badge.js";
import { empty, pageHead, skelRows } from "../components/card.js";
import { segment } from "../components/controls.js";
import { table } from "../components/table.js";

const FILTERS = ["ALL", "LIVE", "TEE", "CHEAPEST", "FASTEST", "TOP RATED"];

export const models = {
  f: "ALL", q: "", all: [],
  async enter() {
    $("#v-models").innerHTML = `
      ${pageHead("Use AI", "Models &amp; sellers", "Compare the offers this router can reach: your own sources, live peers and labelled SIM demo listings. Try selects a model, not a guaranteed seller. Local inference needs no escrow; review Payments before using paid peers.", '<button type="button" class="btn primary" data-go="playground">Open Playground</button>')}
      <div class="body"><div class="card">
        <div class="toolbar">
          <div class="search">${icon("search")}<input class="txt" id="m-q" type="search" placeholder="Search model, vendor or peer…" aria-label="Search models" value="${esc(this.q)}" /></div>
          <div class="pills" id="m-seg" role="group" aria-label="Filter">${FILTERS.map((x) => `<button type="button" data-k="${x}" class="pill ${x === this.f ? "on" : ""}">${label(x)}</button>`).join("")}</div>
          <span class="badge count" id="m-count"></span>
        </div>
        <div class="tablewrap tall" id="m-table">${skelRows(8)}</div>
      </div></div>`;
    $("#m-q").oninput = (e) => { this.q = e.target.value.toLowerCase().trim(); this.draw(); };
    segment("#m-seg", (b) => { this.f = b.dataset.k; this.draw(); });
    this.all = (await api("/api/models")).models;
    this.draw();
  },
  rows() {
    let rows = this.all.filter((c) => !this.q || (c.model + c.peerName + (c.vendor ?? "")).toLowerCase().includes(this.q));
    if (this.f === "LIVE") rows = rows.filter((c) => !c.simulated);
    if (this.f === "TEE") rows = rows.filter((c) => c.tee === "verified");
    if (this.f === "CHEAPEST") rows = [...rows].sort((a, b) => a.price - b.price);
    if (this.f === "FASTEST") rows = [...rows].sort((a, b) => b.tps - a.tps);
    if (this.f === "TOP RATED") rows = [...rows].sort((a, b) => b.reputation - a.reputation);
    return rows;
  },
  draw() {
    const rows = this.rows();
    $("#m-count").textContent = rows.length + " listings · " + new Set(rows.map((r) => r.model)).size + " models";
    setHtml($("#m-table"), rows.length
      ? table(["Model", "Seller", ["$ / MTok", "r"], ["Speed", "r"], ["Rating", "r"], "Privacy", "Source", ""], rows.slice(0, 200).map((c) =>
        `<tr><td><span class="mn">${logo(c.logo, c.model)}<b>${esc(c.model)}</b></span></td><td>${esc(c.peerName)}</td><td class="r">${c.price ? price(c.price) : "free"}</td><td class="r">${esc(c.tps)} t/s</td><td class="r">★ ${esc(c.reputation)}</td><td>${privacy(c)}</td><td>${origin(c)}</td><td class="r"><button type="button" class="btn sm" data-try="${esc(c.model)}">Try</button></td></tr>`))
      : (() => {
          const bl = S.status?.network?.blocked ?? [];
          if (bl.length) {
            const b0 = bl[0], names = bl.slice(0, 3).map((b) => esc(b.name || "a seller")).join(", ");
            return empty("Settlement mismatch hides " + bl.length + " online seller" + (bl.length === 1 ? "" : "s"), `${names} ${bl.length === 1 ? "settles" : "settle"} on ${b0.escrow ? `${esc(b0.network || "chain")} escrow <code>${esc(b0.escrow.slice(0, 10))}…</code>` : "a simulated ledger"}. <a href="#overview" data-go="overview">Match settlement on Overview</a> or <a href="#payments" data-go="payments">open Payments</a> to use their models.`);
          }
          return empty("Nothing here", "No listing matches. Turn the demo network on under Network, or connect a model source.", '<button type="button" class="btn sm primary" data-go="connect">Connect a model</button>', "models");
        })());
  },
};
