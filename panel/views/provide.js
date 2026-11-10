// Provide view: earnings card (provide-earnings.js) + the offer form (source, models, price, credit limit, privacy claim) and what peers see.
// The form is rendered once per enter(); tick() only refreshes earnings so typing is never clobbered by polls.
import { api, put } from "../lib/api.js";
import { $, esc } from "../lib/dom.js";
import { fmt, price, usd } from "../lib/format.js";
import { S } from "../lib/store.js";
import { poll } from "../lib/status.js";
import { empty, pageHead, skelBlock, skelRows, statCard } from "../components/card.js";
import { switchRow, toggleSwitch } from "../components/controls.js";
import { initTabs, pickTab, tabBar } from "../components/tabs.js";
import { TABS } from "../lib/nav.js";
import { field, nonNegative, positive, watchField } from "../components/form.js";
import { helpBtn } from "../components/pop.js";
import { table } from "../components/table.js";
import { guard, toast } from "../components/toast.js";
import { guideContext, renderGuide, stepsFor } from "./onboarding.js";
import { renderEarnings } from "./provide-earnings.js";

function teeNote(tee) {
  if (tee?.mode) {
    return tee.active
      ? "<b>Attested.</b> This node runs inside Confidential Space and publishes a Google-signed attestation bound to its keys; buyers who pinned your image digest see <b>TEE · VERIFIED</b>."
      : "<b>TEE mode but no valid attestation right now.</b> Check the node log; until it recovers you are advertised as clear.";
  }
  return "A claim alone is no longer enough: buyers only treat you as private when a Google-signed attestation for your container image passes <i>their</i> trust list, and TEE-only routing ignores unattested claims. To earn <b>TEE · VERIFIED</b>, run the official Elyra image in Confidential Space (deploy/tee/README.md).";
}

const offeredRow = (m) => `<tr><td>${esc(m.id)}</td><td class="r">${price(m.price)}</td><td>${m.tee === "none" ? '<span class="badge">CLEAR</span>' : '<span class="badge warn">TEE · CLAIMED</span>'}</td></tr>`;

function activeSources(p, upstreams, up) {
  if (p.upstreamId === "*" && !(p.upstreamIds?.length > 0)) return upstreams.filter((u) => !u.builtin && !u.hosted && u.health?.status !== "down");
  if (Array.isArray(p.upstreamIds) && p.upstreamIds.length > 0) return upstreams.filter((u) => p.upstreamIds.includes(u.id));
  return up ? [up] : [];
}

