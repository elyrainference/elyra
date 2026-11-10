// Playground page: one conversation with a live model on this node, streamed from POST /pub/chat.
// The conversation lives ONLY in this browser (localStorage "elyra-try-chat"): the page never sends it anywhere except the messages of the
// request you are making, and it is never stored on the server. Everything the model or the server says is rendered with textContent.
// Two ways to chat: this node's own free model (POST /pub/chat; with the gateway on it needs a signed-in wallet with a username), or a peer's paid
// model from the visitor's own pay-per-use session (POST /pub/paid-chat, receipt settled by pay.js; needs no account).
import { $, el, row, state, emit, on, loadQuota, chatModels, selOffer, routeBadges, pill, secs, short, clock, paidCard, gated, gateway } from "./lib.js";
import { pay } from "./pay.js";

const KEY = "elyra-try-chat", MAX_TURNS = 60, MAX_SENT = 10, MAX_CHARS = 3600; // the server accepts 12 messages / 4000 characters
const num = (v) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : null);
const text = (v, n = 160) => String(v ?? "").slice(0, n);

// ---- history (localStorage only) ----
const cleanMeta = (m) => (m && typeof m === "object" ? { model: text(m.model, 120), seller: text(m.seller, 60), sim: m.sim === true, privacy: text(m.privacy, 20), tin: num(m.tin), tout: num(m.tout), approx: m.approx === true, ttft: num(m.ttft), ms: num(m.ms), speed: num(m.speed), stopped: m.stopped === true, paid: m.paid && typeof m.paid === "object" ? { usd: num(m.paid.usd), refused: text(m.paid.refused, 220), accepted: m.paid.accepted === true, price: text(m.paid.price, 20) } : null } : null);
function loadHistory() {
  try {
    const j = JSON.parse(localStorage.getItem(KEY));
    if (j?.v === 1 && Array.isArray(j.turns)) return { model: typeof j.model === "string" ? j.model : null, turns: j.turns.filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string").slice(-MAX_TURNS).map((t) => ({ role: t.role, content: t.content.slice(0, 4000), meta: t.role === "assistant" ? cleanMeta(t.meta) : null })) };
  } catch { /* nothing saved, or storage blocked */ }
  return { model: null, turns: [] };
}
const hist = loadHistory();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ v: 1, model: hist.model, turns: hist.turns.slice(-MAX_TURNS) })); } catch { /* storage full or blocked: the chat still works, it just is not kept */ } };

let msgs, thread, q, send, form, pick, empty;
let busy = false, ctl = null, notice = null, clearTimer = 0;
const canPay = () => pay.enabled && pay.funded();
const models = () => chatModels(pay.payable);
/** the offer this turn goes to: this node's free model, or (pay mode) the peer that sells the picked model */
const curOffer = () => (state.pay ? state.market?.models.find((g) => g.model === state.sel)?.offers.find((o) => o.where === "peer" && o.price != null) ?? null : selOffer());

// ---- messages ----
const nearBottom = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 90;
const toBottom = () => { msgs.scrollTop = msgs.scrollHeight; };
const refreshEmpty = () => { empty.hidden = hist.turns.length > 0 || busy || !!thread.querySelector(".turn"); };

function addUser(t) { const w = el("div", "turn u"); w.append(el("div", "m u", t)); thread.insertBefore(w, notice); return w; }

