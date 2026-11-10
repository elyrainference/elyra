// Overview (Home) as a dashboard: header with the primary action, alerts and the one banner, quick actions, KPI cards, usage chart, health, recent activity,
// active policy, and the get-started checklist (open while unfinished, collapsed once done). The checklist lives in onboarding.js.
// Must not: re-render the shell on poll; tick() only refreshes the dynamic regions.
import { toolUrl } from "../lib/config.js";
import { $, esc, setHtml } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { S } from "../lib/store.js";
import { helpBtn } from "../components/pop.js";
import { pageHead, skelBlock, skelRows, skelStats } from "../components/card.js";
import { segment } from "../components/controls.js";
import { guard } from "../components/toast.js";
import { alertsFor, alertsRegion, renderAlerts } from "./alerts.js";
import { recentActivity, renderActivity } from "./dash-activity.js";
import { healthRows, renderHealth } from "./dash-health.js";
import { drawUsage, kpiCards, RANGES } from "./dash-usage.js";
import { bindNext, renderNext } from "./overview-next.js";
import { guideContext, renderSteps } from "./onboarding.js";

const QUICK = [["models", "models", "Compare models", "Reachable sellers, prices and privacy"], ["playground", "send", "Try Playground", "Test the route, then inspect its details"],
  ["connect", "plug", "Connect a source", "Own model: no escrow deposit"], ["provide", "provide", "Sell capacity", "Models → prices → reachability → earnings"], ["payments", "payments", "Payments & receipts", "Optional paid peers; node wallet only"]];
const GUIDE_PREF = "elyra-guide-open";

function policyCard(st) {
  const w = st.policy.weights, tot = w.price + w.speed + w.reputation + w.privacy || 1;
  const bar = (k) => { const pct = Math.round((w[k] / tot) * 100); return `<div class="pw"><div class="t"><span>${k[0].toUpperCase() + k.slice(1)}</span><b>${pct}%</b></div><div class="bar"><i style="width:${pct}%"></i></div></div>`; };
  return ["price", "speed", "reputation", "privacy"].map(bar).join("") +
    `<div class="sep"></div><div class="row"><span class="k">TEE required</span><span class="v">${st.policy.teeOnly ? "On" : "Off"}</span></div><div class="row"><span class="k">Max price</span><span class="v">${st.policy.maxPrice == null ? "None" : "$" + st.policy.maxPrice + "/MTok"}</span></div>`;
}

