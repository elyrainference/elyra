// Connect view: endpoint snippets, model sources (list / detect local / add / refresh / remove). Keys are sent to the local router only.
import { api, del, post } from "../lib/api.js";
import { IS_REMOTE, toolUrl } from "../lib/config.js";
import { $, esc } from "../lib/dom.js";
import { poll } from "../lib/status.js";
import { S } from "../lib/store.js";
import { empty, pageHead } from "../components/card.js";
import { copy, segment } from "../components/controls.js";
import { field, httpUrl, nonNegative, required, watchField } from "../components/form.js";
import { guard, toast } from "../components/toast.js";
import { backupCard, renderBackup } from "./backup.js";
import { PRESET_UP, SNIP } from "./connect-snippets.js";

const sourceRow = (u) =>
  `<div class="row"><span class="mn top"><span><b>${esc(u.name)}</b> ${u.builtin ? '<span class="badge sim">Built-in</span>' : u.hasKey ? '<span class="badge">Key set</span>' : ""}${u.health?.status === "down" ? ' <span class="badge bad" title="' + esc(u.health.error || "no answer") + '">Offline</span>' : ""}${u.remote ? ' <span class="badge" title="another machine, reached over a tunnel: its operator can read your prompts">Remote</span>' : ""}<span class="sub">${u.builtin ? "stub model for testing the path" : esc(u.baseUrl)} · ${u.models.slice(0, 3).map(esc).join(", ")}${u.models.length > 3 ? " +" + (u.models.length - 3) : ""}</span></span></span>${u.builtin ? "" : `<span class="acts"><button type="button" class="btn sm ghost" data-refup="${esc(u.id)}" aria-label="Refresh models of ${esc(u.name)}" title="Refresh models">↻</button><button type="button" class="btn sm ghost" data-rmup="${esc(u.id)}" aria-label="Remove ${esc(u.name)}" title="Remove">×</button></span>`}</div>`;

const foundRow = (f) =>
  `<div class="row"><span class="mn top"><span><b>${esc(f.name)}</b> found · ${f.models.length} models<span class="sub">${esc(f.baseUrl)}</span></span></span>${f.added ? '<span class="badge ok">Added</span>' : `<button type="button" class="btn sm primary" data-addfound="${esc(f.name)}|${esc(f.baseUrl)}">Add</button>`}</div>`;