function routeDetails(meta) {
  const d = el("details", "route"), s = el("summary");
  if (meta.paid) s.append(pill("LIVE", "good", "A real model answered."), " ", pill("PAID", "accent", "Paid per token from your session wallet."), " ");
  else s.append(routeBadges(meta.sim, meta.privacy), " ");
  const bits = [meta.model || "model"];
  if (meta.tout != null) bits.push(`${meta.approx ? "~" : ""}${meta.tout} tokens`);
  if (meta.ms != null) bits.push(secs(meta.ms));
  if (meta.stopped) bits.push("stopped");
  s.append(el("span", "rs", bits.join(" · ")));
  const kv = el("div", "kv");
  if (meta.paid) {
    const pd = meta.paid;
    kv.append(row("Served by", meta.seller || "a peer"), row("Model", meta.model || "-"), row("Price", pd.price ? `$${pd.price} per 1M tokens` : "-"),
      row("Charged", pd.refused ? "Nothing (refused)" : pd.usd != null ? "$" + pd.usd.toFixed(pd.usd >= 0.01 ? 4 : 6) : "-"), row("Voucher", pd.refused ? "-" : pd.accepted ? "Signed here, accepted by the seller" : "Signed here, pending"),
      row("Paid from", "Your session wallet (this node holds no key)"), row("Tokens", meta.tout != null ? `${meta.approx ? "~" : ""}${meta.tout} out` : "-"),
      row("First word after", meta.ttft != null ? secs(meta.ttft) : "-"), row("Total time", meta.ms != null ? secs(meta.ms) : "-"), row("Speed", meta.speed ? `${meta.speed.toFixed(1)} tokens/s` : "-"));
    if (pd.refused) kv.append(row("Not charged", pd.refused));
    d.append(s, kv); return d;
  }
  kv.append(row("Served by", meta.seller ? `${meta.seller} (this node)` : "this node"), row("Model", meta.model || "-"),
    row("Runs on", meta.privacy === "remote" ? "A machine the node operator rents from a third party" : "The node operator's own machine"),
    row("Simulated", meta.sim ? "Yes" : "No, a real model", !meta.sim), row("Privacy", "Clear: the model's host can read the prompt. The Elyra router does not log or store it."),
    row("Price", "Free (this node's own model)"), row("Cost", "$0.00"), row("Paid peers used", "None for this answer; no wallet was spent"),
    row("Tokens", meta.tin != null || meta.tout != null ? `${meta.tin ?? "-"} in / ${meta.approx ? "~" : ""}${meta.tout ?? "-"} out` : "-"),
    row("First word after", meta.ttft != null ? secs(meta.ttft) : "-"), row("Total time", meta.ms != null ? secs(meta.ms) : "-"), row("Speed", meta.speed ? `${meta.speed.toFixed(1)} tokens/s` : "-"));
  d.append(s, kv); return d;
}

function addAnswer(content, meta) {
  const w = el("div", "turn a"), b = el("div", "m a", content); w.append(b); if (meta) w.append(routeDetails(meta));
  thread.insertBefore(w, notice); return { w, b };
}

function clearNotice() { notice?.remove(); notice = null; }
/** an error or empty state with a clear next action. actions: [{label, primary, href | fn}] */
function showNotice(title, body, actions = []) {
  clearNotice();
  notice = el("div", "notice"); notice.setAttribute("role", "alert");
  notice.append(el("b", null, title), el("p", null, body));
  const bar = el("div", "cta2");
  for (const a of actions) {
    const x = el(a.href ? "a" : "button", "btn sm" + (a.primary ? " primary" : "")); x.textContent = a.label;
    if (a.href) x.href = a.href; else { x.type = "button"; x.addEventListener("click", a.fn); }
    bar.append(x);
  }
  if (actions.length) notice.append(bar);
  empty.hidden ? thread.append(notice) : thread.insertBefore(notice, empty); // on an empty page the problem comes before the starters
  notice.scrollIntoView({ block: "nearest" });
}
const walletAction = () => ({ label: state.session.signedIn ? "Your wallet" : state.account ? "Sign in for more" : "Connect a wallet for more", fn: () => emit("wallet:open") });
const retryAction = () => ({ label: "Try again", primary: true, fn: () => { clearNotice(); form.requestSubmit(); } });

