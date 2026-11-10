// Routing rules: four weights, TEE-only switch and max price (auto-saved, debounced) beside a live route preview.
import { api, post, put } from "../lib/api.js";
import { poll } from "../lib/status.js";
import { $, esc } from "../lib/dom.js";
import { price } from "../lib/format.js";
import { empty, pageHead } from "../components/card.js";
import { helpBtn } from "../components/pop.js";
import { switchRow, toggleSwitch } from "../components/controls.js";
import { field, nonNegative, watchField } from "../components/form.js";
import { rankItem } from "../components/ranking.js";
import { guard } from "../components/toast.js";

// [price, speed, reputation, privacy, teeOnly]
const PRESETS = { Balanced: [40, 30, 20, 10, false], Cheapest: [100, 0, 0, 0, false], Fastest: [0, 100, 0, 0, false], Private: [10, 10, 20, 60, true], "Top rated": [5, 15, 80, 0, false] };
const NAMES = [["price", "Price", "cheaper wins"], ["speed", "Speed", "tokens per second"], ["reputation", "Reputation", "completed requests, failures"], ["privacy", "Privacy", "local or TEE-backed peers"]];

export const routing = {
  async enter() {
    const pol = await api("/api/policy");
    const w = pol.weights;
    $("#v-routing").innerHTML = `
      ${pageHead("Use AI", "Routing rules", "Four weights decide every request sent to <code>auto</code>. Name a specific model and the router picks the best peer for just that model.", '<button type="button" class="btn primary" data-go="playground">Test in the playground</button>')}
      <div class="body"><div class="grid g2">
        <div class="card"><h3>Objective ${helpBtn("The four weights decide which seller wins a request sent to auto. Raise price to favour the cheapest, speed for the fastest, reputation for proven sellers, privacy for local or verified-TEE sellers.")}</h3>
          <p class="help">Start from a preset, then fine-tune. Weights are relative: only their proportions matter.</p>
          <div class="pills" id="r-pre" style="margin-bottom:20px" role="group" aria-label="Presets">${Object.keys(PRESETS).map((p) => `<button type="button" class="pill">${p}</button>`).join("")}</div>
          ${NAMES.map(([k, n, d]) => `<div class="sl"><label for="rw-${k}"><span>${n} <span class="mut">· ${d}</span></span><b id="rv-${k}">0%</b></label><input type="range" min="0" max="100" id="rw-${k}" value="${w[k]}"></div>`).join("")}
          <div class="sep"></div>
          ${switchRow("r-tee", pol.teeOnly, "Require private peers", "Only route to your own machine or TEE-backed peers. Requests with no private route fail instead of leaking.")}
          <div style="margin-top:12px">${field("r-max", "Max price", `<div class="inp"><span class="pre">$</span><input class="txt" id="r-max" type="number" min="0" step="0.01" placeholder="No limit" value="${esc(pol.maxPrice ?? "")}" /><span class="pre">per million tokens</span></div>`, "Leave blank for no limit. Peers above this price are never chosen.")}</div>
          <div class="savebar"><span class="sbt" id="r-saved" role="status">Changes save automatically.</span></div>
        </div>
        <div class="card"><h3>Live preview <select class="txt sm auto" id="r-model" aria-label="Preview model"><option>auto</option><option>auto:cheapest</option><option>auto:fastest</option><option>auto:best</option><option>auto:private</option></select></h3>
          <div class="rank" id="r-rank"></div>
          <div class="note"><b>Shorthands.</b> <code>auto:cheapest</code>, <code>auto:fastest</code>, <code>auto:best</code>, <code>auto:private</code> override these weights for one request. Use them as the model name in any tool.</div>
        </div>
      </div></div>`;
    const checkMax = watchField($("#r-max"), nonNegative);
    let timer;
    const upd = (saveIt) => {
      const vals = Object.fromEntries(NAMES.map(([k]) => [k, +$("#rw-" + k).value]));
      const tot = Object.values(vals).reduce((a, b) => a + b, 0) || 1;
      for (const [k] of NAMES) {
        const el = $("#rw-" + k);
        el.style.setProperty("--v", el.value + "%");
        $("#rv-" + k).textContent = Math.round((vals[k] / tot) * 100) + "%";
      }
      if (!saveIt || !checkMax()) return;
      clearTimeout(timer);
      timer = setTimeout(guard(async () => {
        await put("/api/policy", { weights: vals, teeOnly: $("#r-tee").classList.contains("on"), maxPrice: $("#r-max").value });
        const sv = $("#r-saved");
        sv.textContent = "Saved"; sv.classList.add("ok");
        setTimeout(() => { sv.textContent = "Changes save automatically."; sv.classList.remove("ok"); }, 1500);
        await this.preview();
        poll();
      }), 350);
    };
    NAMES.forEach(([k]) => ($("#rw-" + k).oninput = () => upd(true)));
    $("#r-tee").onclick = () => { toggleSwitch($("#r-tee")); upd(true); };
    $("#r-max").oninput = () => upd(true);
    $("#r-model").onchange = () => this.preview();
    $("#r-pre").onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const p = PRESETS[b.textContent];
      NAMES.forEach(([k], i) => ($("#rw-" + k).value = p[i]));
      toggleSwitch($("#r-tee"), p[4]);
      upd(true);
    };
    upd(false);
    await this.preview();
  },
  async preview() {
    const { options, total } = await post("/api/route/preview", { model: $("#r-model").value });
    $("#r-rank").innerHTML = options.length
      ? `<div class="help" style="margin:0 0 4px">Top ${options.length} of ${total} candidates</div>` + options.map((c, i) =>
        rankItem(c, i, `${c.price ? price(c.price) : "free"}/MTok · ${esc(c.tps)} t/s · ★ ${esc(c.reputation)} · ${c.kind === "self" ? (c.hosted ? "hosted" : c.remote ? "remote" : "local") : c.tee === "none" ? "clear" : "tee"}${c.simulated ? " · simulated" : ""}`)).join("")
      : empty("No route", "Policy leaves no candidates. Loosen the private-only switch or raise the max price.", "", "routing");
  },
};
