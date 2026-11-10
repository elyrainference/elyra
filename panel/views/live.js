// Live view: the owner's private realtime feed (GET /api/events, Server-Sent Events) next to a presence card (peers, who serves you,
// who buys from you). Shell and filters are drawn once per visit; each event is ONE new row prepended to the list (never a re-render),
// the DOM keeps the newest MAX_ROWS rows, and filters only flip an attribute that CSS reads. Every event field passes through esc().
// The stream is opened in enter() and closed in leave() (router hook): an open feed holds one of the node's few stream slots.
import { api } from "../lib/api.js";
import { API } from "../lib/config.js";
import { $, esc, setHtml } from "../lib/dom.js";
import { S } from "../lib/store.js";
import { empty, pageHead } from "../components/card.js";
import { segment } from "../components/controls.js";
import { group, ms, num, row } from "./live-row.js";

const MAX_ROWS = 200;          // rows kept in the DOM (and events kept in memory)
const WINDOW_MS = 5 * 60_000;  // "active" for the presence card
const BACKOFF_START = 1000, BACKOFF_MAX = 30_000;
const FILTERS = [["all", "All"], ["buy", "Buying"], ["sell", "Selling"], ["peer", "Peers"], ["money", "Money"], ["alert", "Alerts"]];

const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? Math.floor(s) + "s ago" : Math.floor(s / 60) + "m ago"; };

const peerLi = (p) => `<div class="lv-li"><i class="lv-dot ${p.online ? "on" : "off"}"></i><span class="nm" title="${esc(p.name)}">${esc(p.name)}</span><span class="r">${p.online ? (num(p.rtt) ? esc(ms(p.rtt)) : "online") : "offline"}</span></div>`;
const none = (text) => `<p class="lv-none">${text}</p>`;