async function explain(err) {
  const msg = err.message || "The request failed.";
  if (err.type === "signin_required" || err.type === "profile_required") {
    return showNotice(err.type === "profile_required" ? "Choose a name first" : "Sign in to chat", msg, [{ label: err.type === "profile_required" ? "Choose a name" : state.account ? "Sign in" : "Connect a wallet", primary: true, fn: () => { clearNotice(); emit("wallet:open"); } }]);
  }
  if (err.type === "pay") return showNotice("This paid chat did not go through", msg, [{ label: "Open wallet", primary: true, fn: () => { clearNotice(); emit("wallet:open"); } }, retryAction()]);
  if (err.status === 429) {
    await loadQuota(); renderQuota();
    const q2 = state.quota, mine = q2 && q2.used >= q2.limit;
    const wait = err.retryAfter ? ` Try again in about ${Math.max(1, Math.ceil(err.retryAfter / 60))} min.` : "";
    if (mine) return showNotice("Out of free requests", msg + wait, [...(state.session.signedIn ? [] : [walletAction()]), { label: "Run your own node", href: "#/sell", primary: state.session.signedIn }]);
    return showNotice("Today's free capacity is used up", msg, [{ label: "Run your own node", href: "#/sell", primary: true }]);
  }
  if (err.status === 503 && err.type === "unavailable") return showNotice("No model is online", msg, [{ label: "Check again", primary: true, fn: () => { clearNotice(); emit("reload"); } }, { label: "See the market", href: "#/market" }]);
  if (err.status === 404) return showNotice("That model is not available", msg, [{ label: "Pick another model", primary: true, fn: () => { clearNotice(); emit("reload"); pick.focus(); } }]);
  if (err.status === 503) return showNotice("The model is busy", msg, [retryAction()]);
  if (err.status === 0) return showNotice("Cannot reach the node", "Your connection or the node is down. Nothing was sent to a model.", [retryAction(), { label: "See the market", href: "#/market" }]);
  if (err.status === 502) return showNotice("The model did not answer", msg, [retryAction()]);
  return showNotice("That did not work", msg, [retryAction()]);
}

class ChatError extends Error { constructor(status, type, message, retryAfter) { super(message); this.status = status; this.type = type; this.retryAfter = retryAfter; } }

// ---- sending ----
function payload(t) {
  const m = [...hist.turns.map(({ role, content }) => ({ role, content })), { role: "user", content: t }].slice(-MAX_SENT);
  const size = () => m.reduce((n, x) => n + x.content.length, 0);
  while (m.length > 1 && (size() > MAX_CHARS || m[0].role !== "user")) m.shift();
  return m;
}