function offerCard(p, upstreams, up, st) {
  const sel = (v) => (p.tee === v ? "selected" : "");
  const isAll = p.upstreamId === "*" && !(p.upstreamIds?.length > 0);
  const models = [...new Set(activeSources(p, upstreams, up).flatMap((u) => u.models ?? []))];
  const perModel = models.filter((m) => !p.models.length || p.models.includes(m));
  return `<div class="card"><h3>Models &amp; pricing</h3>
    <div class="form">
      ${switchRow("pv-on", p.enabled, "Provide to the network", "Peers that know this node can send it requests. Every answer is signed with this node's key.")}
      ${field("pv-up", "Model source", `<select class="txt" id="pv-up"><option value="*" ${isAll ? "selected" : ""}>All healthy local sources</option>${upstreams.map((u) => `<option value="${esc(u.id)}" ${!isAll && u.id === p.upstreamId ? "selected" : ""}>${esc(u.name)} · ${u.models.length} model${u.models.length === 1 ? "" : "s"}${u.health?.status === "down" ? " (offline)" : ""}</option>`).join("")}</select>`, 'Where answers come from. <a href="#connect" data-go="connect">Connect a source</a> first. Choosing a source saves that selection immediately; review the remaining offer fields, then Save offer.')}
      <div class="field"><span class="lab" id="pv-models-l">Models to offer <span class="opt">(none selected = all)</span></span>
        <div class="pills" id="pv-models" role="group" aria-labelledby="pv-models-l">${models.map((m) => `<button type="button" class="pill ${p.models.includes(m) ? "on" : ""}" aria-pressed="${p.models.includes(m)}" data-m="${esc(m)}">${esc(m)}</button>`).join("") || '<span class="hint">This source has no models yet.</span>'}</div></div>
      ${field("pv-price", "Default price " + helpBtn("Dollars per million tokens (MTok). About 750,000 words. Buyers see this number next to your models and the router compares it with every other seller."), `<div class="inp"><span class="pre">$</span><input class="txt" id="pv-price" type="number" min="0" step="0.01" value="${esc(p.price)}" /><span class="pre">per million tokens</span></div>`, "Charged for every model that has no price of its own.")}
      <div class="field"><span class="lab" id="pv-prices-l">Price per model <span class="opt">(empty = default price)</span></span>
        <div id="pv-prices" style="display:grid;gap:8px" role="group" aria-labelledby="pv-prices-l">${perModel.map((m) => `<div class="inp"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(m)}">${esc(m)}</span><input class="txt sm" style="width:120px" type="number" min="0" step="0.01" data-pm="${esc(m)}" aria-label="Price for ${esc(m)}" placeholder="${esc(p.price)}" value="${p.prices?.[m] != null ? esc(p.prices[m]) : ""}" /></div>`).join("") || '<span class="hint">Pick a model source first.</span>'}</div></div>
      ${field("pv-credit", "Credit limit " + helpBtn("Your risk limit: how much a buyer may use before they must send a signed payment voucher. Lower is safer, higher is friendlier to new buyers."), `<div class="inp"><span class="pre">$</span><input class="txt" id="pv-credit" type="number" min="0" step="0.01" value="${esc(p.creditUsd)}" /></div>`, "How much a buyer may be served before a payment voucher is required.")}
      ${field("pv-depcap", "Per-wallet deposit cap " + helpBtn("The most one buyer wallet may hold in the escrow while this node serves it. On mainnet the stricter of this and the node-wide mainnet cap applies, because the contracts are unaudited."), `<div class="inp"><span class="pre">$</span><input class="txt" id="pv-depcap" type="number" min="0.01" max="10000" step="1" value="${esc(p.maxDepositUsd ?? 20)}" /></div>`, "Most a buyer wallet may hold in escrow while it is served by this node. Deposits above it are refused.")}
      ${field("pv-tee", "Privacy claim " + helpBtn("What you tell buyers. A claim alone is not trusted: only a Google-signed attestation that a buyer pinned shows up as TEE · VERIFIED."), `<select class="txt" id="pv-tee"><option value="none" ${sel("none")}>None: prompts are visible to this machine</option><option value="claimed" ${sel("claimed")}>TEE: running inside a trusted enclave (self-declared)</option></select>`)}
    </div>
    <div class="note">${teeNote(st.tee)}</div>
    <div class="savebar"><span class="sbt" id="pv-msg" role="status">Changes apply when you save.</span><button type="button" class="btn primary" id="pv-save">Save</button></div>
  </div>`;
}

const peersSeeCard = (p, st) => {
  const rl = st?.node?.relay;
  const reachNote = rl
    ? rl.connected
      ? `Reachable through relay <code>${esc(rl.relay)}</code>: no port forwarding or public IP needed.`
      : `Relay <code>${esc(rl.relay)}</code> is reconnecting (${esc(rl.error || "waiting")}).`
    : `Behind a home router? Start with <code>--relay https://app.elyrainference.com --seed https://app.elyrainference.com</code> (no port forwarding), or <code>--host 0.0.0.0 --public-url http://YOUR-IP:8545</code>. The control API and OpenAI endpoint stay loopback-only.`;
  return `<div class="card"><h3>Published offer &amp; reachability</h3>
  <div class="row"><span class="k">Peer URL</span><span class="v"><span class="mono">${esc(p.publicUrl)}</span> <button type="button" class="btn sm" data-copy="${esc(p.publicUrl)}">Copy</button></span></div>
  ${rl ? `<div class="row"><span class="k">Relay</span><span class="v">${rl.connected ? '<span class="up">Connected</span> · ' + esc(rl.relay) : '<span class="down">Reconnecting</span> · ' + esc(rl.error || rl.relay)}</span></div>` : ""}
  <div class="row"><span class="k">Concurrency limit</span><span class="v">${esc(p.maxConcurrent)}</span></div>
  <div class="row"><span class="k">Per-wallet deposit cap</span><span class="v">$${esc(p.maxDepositUsd ?? 20)}</span></div>
  <div class="sep"></div>
  ${p.offered.length ? `<div class="tablewrap">${table(["Model", ["$ / MTok", "r"], "Privacy"], p.offered.map(offeredRow))}</div>` : empty("No published offers", "Connect a real source, select models, enable selling and save. Reachability and settlement must also be ready for paid buyers.", '<button type="button" class="btn sm" data-go="connect">Connect source</button>', "provide")}
  <div class="note">${reachNote}</div>
</div>`;
};