export const connect = {
  tab: "curl",
  async enter() {
    $("#v-connect").innerHTML = `
      ${pageHead("Owner · set up", "Sources & tools", "Connect a model to this node, then use its endpoint in your tools. API keys are sent only to this node, never to peer buyers. Local inference needs no escrow deposit; hosted APIs retain their own provider bill.", '<button type="button" class="btn primary" data-click="cn-detect">Detect local</button>')}
      <div class="body"><div id="cn-next"></div><div class="grid g2">
        <div class="card"><h3>Endpoint <span class="seg" id="cn-seg" role="group" aria-label="Client">${Object.keys(SNIP).map((k) => `<button type="button" class="${k === this.tab ? "on" : ""}">${k}</button>`).join("")}</span></h3>
          <div class="row"><span class="k">Base URL</span><span class="v"><code>${esc(toolUrl(S.status?.node?.port))}</code> <button type="button" class="btn sm" data-copy="${esc(toolUrl(S.status?.node?.port))}">Copy</button></span></div>${IS_REMOTE ? '<p class="help" style="margin:8px 0 0">You opened this page through a login, so tools cannot use this site\u2019s address. Use the address above on the computer that runs the node, or open an SSH tunnel to it.</p>' : ""}
          <div class="code" id="cn-code" style="margin-top:12px"></div></div>
        <div class="card"><h3>Your model sources <button type="button" class="btn sm" id="cn-detect">Detect local</button></h3><div id="cn-ups"></div><div id="cn-found"></div></div>
      </div>
      <div class="card"><h3>Add a source</h3>
        <p class="help">Any server that speaks <code>/v1/chat/completions</code>. Own local inference needs no escrow payment. Hosted API sources use your key and published model prices. Adding a source does not publish it for sale: review <a href="#provide" data-go="provide" data-tab="offer">Sell capacity → Models &amp; pricing</a> separately.</p>
        <div class="pills" style="margin-bottom:16px" role="group" aria-label="Presets">${PRESET_UP.map(([n, u, k]) => `<button type="button" class="pill" data-preset="${esc(n)}|${esc(u)}|${esc(k)}">${n}</button>`).join("")}</div>
        <div class="form">
          <div class="fgrid">
            ${field("cn-name", "Name", '<input class="txt" id="cn-name" placeholder="Ollama" autocomplete="off">')}
            ${field("cn-url", "Base URL", '<input class="txt" id="cn-url" placeholder="http://localhost:11434/v1" autocomplete="off" inputmode="url">', "Include the /v1 part.")}
            ${field("cn-key", "API key", '<input class="txt" id="cn-key" type="password" placeholder="Stays on this machine" autocomplete="off">', "", { opt: true })}
            ${field("cn-price", "Your cost", '<div class="inp"><span class="pre">$</span><input class="txt" id="cn-price" type="number" min="0" step="0.01" value="0"><span class="pre">per million tokens</span></div>', "Used to rank this source against peers. 0 for local models.")}
          </div>
          <label class="check"><input type="checkbox" id="cn-remote"><span>Another machine, reached over an SSH tunnel or VPN (not this computer). Its operator can read prompts, so it is never shown as private.</span></label>
          ${field("cn-models", "Models", '<input class="txt" id="cn-models" placeholder="llama3.2, qwen3:8b">', "Comma-separated. Leave blank to discover them from /models.", { opt: true })}
        </div>
        <div class="savebar"><span class="sbt">Keys are sent to your local router only.</span><button type="button" class="btn primary" id="cn-add">Add source</button></div>
      </div>
      ${backupCard()}</div>`;
    const checks = [watchField($("#cn-name"), required), watchField($("#cn-url"), httpUrl), watchField($("#cn-price"), nonNegative)];
    const code = () => {
      $("#cn-code").innerHTML = SNIP[this.tab]() + `<button type="button" class="btn sm cp" id="cn-cp">Copy</button>`;
      $("#cn-cp").onclick = () => copy($("#cn-code").textContent.replace(/Copy$/, "").trim());
    };
    segment("#cn-seg", (b) => { this.tab = b.textContent; code(); });
    code();
    $("#v-connect").onclick = guard((e) => this.onAction(e));
    $("#cn-add").onclick = guard(async () => {
      if (checks.map((c) => c()).includes(false)) { toast("Fix the highlighted fields first", "err"); return; }
      const models = $("#cn-models").value.split(",").map((s) => s.trim()).filter(Boolean);
      const u = await post("/api/upstreams", { name: $("#cn-name").value.trim(), baseUrl: $("#cn-url").value.trim(), apiKey: $("#cn-key").value, price: +$("#cn-price").value, models, remote: $("#cn-remote").checked });
      toast(`Added ${u.name}: ${u.models.length} models`, "ok");
      await this.list();
      this.connected(u.name, u.models);
      poll();
    });
    $("#cn-detect").onclick = guard(async () => {
      const { found } = await api("/api/upstreams/detect");
      $("#cn-found").innerHTML = found.length
        ? `<div class="sep"></div>` + found.map(foundRow).join("")
        : empty("Nothing found", "Checked Ollama (11434), LM Studio (1234), 8000 and 8080 on this machine. Start your model server (for Ollama: <code>ollama serve</code>), then detect again, or add a source below.", "", "search");
    });
    await this.list();
    renderBackup().catch(() => {}); // fills the backup card; the chain RPC may be slow, so it never holds the page up
    if (S.pre.detect) { S.pre = {}; $("#cn-detect").click(); }
  },
  // buttons rendered inside this view (source list, found list, presets)
  async onAction(e) {
    const t = e.target.closest("[data-rmup],[data-refup],[data-preset],[data-addfound]");
    if (!t) return;
    const d = t.dataset;
    if (d.rmup) { await del("/api/upstreams/" + d.rmup); await this.list(); return poll(); }
    if (d.refup) { const u = await post(`/api/upstreams/${d.refup}/refresh`); toast(`${u.name}: ${u.models.length} models`, "ok"); return this.list(); }
    if (d.preset) { const [n, u] = d.preset.split("|"); $("#cn-name").value = n; $("#cn-url").value = u; return; }
    if (d.addfound) { const [n, u] = d.addfound.split("|"); const up = await post("/api/upstreams", { name: n, baseUrl: u }); toast("Added " + n, "ok"); await this.list(); this.connected(up.name, up.models); $("#cn-detect").click(); return poll(); }
  },
  // after a source is added: say it worked and offer the next action
  connected(name, models) {
    $("#cn-next").innerHTML = `<div class="card next ok"><div class="tx"><small>Connected</small><b>${esc(name)} is ready</b><p>${esc(String(models.length))} model${models.length === 1 ? "" : "s"}: ${models.slice(0, 4).map(esc).join(", ")}${models.length > 4 ? ", …" : ""}. Requests to <code>auto</code> now go to your live sources first.</p></div><div class="act"><button type="button" class="btn sm primary" data-go="playground">Open playground</button></div></div>`;
  },
  async list() {
    const { upstreams } = await api("/api/upstreams");
    $("#cn-ups").innerHTML = upstreams.map(sourceRow).join("");
  },
};
