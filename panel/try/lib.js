// Shared bits of the public page: DOM helpers, formatters, the badge vocabulary, one state object and a tiny event bus.
// No dependencies and no inline code (CSP). Text from the server is only ever rendered with textContent, never as HTML.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
export const row = (k, v, good) => { const r = el("div", "r"); r.append(el("span", "k", k), v instanceof Node ? v : el("span", "v" + (good ? " good" : ""), v)); return r; };

const SVG = "http://www.w3.org/2000/svg";
export const icon = (d, cls) => {
  const s = document.createElementNS(SVG, "svg"); s.setAttribute("viewBox", "0 0 16 16"); s.setAttribute("aria-hidden", "true"); if (cls) s.setAttribute("class", cls);
  const p = document.createElementNS(SVG, "path"); p.setAttribute("d", d); p.setAttribute("fill", "none"); p.setAttribute("stroke", "currentColor"); p.setAttribute("stroke-width", "1.8"); p.setAttribute("stroke-linecap", "round"); p.setAttribute("stroke-linejoin", "round"); s.append(p); return s;
};

/** the whole page shares one state object; modules read it and announce changes on the bus */
export const state = {
  market: null,   // GET /pub/market
  info: null,     // GET /pub/info
  loaded: false,  // the first poll has finished (successfully or not)
  quota: null,    // GET /pub/quota: { tier, used, limit, resetsAt }
  session: { signedIn: false }, // GET /auth/session: { signedIn, role, address, expiresAt, username?, needsName? } (the last two only when the node runs the gateway)
  account: null,  // the connected browser-wallet address (not the same thing as being signed in)
  pay: false,     // the playground pays a peer from the visitor's own session wallet instead of using this node's free model
  sel: null,      // model picked in the playground
};
const bus = new EventTarget();
export const on = (name, fn) => bus.addEventListener(name, (e) => fn(e.detail));
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));

export async function getJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
/** GET /pub/chain once: the escrow / token the wallet card and the pay-per-use session talk to (null when this node has no settlement or the page is not allowed to use it) */
let chainP = null;
export const chainCfg = () => (chainP ??= fetch("/pub/chain", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).then((j) => (j?.enabled ? j : null)).catch(() => null));

/** free quota of this visitor (the tier depends on the session cookie); null when the node does not answer */
export async function loadQuota() { try { state.quota = await getJson("/pub/quota"); } catch { state.quota = null; } return state.quota; }

export const price = (p) => (p == null ? null : p === 0 ? "Free" : "$" + p.toFixed(p >= 1 ? 2 : p >= 0.01 ? 3 : 4));
export const tps = (n) => (n >= 100 ? Math.round(n) : n.toFixed(1)) + " tok/s";
export const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
export const secs = (ms) => (ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(1) + " s");
export const clock = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); };

/** privacy of an offer: label, badge colour, what it means */
export const PRIV = {
  local: ["Local", "good", "Runs on the seller's own computer."],
  remote: ["Remote", "warn", "Forwarded to another machine; its owner can read prompts."],
  tee: ["TEE verified", "tee", "This node verified a hardware attestation for the workload."],
  "tee-claimed": ["TEE claimed", "warn", "The seller says it runs in a TEE, but this node has not verified it."],
  none: ["Clear", "", "No privacy claim: the seller can read prompts."],
};
export const badge = (p) => { const [t, c, d] = PRIV[p] ?? PRIV.none; const b = el("span", "badge" + (c ? " " + c : ""), t); b.title = d; return b; };
export const pill = (text, cls, title) => { const b = el("span", "badge" + (cls ? " " + cls : ""), text); if (title) b.title = title; return b; };

/** The badges of one answer. LIVE vs SIM comes from the server's x-elyra-simulated header, never assumed. */
export function routeBadges(sim, privacy) {
  const f = document.createDocumentFragment();
  f.append(sim ? pill("SIM", "sim", "Simulated: not a real model answer.") : pill("LIVE", "good", "A real model answered. Nothing here is simulated."));
  f.append(" ", privacy === "remote" ? pill("REMOTE", "warn", "Runs on a machine the node operator rents from a third party.") : pill("LOCAL", "good", "Runs on the node operator's own machine."));
  f.append(" ", pill("CLEAR", "", "No privacy claim: whoever runs the model can read your prompt. The Elyra router does not log or store it."));
  return f;
}

/** the gateway (ELYRA_GATEWAY=1) makes chat on this node need a signed-in wallet with a username; the node owner (admin session) is never gated */
export const gateway = () => !!state.info?.gateway;
export const gated = () => gateway() && !(state.session.signedIn && (state.session.role === "admin" || !!state.session.username));
/** models this page can chat with: the node's own free ones, or (pay mode) those a peer sells, decided by pay.js */
export const chatModels = (payable) => (state.market?.models ?? []).filter((g) => (state.pay ? payable?.(g.model, state.market) : g.chat)).map((g) => g.model);
export const selOffer = () => state.market?.models.find((g) => g.model === state.sel)?.offers.find((o) => o.chat) ?? null;

/** Payment-path guidance card, cloned from <template id="tpl-paid">; deployment capability text is filled by try.js. */
export const paidCard = () => document.getElementById("tpl-paid").content.firstElementChild.cloneNode(true);

/** settlement as one honest phrase, from what the node reports */
export const settlement = (node) => {
  if (!node || node.settlement !== "chain") return "Simulated ledger";
  const n = String(node.network ?? "");
  return /testnet/i.test(n) ? "On-chain, testnet" : /local|dev/i.test(n) ? "On-chain, local dev chain" : n ? "On-chain, " + n : "On-chain";
};