async function ask(raw) {
  const t = raw.trim();
  if (busy || !t || !state.sel || !curOffer()) return;
  if (state.pay && !canPay()) { renderComposer(); $("#gate-btn").focus(); return; }
  if (gated() && !state.pay) return explain(new ChatError(401, state.session.signedIn ? "profile_required" : "signin_required", state.session.signedIn ? "Choose a name for your account to chat on this node." : "Connect your wallet, sign in and choose a name to chat on this node."));
  clearNotice();
  busy = true; ctl = new AbortController(); setBusy(true); refreshEmpty();
  const u = addUser(t), a = el("div", "turn a"), bub = el("div", "m a"), cur = el("span", "cur"); bub.append(cur); a.append(bub); thread.insertBefore(a, notice); toBottom();
  const offer = curOffer(), t0 = performance.now();
  let acc = "", tin = null, tout = null, chunks = 0, first = null, sim = false, model = state.sel, stopped = false, spec = null, payEv = null, ev = "", peer = "", priceH = "";
  const wait = setTimeout(() => { if (!acc) { bub.textContent = "Waiting for the model… a first answer after a quiet spell can take a minute."; bub.append(cur); } }, 2500);
  try {
    let r;
    let url = "/pub/chat", body = { model: state.sel, messages: payload(t) };
    if (state.pay) { try { spec = await pay.request(state.sel, body.messages, state.market); } catch (e) { throw new ChatError(0, "pay", e.message); } url = spec.url; body = spec.body; }
    try { r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal }); }
    catch (e) { if (e.name === "AbortError") throw e; throw new ChatError(0, "network", "Cannot reach the node."); }
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new ChatError(r.status, j.error?.type, j.error?.message || `Request failed (${r.status})`, Number(r.headers.get("retry-after")) || 0); }
    sim = r.headers.get("x-elyra-simulated") !== "false"; model = r.headers.get("x-elyra-model") || model;
    peer = text(r.headers.get("x-elyra-route"), 80).replace(/^peer:/, ""); priceH = text(r.headers.get("x-elyra-price"), 20);
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = "";
    try {
      for (;;) {
        const { done, value } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n"); buf = parts.pop();
        for (const ln of parts) {
          if (ln.startsWith("event:")) { ev = ln.slice(6).trim(); continue; }
          if (!ln.startsWith("data:")) { if (!ln) ev = ""; continue; }
          if (ev === "pay") { try { payEv = JSON.parse(ln.slice(5)); } catch { /* ignore a broken receipt: nothing is charged */ } ev = ""; continue; }
          if (ev === "error") { let m = "The answer could not be verified."; try { m = JSON.parse(ln.slice(5)).message || m; } catch { /* keep the default */ } ev = ""; throw new ChatError(502, "pay", m); }
          if (ln.includes("[DONE]")) continue;
          let j; try { j = JSON.parse(ln.slice(5)); } catch { continue; } // a partial line
          const d = j.choices?.[0]?.delta?.content;
          if (d) { const stick = nearBottom(); if (!acc) bub.textContent = ""; chunks++; first ??= performance.now(); acc += d; bub.textContent = acc; bub.append(cur); if (stick) toBottom(); }
          if (j.usage?.completion_tokens != null) tout = j.usage.completion_tokens;
          if (j.usage?.prompt_tokens != null) tin = j.usage.prompt_tokens;
        }
      }
    } catch (e) { if (!acc) throw e; stopped = true; } // the stream broke after some text: keep what arrived
  } catch (e) {
    clearTimeout(wait); cur.remove();
    if (e.name === "AbortError" && acc) stopped = true;
    else {
      // a failed turn leaves no trace in the conversation: the text goes back to the composer so "Try again" resends it
      u.remove(); a.remove(); if (!q.value) { q.value = t; grow(); }
      busy = false; ctl = null; setBusy(false); refreshEmpty();
      if (e.name === "AbortError") { q.focus({ preventScroll: true }); return; }
      await explain(e.status != null ? e : new ChatError(0, "network", e.message));
      return;
    }
  }
  clearTimeout(wait); cur.remove();
  if (!acc.trim()) { u.remove(); a.remove(); if (!q.value) { q.value = t; grow(); } busy = false; ctl = null; setBusy(false); refreshEmpty(); showNotice("The model returned an empty answer", "Try rephrasing your message.", [retryAction()]); return; }
  const end = performance.now(), n = tout ?? chunks, ms = end - t0;
  let paid = null;
  if (spec) {
    if (!payEv) paid = { refused: "The seller did not return a receipt, so nothing was charged." };
    else { try { const r2 = await pay.settle(payEv, spec); paid = r2.refused ? { refused: r2.refused } : { usd: r2.usd, accepted: r2.accepted }; } catch (e) { paid = { refused: "The voucher could not be signed: " + text(e?.message, 160) }; } }
    paid.price = priceH;
  }
  const meta = { model, seller: spec ? peer || offer?.seller || "" : offer?.seller ?? "", sim, privacy: offer?.privacy ?? "local", paid, tin, tout: n, approx: tout == null, ttft: first != null ? first - t0 : null, ms, speed: first != null && end > first ? n / ((end - first) / 1000) : null, stopped };
  a.remove(); addAnswer(acc, meta);
  hist.turns.push({ role: "user", content: t, meta: null }, { role: "assistant", content: acc, meta }); hist.model = state.sel; save();
  busy = false; ctl = null; setBusy(false); refreshEmpty();
  toBottom(); q.focus({ preventScroll: true });
  emit("reload"); // fresh quota, measured speed and numbers
}

function setBusy(b) {
  msgs.setAttribute("aria-busy", String(b));
  send.type = b ? "button" : "submit"; send.textContent = b ? "Stop" : "Send"; send.classList.toggle("primary", !b); send.classList.toggle("stop", b);
  send.setAttribute("aria-label", b ? "Stop the answer" : "Send message");
  pick.disabled = b || models().length < 2; $("#paymode").disabled = b; $("#clear").disabled = b || !hist.turns.length;
  renderComposer();
}

// ---- chrome around the thread ----
function renderComposer() {
  const off = !curOffer(), lock = gated() && !state.pay, unfunded = state.pay && !canPay();
  q.placeholder = unfunded ? "Fund a session to use this paid model" : lock ? "Sign in to chat" : off ? (state.pay ? "No paid model is online" : "No model is online right now") : "Ask anything…"; q.disabled = off || lock || unfunded;
  send.disabled = (off || lock || unfunded) && !busy;
  const g = $("#gate"); g.hidden = !lock && !unfunded;
  if (unfunded) {
    $("#gate-t").textContent = "Paid peer mode: review the price ceiling above, then create and fund your own browser session. Free hosted chat does not need a deposit. Sign-in alone does not pay.";
    $("#gate-btn").textContent = "Set up paid session";
  } else if (lock) {
    const named = state.session.signedIn;
    $("#gate-t").textContent = named ? "Choose a name to start chatting on this node. No escrow deposit is required." : "This deployment requires wallet sign-in and a username for free hosted chat. Signing proves your address; no transaction, approval or deposit.";
    $("#gate-btn").textContent = named ? "Choose a name" : state.account ? "Sign in" : "Connect wallet";
  }
}