export const overview = {
  range: "24h", dir: "out", routes: [],
  async enter() {
    // first visit: a node that is already providing is most likely run by a seller
    if (localStorage.getItem("elyra-role") == null) S.role = S.status?.providing?.enabled ? "sell" : "local";
    const st = S.status, url = toolUrl(st?.node?.port);
    $("#v-overview").innerHTML = `
      ${pageHead("Personal node console", `${esc(st?.node?.name ?? "Elyra")} <span class="badge tee"><span class="dot"></span>Online</span>`,
        `<span class="endpoint"><code title="OpenAI-compatible endpoint">${esc(url)}</code><button type="button" class="btn sm ghost" data-copy="${esc(url)}" aria-label="Copy endpoint URL">Copy</button></span>`,
        '<button type="button" class="btn primary" data-go="playground">Send a test request</button><button type="button" class="btn" data-go="connect">Connect tools</button>')}
      <div class="body">
        <div class="note"><b>You are managing this node.</b> Sources, routing, usage and payments here belong to its owner, not public wallet users. Your own model needs no escrow deposit; hosted API sources retain their provider bill. <a href="/try/#/market">Open public app →</a></div>
        ${alertsRegion("ov-alerts")}
        <div id="ov-next"></div>
        <details class="card guide" id="ov-guide"><summary><span class="gt"><b id="ov-guide-title">Choose your next job</b> <span class="badge count" id="ov-guide-n"></span><span class="gnext mut" id="ov-guide-next"></span></span><span class="seg" id="ov-role" aria-label="What do you want to do?"><button type="button" data-r="local">Own model</button><button type="button" data-r="buy">Buy from peers</button><button type="button" data-r="sell">Sell capacity</button></span><span class="fold-i">${icon("chev")}</span></summary><div id="ov-steps">${skelRows(3)}</div></details>
        <nav class="quick" aria-label="Quick actions">${QUICK.map(([v, ic, t, d]) => `<button type="button" class="qa" data-go="${v}">${icon(ic)}<span><b>${t}</b><small>${d}</small></span></button>`).join("")}</nav>
        <div class="grid g4" id="ov-stats">${skelStats(4)}</div>
        <div class="grid g21">
          <div class="card"><h3>Usage <span class="row-flex"><span class="seg" id="ov-range" role="group" aria-label="Time range">${RANGES.map(([k, t]) => `<button type="button" data-k="${k}"${k === this.range ? ' class="on"' : ""}>${t}</button>`).join("")}</span><span class="seg" id="ov-seg" role="group" aria-label="Direction"><button type="button" class="on" data-d="out">Consumed</button><button type="button" data-d="in">Served</button></span></span></h3><div id="ov-chart">${skelBlock(150)}</div></div>
          <div class="card"><h3>Health ${helpBtn("Green is working, amber needs attention, red is broken, grey is not in use. Each line says why.")}</h3><div id="ov-health">${skelRows(4)}</div></div>
        </div>
        <div class="grid g21">
          <div class="card"><h3>This node's recent activity <a href="#live" data-go="live">Private Live →</a></h3><div id="ov-activity">${skelRows(4)}</div></div>
          <div class="card"><h3>Active policy <a href="#routing" data-go="routing">Tune →</a></h3><div id="ov-policy">${skelRows(3)}</div></div>
        </div>
      </div>`;
    this.range = "24h"; this.dir = "out"; this.ch = null; this.userFold = false;
    bindNext(() => this.tick());
    const g = $("#ov-guide");
    $("summary", g).addEventListener("click", (e) => { if (!e.target.closest(".seg")) this.userFold = true; });
    g.addEventListener("toggle", () => { if (this.userFold) { this.userFold = false; localStorage.setItem(GUIDE_PREF, g.open ? "1" : "0"); } });
    segment("#ov-role", guard((b) => { S.role = b.dataset.r; localStorage.setItem("elyra-role", S.role); return this.tick(); }));
    segment("#ov-range", (b) => { this.range = b.dataset.k; this.chart(); });
    segment("#ov-seg", (b) => { this.dir = b.dataset.d; this.chart(); });
    await this.tick();
  },
  chart() { drawUsage(S.status, this.routes, this.range, this.dir); },
  async tick() {
    const st = S.status;
    if (!st) return;
    renderAlerts($("#ov-alerts"), alertsFor(st, this.ch, "home")); // cap usage needs no chain call; gas/escrow alerts use the last snapshot until the next one lands
    const ctx = await guideContext();
    this.ch = ctx.ch ?? this.ch; // a slow RPC must not make the gas/escrow alerts flicker away
    this.routes = ctx.routes;
    renderAlerts($("#ov-alerts"), alertsFor(st, this.ch, "home"));
    renderNext(st, ctx.ups);
    setHtml($("#ov-stats"), kpiCards(st, ctx.routes));
    this.chart();
    renderHealth(healthRows(st, { ups: ctx.ups, peers: ctx.peers, ch: this.ch }));
    setHtml($("#ov-policy"), policyCard(st));
    renderActivity(await recentActivity(ctx.routes));
    const { done, total, next } = await renderSteps(ctx);
    const g = $("#ov-guide"), pref = localStorage.getItem(GUIDE_PREF);
    $("#ov-guide-title").textContent = done === total ? "Setup complete" : "Choose your next job";
    $("#ov-guide-n").textContent = done === total ? "✓ all done" : `${done} of ${total}`;
    $("#ov-guide-next").textContent = next ? "Next: " + next : "";
    g.open = pref == null ? done < 2 : pref === "1"; // open for a new node, collapsed once most of it is done, unless the user chose (remembered)
  },
};