export const live = {
  f: "all", paused: false, held: [], log: [], peers: [], lastId: 0, n: {}, es: null, retryT: 0, retryAt: 0, backoff: BACKOFF_START, conn: "connecting", clock: 0, loadErr: "",

  async enter() {
    this.leave();
    Object.assign(this, { f: "all", paused: false, held: [], log: [], n: { all: 0 }, lastId: 0, backoff: BACKOFF_START, conn: "connecting", loadErr: "" });
    $("#v-live").innerHTML = `
      ${pageHead("This node · owner only", "Private Live", "This node's private activity: requests you send or serve, known peers and payments. Not a global buyer feed. Only the owner can open it; metadata only, never prompts, answers or keys.",
        `<span class="chip lv-chip" id="lv-conn" role="status"></span><button type="button" class="btn sm" id="lv-pause" aria-pressed="false">Pause</button>`)}
      <div class="body">
        <div class="lv-grid">
          <aside class="lv-side" aria-label="Presence">
            <div class="card">
              <h3>Presence</h3>
              <section class="lv-sec"><h4>Peers <span class="badge count" id="lv-pn"></span></h4><div id="lv-peers"></div></section>
              <section class="lv-sec"><h4>Serving you <span class="mut">last 5 min</span></h4><div id="lv-serving"></div></section>
              <section class="lv-sec"><h4>Buying from you <span class="badge count" id="lv-sell"></span></h4><div id="lv-buyers"></div></section>
            </div>
          </aside>
          <div class="card lv-feed">
            <div class="lv-bar">
              <div class="pills" id="lv-filters" role="group" aria-label="Filter events">${FILTERS.map(([k, t]) => `<button type="button" class="pill${k === "all" ? " on" : ""}" data-k="${k}">${t}</button>`).join("")}</div>
              <span class="mut lv-cap">Newest first · last ${MAX_ROWS} kept in memory on the node</span>
            </div>
            <div class="lv-empty" id="lv-empty">${empty("Nothing yet", "Send a request in the Playground and it shows up here.", '<button type="button" class="btn sm primary" data-go="playground">Open the Playground</button>')}</div>
            <ol class="lv-list" id="lv-list" data-f="all" role="log" aria-label="Live activity" aria-live="off"></ol>
          </div>
        </div>
      </div>`;
    segment("#lv-filters", (b) => this.filter(b.dataset.k));
    $("#lv-pause").onclick = () => this.pause(!this.paused);
    this.chip();
    this.clock = setInterval(() => this.beat(), 1000);
    try {
      const [rec, peers] = await Promise.all([api("/api/events/recent"), api("/api/peers").catch(() => ({ peers: [] }))]);
      if (S.view !== "live") return;
      this.peers = peers.peers ?? [];
      for (const ev of rec.events) this.add(ev);
      this.lastId = rec.lastId ?? this.lastId;
    } catch (e) { this.loadErr = e.message; }
    if (S.view === "live") { this.empty(); this.connect(); this.beat(); }
  },

  /** router hook: leaving the view closes the stream and every timer */
  leave() {
    this.close();
    clearInterval(this.clock); this.clock = 0;
    this.held = [];
  },

  close() {
    clearTimeout(this.retryT); this.retryT = 0;
    if (this.es) { this.es.onopen = this.es.onmessage = this.es.onerror = null; this.es.close(); this.es = null; }
  },

  connect() {
    this.close();
    this.setConn("connecting");
    const es = new EventSource(`${API}/api/events?since=${this.lastId}`); // since = resume point: EventSource cannot set Last-Event-ID on a fresh connection
    this.es = es;
    es.onopen = () => { this.backoff = BACKOFF_START; this.setConn("live"); };
    es.onmessage = (m) => { try { this.add(JSON.parse(m.data)); } catch { /* a malformed frame is skipped, never fatal */ } };
    es.onerror = () => { // our own backoff for every failure kind (network drop, 401 after the session ended, 429, node restart)
      if (this.es !== es) return;
      this.close();
      const wait = this.backoff; this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX);
      this.retryAt = Date.now() + wait;
      this.retryT = setTimeout(() => { if (S.view === "live") this.connect(); }, wait);
      this.setConn("backoff");
    };
  },

  setConn(c) { this.conn = c; this.chip(); },
  chip() {
    const el = $("#lv-conn"); if (!el) return;
    const c = this.conn, secs = Math.max(1, Math.ceil((this.retryAt - Date.now()) / 1000));
    setHtml(el, c === "live" ? '<span class="dot"></span><span>Live</span>' : c === "backoff" ? `<span class="dot warn"></span><span>Reconnecting in ${secs}s…</span>` : '<span class="dot warn"></span><span>Connecting…</span>');
  },

  /** one event in: remembered for the presence card, painted as one new row (or held while paused) */
  add(e) {
    if (!e || typeof e.id !== "number" || !e.kind) return;
    this.lastId = e.id;
    this.log.push(e); if (this.log.length > MAX_ROWS) this.log.shift();
    if (e.kind === "peer") this.notePeer(e);
    if (this.paused) { this.held.push(e); if (this.held.length > MAX_ROWS) this.held.shift(); this.pauseLabel(); return; }
    this.paint(e);
  },

  paint(e) {
    const list = $("#lv-list"); if (!list) return;
    const li = row(e); list.prepend(li);
    this.n.all++; this.n[li.dataset.g] = (this.n[li.dataset.g] ?? 0) + 1;
    while (list.childElementCount > MAX_ROWS) { const old = list.lastElementChild; this.n.all--; this.n[old.dataset.g]--; old.remove(); }
    this.empty();
  },

  empty() {
    const el = $("#lv-empty"); if (!el) return;
    const shown = this.n[this.f] ?? 0;
    el.hidden = shown > 0;
    if (shown) return;
    const noun = { buy: "buying", sell: "selling", peer: "peer", money: "money", alert: "alert" }[this.f];
    setHtml(el, this.f === "all"
      ? (this.loadErr ? empty("Could not load the feed", esc(this.loadErr)) : empty("Nothing yet", "Send a request in the Playground and it shows up here.", '<button type="button" class="btn sm primary" data-go="playground">Open the Playground</button>'))
      : empty(`No ${noun} events yet`, "They appear here as they happen."));
  },

  filter(k) { this.f = k; $("#lv-list").dataset.f = k; this.empty(); },

  pause(on) {
    this.paused = on;
    if (!on) { const h = this.held; this.held = []; for (const e of h) this.paint(e); }
    this.pauseLabel();
  },
  pauseLabel() {
    const b = $("#lv-pause"); if (!b) return;
    b.textContent = this.paused ? `Resume${this.held.length ? ` · ${this.held.length} new` : ""}` : "Pause";
    b.setAttribute("aria-pressed", String(this.paused));
    b.classList.toggle("primary", this.paused);
  },

  // ---- presence ----
  notePeer(e) {
    const p = this.peers.find((x) => x.name === e.name);
    const online = e.state !== "offline";
    if (p) { p.online = online; if (num(e.rttMs)) p.rtt = e.rttMs; } else this.peers.push({ name: e.name, online, rtt: e.rttMs });
  },

  presence() {
    const now = Date.now(), recent = this.log.filter((e) => now - e.ts < WINDOW_MS);
    const ps = [...this.peers].sort((a, b) => (b.online - a.online) || ((a.rtt ?? 1e9) - (b.rtt ?? 1e9)) || String(a.name).localeCompare(String(b.name)));
    const up = ps.filter((p) => p.online).length;
    $("#lv-pn").textContent = ps.length ? `${up} of ${ps.length} online` : "none";
    setHtml($("#lv-peers"), ps.length ? ps.slice(0, 8).map(peerLi).join("") + (ps.length > 8 ? `<p class="lv-none">+ ${ps.length - 8} more in Network</p>` : "") : none('No peers yet. <a href="#network" data-go="network">Add one</a>.'));

    const group_ = (list, key) => { const m = new Map(); for (const e of list) { const k = key(e); const c = m.get(k) ?? { n: 0, last: 0, sim: false }; c.n++; c.last = Math.max(c.last, e.ts); c.sim ||= e.simulated === true; m.set(k, c); } return [...m].sort((a, b) => b[1].last - a[1].last); };
    const serving = group_(recent.filter((e) => e.kind === "request" && e.role !== "seller" && e.status === "ok"), (e) => e.peer ?? "unknown");
    setHtml($("#lv-serving"), serving.length ? serving.slice(0, 5).map(([name, c]) => `<div class="lv-li"><i class="lv-dot on"></i><span class="nm" title="${esc(name)}">${esc(name)}</span>${c.sim ? '<span class="badge sim" title="Simulated peer: no real inference, never settled">SIM</span>' : ""}<span class="r">${c.n} req · ${esc(ago(c.last))}</span></div>`).join("") : none("No answers in the last 5 minutes."));

    const sells = recent.filter((e) => e.kind === "request" && e.role === "seller" && e.status === "ok");
    const buyers = group_(sells, (e) => e.counterparty ?? e.peer ?? "unknown");
    const providing = S.status?.providing?.enabled;
    const lastSale = [...this.log].reverse().find((e) => e.kind === "request" && e.role === "seller" && e.status === "ok");
    $("#lv-sell").textContent = providing ? "selling" : "not selling";
    setHtml($("#lv-buyers"), buyers.length ? buyers.slice(0, 5).map(([id, c]) => `<div class="lv-li"><i class="lv-dot on"></i><span class="nm mono" title="${esc(id)}">${esc(id)}</span><span class="r">${c.n} req · ${esc(ago(c.last))}</span></div>`).join("")
      : none(providing ? `No buyers in the last 5 minutes.${lastSale ? ` Last sale ${esc(ago(lastSale.ts))}.` : ""}` : 'You are not selling. <a href="#provide" data-go="provide">Turn on Provide</a> to earn.'));
  },

  beat() { if (S.view !== "live") return; this.chip(); this.presence(); },

  async tick() {
    if (S.view !== "live") return;
    try { this.peers = (await api("/api/peers")).peers ?? this.peers; } catch { /* keep the last roster */ }
    this.beat();
  },
};