function renderPayToggle() {
  const w = $("#paymode-w");
  w.hidden = !pay.enabled; if (!pay.enabled && state.pay) state.pay = false;
  $("#paymode").checked = state.pay;
  $("#session-usage").hidden = !pay.enabled;
}
function setPay(on) {
  if (busy) { $("#paymode").checked = state.pay; return; }
  state.pay = !!on && pay.enabled; clearNotice(); renderModel(); renderQuota();
}

function renderModel() {
  renderPayToggle();
  const ms = models(), line = $("#modelline"); line.replaceChildren();
  pick.replaceChildren(...(ms.length ? ms : ["No live model"]).map((x) => { const e = el("option", null, x); e.value = ms.length ? x : ""; return e; }));
  if (!ms.includes(state.sel)) state.sel = ms.includes(hist.model) ? hist.model : state.info?.model && ms.includes(state.info.model) ? state.info.model : ms[0] ?? null;
  pick.value = state.sel ?? ""; pick.disabled = busy || ms.length < 2;
  const o = curOffer(), checking = !state.loaded; // checking: first paint, before the node answered
  if (checking) line.append(pill("CHECKING", ""), el("span", "ml", "Asking the node which models are online…"));
  else if (!o) line.append(pill("OFFLINE", "bad"), el("span", "ml", state.market ? "No model is answering on this node right now. Its machine usually comes back by itself." : "Cannot reach the node. Retrying…"));
  else if (state.pay) { line.append(pill("PAID", "accent", "Paid per token from your session wallet"), " ", pill("PEER", "", "The router chooses a seller for this model.")); line.append(el("span", "ml", `Price ceiling $${pay.priceLimit(state.sel, state.market)}/1M input + output tokens · includes 5% quote allowance · seller chosen by router`)); }
  else { line.append(routeBadges(false, o.privacy)); line.append(el("span", "ml", `Served by ${o.seller} · free here`)); }
  $("#fine-model").textContent = checking ? "Checking the node…" : !o ? (state.pay ? "No peer sells a model right now." : "No model on this node is answering right now.")
    : state.pay ? `Paid chat: your session signs vouchers in this browser within the displayed ceiling. Balance in escrow: ${pay.usd(pay.depositUnits)}. Review the actual seller, receipt and cost under each answer. The model operator can read prompts unless its workload is verified private.`
    : o.privacy === "remote" ? "This model runs on a machine the operator rents from a third party, so do not type anything private. Answers can be wrong."
      : "This model runs on the operator's own machine. The Elyra router does not log or store prompts, but do not type anything private. Answers can be wrong.";
  $("#empty-p").textContent = checking ? "One moment…" : o ? (state.pay ? canPay() ? "Funded paid session. Each answer shows its seller, token usage and charge. Sending authorizes a voucher within the displayed price ceiling." : "Review before you fund: this is a paid peer route, not the hosted free quota. No charge until you fund a session and send." : gated() ? "This deployment requires sign-in for free hosted chat. No deposit is needed." : "Free hosted try, within this node's quota. No escrow payment. Start with a prompt below.") : "No model is online right now. Check the market, or come back in a few minutes.";
  $("#chips").hidden = !o;
  $("#chat-paid").hidden = state.pay;
  renderNudge();
  renderComposer();
}

function renderQuota() {
  const box = $("#quota"), qu = state.quota;
  box.hidden = !qu || state.pay || gated(); if (box.hidden) return;
  const left = Math.max(0, qu.limit - qu.used), tier = qu.tier === "wallet" ? "Wallet" : "Visitor";
  const t = $("#q-tier"); t.textContent = tier; t.className = "badge tier " + qu.tier;
  $("#q-fill").style.width = Math.min(100, qu.limit ? (qu.used / qu.limit) * 100 : 100) + "%";
  box.classList.toggle("full", left === 0);
  const when = qu.resetsAt ? clock(qu.resetsAt) : "";
  $("#q-text").textContent = `${left} of ${qu.limit} left` + (left === 0 && when ? ` · resets ${when}` : "");
  box.title = `${tier} tier: ${qu.limit} free requests, ${qu.used} used.` + (when ? ` The count resets around ${when}.` : "") + (qu.tier === "wallet" ? "" : " Signing in with a wallet raises the limit.");
}

