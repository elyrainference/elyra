// Playground: chat through the local /v1 endpoint (streamed) next to a live route preview. Prompts stay in this page's memory only.
import { api, post } from "../lib/api.js";
import { ENDPOINT } from "../lib/config.js";
import { $, esc } from "../lib/dom.js";
import { fmt, price, usd } from "../lib/format.js";
import { S } from "../lib/store.js";
import { badge } from "../components/badge.js";
import { empty, pageHead } from "../components/card.js";
import { rankItem } from "../components/ranking.js";
import { guard } from "../components/toast.js";

// Streams /v1/chat/completions. onRoute() fires once the routing headers arrive; onChunk(text) after each network chunk with the text it added.
// Resolves to the x-elyra-* routing headers.
async function streamChat(model, messages, { onRoute, onChunk }) {
  const r = await fetch(ENDPOINT + "/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, stream: true, messages }) });
  if (!r.ok) throw new Error((await r.json()).error?.message ?? r.statusText);
  const route = { peer: r.headers.get("x-elyra-route"), model: r.headers.get("x-elyra-model"), price: r.headers.get("x-elyra-price"), tee: r.headers.get("x-elyra-tee"), sim: r.headers.get("x-elyra-simulated") === "true" };
  onRoute();
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    let added = "";
    for (const ln of lines) {
      if (!ln.startsWith("data:") || ln.includes("[DONE]")) continue;
      try { added += JSON.parse(ln.slice(5)).choices?.[0]?.delta?.content ?? ""; } catch { /* partial */ }
    }
    onChunk(added);
  }
  return route;
}

// the "which peer served this" footer under an answer. Route values are response headers, so they are escaped.
// head (always visible): SIMULATED/LIVE + privacy label + peer; body (collapsible): model, price, tokens, cost, latency.
const teeBadge = (t) => (t === "none" ? badge("CLEAR") : badge("TEE · " + esc(t.toUpperCase()), t === "verified" ? "tee" : t === "claimed" ? "warn" : "sim"));
const routeMeta = (route, last) => ({
  head: badge(route.sim ? "SIMULATED PEER" : "LIVE", route.sim ? "sim" : "live") + teeBadge(route.tee) + `<span>Routed to <b>${esc(String(route.peer).replace(/^(self|peer|sim):/i, ""))}</b></span>`,
  body: badge(esc(route.model), "count") + badge(`${price(+route.price)}/MTok`, "count") +
    (last ? badge(`${fmt(last.p + last.c)} tok · ${last.amount ? usd(last.amount) : "free"} · ${Number(last.ms) >= 1000 ? (Number(last.ms) / 1000).toFixed(1) + " s" : esc(last.ms) + " ms"}`, "count") : ""),
});