export const provide = {
  p: null,
  tick() { return renderEarnings(this); },
  async enter() {
    const [p, { upstreams }] = await Promise.all([api("/api/provide"), api("/api/upstreams")]);
    const up = upstreams.find((u) => u.id === p.upstreamId) ?? upstreams[0];
    const x = S.status.stats;
    const tab = pickTab("provide", TABS.provide);
    $("#v-provide").innerHTML = `
      ${pageHead("Owner · earn &amp; pay", "Sell capacity", "Connect a source → choose models and USDG prices → check reachability → track earnings. These controls manage this node, not a public wallet account. Your own model needs no buyer escrow deposit.", '<button type="button" class="btn primary" data-click="pv-save">Save offer</button>')}
      <div class="body">${tabBar(TABS.provide, tab)}
        <div class="card" id="pv-guide" data-pane="golive"><h3>Reachability &amp; go-live checklist <span class="sub" id="pv-guide-n"></span></h3><div id="pv-steps">${skelRows(3)}</div><div class="savebar"><button type="button" class="btn sm" data-go="network" data-tab="peers">Inspect peers</button><button type="button" class="btn sm" data-go="provide" data-tab="earnings">View earnings</button></div></div>
        <div class="card" id="pv-earn" data-pane="earnings">${skelBlock(160)}</div>
        <div class="grid g4" data-pane="earnings golive">
          ${statCard(p.enabled ? "On" : "Off", "Provider status")}${statCard(fmt(x.served24h), "Served · 24h")}${statCard(usd(x.earned24h), "Earned · 24h", undefined, true)}${statCard(p.offered.length, "Models offered")}
        </div>
        <div class="grid g2" data-pane="offer">
          ${offerCard(p, upstreams, up, S.status)}
          ${peersSeeCard(p, S.status)}
        </div></div>`;
    initTabs($("#v-provide"), "provide", tab);
    const chosen = new Set(p.models);
    $("#pv-on").onclick = () => toggleSwitch($("#pv-on"));
    const checks = [watchField($("#pv-price"), nonNegative), watchField($("#pv-credit"), nonNegative), watchField($("#pv-depcap"), positive), ...[...document.querySelectorAll("#pv-prices [data-pm]")].map((i) => { i.id = "pm-" + i.dataset.pm.replace(/\W/g, "_"); return watchField(i, nonNegative); })];
    $("#pv-models").onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const m = b.dataset.m;
      chosen.has(m) ? chosen.delete(m) : chosen.add(m);
      b.classList.toggle("on", chosen.has(m));
      b.setAttribute("aria-pressed", String(chosen.has(m)));
    };
    $("#pv-up").onchange = guard(async () => { await put("/api/provide", { upstreamId: $("#pv-up").value }); await this.enter(); });
    $("#pv-save").onclick = guard(async () => {
      if (checks.map((c) => c()).includes(false)) { toast("Fix the highlighted fields first", "err"); return; }
      await put("/api/provide", { enabled: $("#pv-on").classList.contains("on"), upstreamId: $("#pv-up").value, models: [...chosen], price: $("#pv-price").value, prices: Object.fromEntries([...document.querySelectorAll("#pv-prices [data-pm]")].filter((i) => i.value !== "").map((i) => [i.dataset.pm, i.value])), tee: $("#pv-tee").value, creditUsd: $("#pv-credit").value, maxDepositUsd: $("#pv-depcap").value });
      toast("Provider settings saved", "ok");
      await poll();
      await this.enter();
    });
    this.p = p;
    await renderEarnings(this);
    const { done, total } = renderGuide($("#pv-steps"), stepsFor("sell", await guideContext()));
    $("#pv-guide-n").textContent = done === total ? "· Live" : `· ${done}/${total}`;
  },
};