function renderNudge() {
  const n = $("#nudge"); n.replaceChildren();
  n.hidden = state.pay; if (state.pay) return;
  const ss = state.session, gw = gateway();
  if (ss.signedIn && gw && ss.needsName && ss.role !== "admin") {
    n.append(el("h3", null, "One more step"), el("p", "muted small", "Choose a name for your account. Chat on this node needs it."));
    const b = el("button", "btn sm primary", "Choose a name"); b.type = "button"; b.addEventListener("click", () => emit("wallet:open")); n.append(b); return;
  }
  if (ss.signedIn) { n.append(el("h3", null, ss.username ? `You are signed in as @${ss.username}` : "You are signed in"), el("p", "muted small", `${short(ss.address)} ${gw ? "can chat on this node." : "has the larger Wallet quota."} Your history still stays in this browser.`)); return; }
  n.append(el("h3", null, gw ? "Sign in to chat" : "Want a bigger free quota?"), el("p", "muted small", gw ? "Chat on this node needs a wallet account. Signing proves you own an address; no transaction, no gas, nothing is approved." : "Sign in with a wallet. Signing proves you own an address; no transaction, no gas, nothing is approved."));
  const b = el("button", "btn sm", state.account ? "Sign in" : "Connect wallet"); b.type = "button"; b.addEventListener("click", () => emit("wallet:open")); n.append(b);
}


function drawHistory() {
  thread.querySelectorAll(".turn").forEach((x) => x.remove());
  for (const t of hist.turns) { if (t.role === "user") addUser(t.content); else addAnswer(t.content, t.meta); }
  refreshEmpty(); $("#clear").disabled = busy || !hist.turns.length;
}

function grow() { q.style.height = "auto"; q.style.height = Math.min(q.scrollHeight, 160) + "px"; }

function clearHistory(btn) {
  if (busy || !hist.turns.length) return;
  if (!btn.dataset.sure) {
    btn.dataset.sure = "1"; btn.textContent = "Click again to clear"; btn.classList.add("danger");
    clearTimer = setTimeout(() => resetClearBtn(btn), 4000); return;
  }
  resetClearBtn(btn); hist.turns = []; save(); clearNotice(); drawHistory(); q.focus({ preventScroll: true });
}
function resetClearBtn(btn) { clearTimeout(clearTimer); delete btn.dataset.sure; btn.textContent = "Clear history"; btn.classList.remove("danger"); }

export function initChat() {
  msgs = $("#msgs"); thread = $("#thread"); q = $("#q"); send = $("#send"); form = $("#form"); pick = $("#pick"); empty = $("#empty");
  form.addEventListener("submit", (e) => { e.preventDefault(); if (busy) return; const t = q.value; if (!t.trim()) return; q.value = ""; grow(); ask(t); });
  send.addEventListener("click", () => { if (busy) ctl?.abort(); });
  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!busy) form.requestSubmit(); }
    else if (e.key === "Escape" && busy) ctl?.abort();
  });
  q.addEventListener("input", grow);
  pick.addEventListener("change", () => { if (busy || !pick.value) return; state.sel = pick.value; hist.model = state.sel; save(); renderModel(); });
  $("#chips").addEventListener("click", (e) => { const c = e.target.closest(".starter"); if (c) ask(c.textContent); });
  $("#clear").addEventListener("click", (e) => clearHistory(e.currentTarget));
  $("#chat-paid").append(paidCard());
  on("choose", () => { hist.model = state.sel; save(); renderModel(); renderQuota(); });
  $("#paymode").addEventListener("change", (e) => setPay(e.target.checked));
  const openSession = () => { $("#pay-adv").open = true; emit("wallet:open"); };
  $("#session-usage").addEventListener("click", openSession);
  $("#gate-btn").addEventListener("click", () => { if (state.pay) openSession(); else emit("wallet:open"); });
  on("data", () => { renderModel(); renderQuota(); renderNudge(); });
  on("session", () => { renderNudge(); renderModel(); emit("reload"); });
  on("wallet", () => { renderNudge(); renderComposer(); });
  on("pay", () => { renderModel(); renderQuota(); });
  drawHistory(); renderModel(); renderNudge(); renderQuota();
}