export const playground = {
  hist: [],
  async enter() {
    const models = (await (await fetch(ENDPOINT + "/models")).json()).data;
    const liveIds = new Set((await api("/api/models")).models.filter((m) => !m.simulated).map((m) => m.model)); // own sources + real peers
    this.live = [...liveIds];
    const auto = models.filter((m) => m.id.startsWith("auto")), mine = models.filter((m) => liveIds.has(m.id)), rest = models.filter((m) => !m.id.startsWith("auto") && !liveIds.has(m.id));
    $("#v-playground").innerHTML = `
      ${pageHead("Use AI", "Playground", "Send a prompt through your own router. See which peer won, what it cost, and why the others lost.")}
      <div class="body fill"><div class="pg">
        <div class="card chat">
          <div class="chat-head"><span class="ttl">Conversation</span>
            <span class="row-flex"><label class="mut" for="pg-model">Model</label><select class="txt sm auto" id="pg-model">
              <optgroup label="Policy routing">${auto.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join("")}</optgroup>
              ${mine.length ? `<optgroup label="Your models (live)">${mine.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join("")}</optgroup>` : ""}
              <optgroup label="${mine.length ? "Simulated market" : "Specific model"}">${rest.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join("")}</optgroup></select></span></div>
          <div class="msgs" id="pg-msgs" aria-live="polite"></div>
          <div class="composer"><textarea class="txt" id="pg-in" rows="1" aria-label="Your message" placeholder="Ask anything…"></textarea><button type="button" class="btn primary" id="pg-send">Send</button></div>
          <div class="cn">Enter sends, Shift+Enter adds a line. Prompts stay in this page's memory only.</div>
        </div>
        <div class="card pg-side"><h3>Route preview <span class="badge count" id="pg-total"></span></h3><div class="rank" id="pg-rank"></div></div>
      </div></div>`;
    const sel = $("#pg-model");
    if (S.pre.model) sel.value = S.pre.model;
    sel.onchange = () => this.preview();
    $("#pg-send").onclick = guard(() => this.send());
    const ta = $("#pg-in");
    ta.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#pg-send").click(); } };
    ta.oninput = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 160) + "px"; };
    const msgs = $("#pg-msgs");
    msgs.addEventListener("toggle", (e) => { const m = this.hist[+e.target.dataset.i]; if (m) m.open = e.target.open; }, true); // remember which route footers are open across redraws
    msgs.onclick = (e) => { const b = e.target.closest("[data-suggest]"); if (b) { ta.value = b.dataset.suggest; $("#pg-send").click(); } };
    this.draw();
    await this.preview();
  },
  draw() {
    const prompts = ["Explain how this router picks a peer", "Write a haiku about routing packets", "What is a TEE, in two sentences?"];
    $("#pg-msgs").innerHTML = this.hist.length
      ? this.hist.map((m, i) => `<div class="msg ${m.role === "user" ? "u" : ""}"><span class="t">${esc(m.content)}</span>${m.meta ? `<details class="route" data-i="${i}" ${m.open ? "open" : ""}><summary>${m.meta.head}</summary><div class="meta">${m.meta.body}</div></details>` : ""}</div>`).join("")
      : empty("Start a conversation", this.live?.length
        ? `Answered by your live model${this.live.length > 1 ? "s" : ""}: ${this.live.slice(0, 3).map(esc).join(", ")}.`
        : (S.status?.network?.blocked?.length ?? 0) > 0
          ? `${S.status.network.blocked.length} connected seller${S.status.network.blocked.length === 1 ? " uses" : "s use"} a different settlement escrow, so their live models are hidden. <a href="#overview" data-go="overview">Match settlement on Overview</a> or <a href="#connect" data-go="connect" data-detect="1">connect a local model</a>.`
          : `Nothing real is connected yet, so the answer will be canned text from a simulated peer. <a href="#connect" data-go="connect" data-detect="1">Connect a real model</a> to change that.`,
        `<div class="pills" style="justify-content:center;margin-top:10px">${prompts.map((p) => `<button type="button" class="pill" data-suggest="${esc(p)}">${esc(p)}</button>`).join("")}</div>`, "playground");
    const el = $("#pg-msgs");
    el.scrollTop = el.scrollHeight;
  },
  async preview() {
    const { options, total } = await post("/api/route/preview", { model: $("#pg-model").value });
    $("#pg-total").textContent = total + " options";
    $("#pg-rank").innerHTML = options.length
      ? options.map((c, i) => rankItem(c, i, `${price(c.price)}/MTok · ${esc(c.tps)} t/s · ★ ${esc(c.reputation)} · ${c.tee === "none" && c.kind !== "self" ? "clear" : c.kind === "self" ? "local" : "tee"} ${c.simulated ? "· simulated" : ""}`)).join("")
      : (S.status?.network?.blocked?.length ?? 0) > 0
        ? empty("No route (settlement mismatch)", `${S.status.network.blocked.length} online seller${S.status.network.blocked.length === 1 ? " settles" : "s settle"} on another escrow. <a href="#overview" data-go="overview">Match settlement on Overview</a> to route to them.`)
        : empty("No route", "Nothing satisfies the policy for this model. Connect a model source, or loosen TEE or max price under Routing.", '<button type="button" class="btn sm" data-go="connect">Connect a model</button><button type="button" class="btn sm" data-go="routing">Open routing</button>', "routing");
  },
  async send() {
    const ta = $("#pg-in"), text = ta.value.trim();
    if (!text) return;
    ta.value = "";
    ta.style.height = "";
    const model = $("#pg-model").value;
    this.hist.push({ role: "user", content: text });
    const reply = { role: "assistant", content: "…" };
    this.hist.push(reply);
    this.draw();
    $("#pg-send").disabled = true;
    // while nothing has arrived yet: show elapsed time, and after 6 s say why it can be slow (a cold model load is normal)
    const t0 = Date.now();
    let waiting = true;
    const timer = setInterval(() => {
      if (!waiting) return;
      const s = Math.round((Date.now() - t0) / 1000);
      reply.content = s < 6 ? "…" : `… ${s}s. Still working: the first request after a model has been idle can take a minute while it loads into memory.`;
      this.draw();
    }, 1000);
    try {
      const messages = this.hist.slice(0, -1).map(({ role, content }) => ({ role, content }));
      const route = await streamChat(model, messages, { onRoute: () => { waiting = false; reply.content = ""; }, onChunk: (t) => { waiting = false; reply.content += t; this.draw(); } });
      const last = (await api("/api/routes")).routes[0];
      reply.meta = routeMeta(route, last);
    } catch (e) { reply.content = "⚠ " + e.message; }
    waiting = false;
    clearInterval(timer);
    $("#pg-send").disabled = false;
    this.draw();
    await this.preview();
  },
};
