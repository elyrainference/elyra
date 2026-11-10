// Wallet button and menu of the public page. Two separate things live here:
//   1. a CONNECTED wallet, selected by Reown AppKit (injected wallets or WalletConnect QR);
//   2. a SIGN-IN: one off-chain signature (Sign-In with Ethereum, see /try/auth.js) that proves you own the address. No transaction, no gas,
//      nothing approved, no funds move. It gives a bigger free quota in the playground and a personal chip; a wallet sign-in can never
//      reach /api, /v1 or the control panel. Only an address on the node's owner list gets the panel (role "admin").
//   3. when the node runs the gateway (ELYRA_GATEWAY=1): a USERNAME for the signed-in wallet (chosen once) that chat on this node requires.
// This module never holds a key and never pays for anything: the optional pay-per-use session (pay.js) has its own throwaway key and
// borrows this wallet only to send user-confirmed deposits through `walletApi`. All server text goes through textContent.
import { $, el, state, emit, on, short, chainCfg, gateway } from "./lib.js";
import { checkUsername, setUsername } from "./auth.js";
import { disconnectWallet, onConnection, openWalletPicker } from "./appkit-connect.js";

const S = { cfg: null, prov: null, name: "", account: null, chainOk: false, eth: null, bal: null, busy: "", msg: null, off: null };
const N = { value: "", check: null, timer: 0, input: null, hint: null, go: null, box: null }; // the username step keeps its own nodes so a redraw never steals focus while typing

/** what the pay-per-use session (pay.js) may use from the connected browser wallet: read state and send transactions the user confirms in the wallet */
export const walletApi = {
  get account() { return S.account; }, get cfg() { return S.cfg; },
  request: (m, p) => req(m, p), ensureChain: () => ensureChain(), refresh: () => refresh(),
};
const btn = $("#walletbtn"), pop = $("#wallet-pop"), body = $("#wallet-body");
let sessionTimer = 0;

const hex = (n) => "0x" + n.toString(16);
const pad = (h) => h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const fmt = (units, dec) => { const s = units.toString().padStart(dec + 1, "0"); const w = s.slice(0, -dec), f = s.slice(-dec).replace(/0+$/, ""); return f ? `${w}.${f.slice(0, 4)}` : w; };
const fmtEth = (wei) => { const s = wei.toString().padStart(19, "0"); return `${s.slice(0, -18)}.${s.slice(-18, -14)}`; };
const sameAddr = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const nice = (e) => (e && (e.code === 4001 || e.code === "ACTION_REJECTED" || /reject|denied/i.test(e.message || "")) ? "Cancelled in your wallet." : String(e?.message || e).slice(0, 220));
const req = (m, p = []) => S.prov.request({ method: m, params: p });
const button = (label, cls, fn, disabled) => { const b = el("button", "btn " + cls, label); b.type = "button"; b.disabled = !!disabled; b.addEventListener("click", (e) => { S.refocus = true; fn(e); }); return b; };

// ---- the node's session (cookie, HttpOnly: the page only learns who it is from /auth/session) ----
function setSession(s) {
  const next = s?.signedIn ? { signedIn: true, address: s.address, role: s.role, expiresAt: s.expiresAt, ...(s.username !== undefined ? { username: s.username } : {}), ...(s.needsName !== undefined ? { needsName: s.needsName } : {}) } : { signedIn: false };
  const changed = JSON.stringify(next) !== JSON.stringify(state.session);
  state.session = next; clearTimeout(sessionTimer);
  if (next.signedIn && next.expiresAt) sessionTimer = setTimeout(loadSession, Math.min(2 ** 31 - 1, Math.max(1000, new Date(next.expiresAt).getTime() - Date.now() + 500)));
  draw(); if (changed) emit("session", state.session);
}
async function loadSession() {
  try { const r = await fetch("/auth/session", { cache: "no-store" }); setSession(r.ok ? await r.json() : null); } catch { setSession(null); }
}
async function signIn() {
  S.busy = "sign"; S.msg = null; draw();
  try {
    const { signInWithWallet } = await import("./auth.js");
    const r = await signInWithWallet({ provider: S.prov, address: S.account });
    setSession({ signedIn: true, ...r });
    S.msg = { ok: true, text: r.role === "admin" ? "Signed in as the node owner." : r.needsName ? "Signed in. Choose a name to start chatting." : gateway() ? "Signed in." : "Signed in. Your free quota is larger now." };
  } catch (e) { S.msg = { ok: false, text: nice(e) }; }
  S.busy = ""; draw();
}
async function signOut() {
  S.busy = "out"; draw(); N.value = ""; N.check = null;
  try { await fetch("/auth/logout", { method: "POST" }); } catch { /* the cookie also expires by itself */ }
  S.busy = ""; S.msg = null; await loadSession();
}

// ---- the username (gateway only): one name per wallet, set once ----
function onName(v) {
  N.value = v; N.check = null; clearTimeout(N.timer); paintName();
  if (!v.trim()) return;
  N.timer = setTimeout(async () => {
    try { const c = await checkUsername(v); if (c.name === N.value.trim().toLowerCase()) { N.check = c; paintName(); } }
    catch (e) { N.check = { valid: false, available: false, reason: nice(e), name: N.value.trim().toLowerCase() }; paintName(); }
  }, 300);
}
async function saveName() {
  S.busy = "name"; S.msg = null; paintName();
  try {
    const p = await setUsername(N.value.trim());
    setSession({ ...state.session, signedIn: true, username: p.username, needsName: false });
    S.msg = { ok: true, text: "Profile created. You can chat now." };
  } catch (e) { S.msg = { ok: false, text: nice(e) }; }
  S.busy = ""; draw();
}
const nameOk = () => !!N.check?.available && N.check.name === N.value.trim().toLowerCase();
function paintName() {
  if (!N.input) return;
  N.input.disabled = S.busy === "name";
  N.go.disabled = !nameOk() || !!S.busy; N.go.textContent = S.busy === "name" ? "Saving…" : "Create profile";
  N.hint.className = "small " + (N.check ? (N.check.available ? "good" : "warn") : "muted");
  N.hint.textContent = N.check ? (N.check.available ? "Available." : N.check.reason || "Not available.") : N.value.trim() ? "Checking…" : "";
}
function nameSection() {
  if (!N.box) {
    const box = N.box = el("section", "sec");
    N.input = el("input", "txt"); N.input.id = "acct-name"; N.input.type = "text"; N.input.maxLength = 20; N.input.autocomplete = "off"; N.input.spellcheck = false; N.input.placeholder = "your_name"; N.input.setAttribute("aria-label", "Username"); N.input.setAttribute("aria-describedby", "acct-name-hint");
    N.input.addEventListener("input", () => onName(N.input.value));
    N.input.addEventListener("keydown", (e) => { if (e.key === "Enter" && nameOk() && !S.busy) { e.preventDefault(); saveName(); } });
    N.go = button("Create profile", "primary sm", saveName, true);
    N.hint = el("p", "small muted"); N.hint.id = "acct-name-hint"; N.hint.setAttribute("aria-live", "polite");
    const row = el("div", "name-row"); row.append(N.input, N.go);
    box.append(el("h3", null, "Choose your name"), el("p", "muted small", "Letters, numbers and underscores, 3 to 20 characters. You can set it once. Chat on this node needs it."), row, N.hint);
  }
  paintName(); return N.box;
}
const stepper = (n) => { const o = el("ol", "acct-steps"); ["Connect wallet", "Sign in", "Choose a name"].forEach((t, i) => o.append(el("li", i + 1 < n ? "done" : i + 1 === n ? "now" : "", t))); o.setAttribute("aria-label", "Account steps"); return o; };

// ---- the browser wallet ----
async function ensureChain() {
  const id = hex(S.cfg.chainId);
  try { await req("wallet_switchEthereumChain", [{ chainId: id }]); }
  catch (e) {
    if (e?.code !== 4902 && !/unrecognized|unknown|not added/i.test(e?.message || "")) throw e;
    await req("wallet_addEthereumChain", [{ chainId: id, chainName: S.cfg.name || "Robinhood Chain", rpcUrls: [S.cfg.rpcUrl], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: S.cfg.explorer ? [S.cfg.explorer] : [] }]);
  }
}
async function read() {
  S.eth = S.bal = null;
  if (!S.cfg) { S.chainOk = false; return; }
  S.chainOk = parseInt(await req("eth_chainId"), 16) === S.cfg.chainId;
  if (!S.chainOk) return;
  const [eth, tok] = await Promise.all([req("eth_getBalance", [S.account, "latest"]), req("eth_call", [{ to: S.cfg.token, data: "0x70a08231" + pad(S.account) }, "latest"])]);
  S.eth = BigInt(eth); S.bal = BigInt(tok);
}
function attach(provider, account) {
  if (S.prov === provider && sameAddr(S.account, account)) return;
  S.off?.();
  S.prov = provider; S.name = "Reown AppKit"; S.account = account; state.account = account;
  const onChain = () => refresh();
  provider.on?.("chainChanged", onChain);
  S.off = () => provider.removeListener?.("chainChanged", onChain);
  S.msg = null; refresh(); setOpen(true, false);
}
async function connect() {
  S.busy = "connect"; S.msg = null; setOpen(false, false); draw();
  try { await openWalletPicker(); }
  catch (e) { S.msg = { ok: false, text: nice(e) }; setOpen(true, false); }
  finally { S.busy = ""; draw(); }
}
async function refresh() { try { await read(); } catch (e) { S.msg = { ok: false, text: nice(e) }; } draw(); }
function clearConnection() {
  S.off?.(); S.off = null; S.prov = null; S.account = null; state.account = null; S.eth = S.bal = null; S.msg = null;
  draw();
}
async function disconnect() {
  try { await disconnectWallet(); clearConnection(); }
  catch (e) { S.msg = { ok: false, text: nice(e) }; draw(); }
}
async function mint() {
  S.busy = "mint"; S.msg = null; draw();
  try {
    await ensureChain();
    const data = "0x40c10f19" + pad(S.account) + pad((100n * 10n ** BigInt(S.cfg.decimals)).toString(16));
    const h = await req("eth_sendTransaction", [{ from: S.account, to: S.cfg.token, data }]);
    S.msg = { ok: true, text: "Sent. It shows up once the transaction is mined.", tx: h };
    for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 2000)); const rc = await req("eth_getTransactionReceipt", [h]); if (rc) { if (rc.status !== "0x1") throw new Error("The transaction failed on chain."); break; } }
    await read(); S.msg = { ok: true, text: `You now have ${S.cfg.symbol ?? "USDG"} to test with.`, tx: h };
  } catch (e) { S.msg = { ok: false, text: nice(e) }; }
  S.busy = ""; draw();
}

// ---- drawing ----
const kv = (k, v) => { const r = el("div", "r"); r.append(el("span", "k", k), v instanceof Node ? v : el("span", "v", v)); return r; };
const section = (title, ...kids) => { const s = el("section", "sec"); s.append(el("h3", null, title), ...kids); return s; };

function drawButton() {
  const si = state.session.signedIn, tier = $("#wtier");
  btn.classList.toggle("signed", si && !state.session.needsName); btn.classList.toggle("conn", (!si && !!S.account) || (si && !!state.session.needsName));
  const ss = state.session, named = si && ss.username;
  $("#wlabel").textContent = named ? "@" + ss.username : si ? (ss.needsName ? "Choose a name" : short(ss.address)) : S.account ? short(S.account) : "Connect wallet";
  tier.hidden = !si && !S.account; tier.className = "badge wtier" + (si ? " good" : " accent");
  tier.textContent = si ? (ss.role === "admin" ? "Owner" : "Wallet") : "Sign in";
  btn.setAttribute("aria-label", si ? `Wallet menu. Signed in as ${state.session.address}, ${tier.textContent} tier` : S.account ? `Wallet menu. Connected as ${S.account}, not signed in` : "Connect wallet");
}

function identity() {
  const ss = state.session;
  if (ss.signedIn) {
    const s = section(ss.username ? "@" + ss.username : "Signed in"), addr = el("p", "addr", ss.address); addr.title = "The address you proved you own";
    const t = el("span", "badge good", ss.role === "admin" ? "Owner" : "Wallet");
    s.firstChild.append(" ", t);
    s.append(addr, el("p", "muted small", ss.role === "admin"
      ? "This address is on the node's owner list, so the control panel opens without the admin token."
      : gateway() ? "Your history stays in this browser. Signing in never opens the control panel or the API."
        : "Wallet tier: a larger free quota in the playground. Your chat history stays in this browser. Signing in never opens the control panel or the API."));
    if (state.quota) s.append(kv("Free quota", `${state.quota.limit} requests, ${state.quota.used} used`));
    const act = el("div", "cta2");
    if (ss.role === "admin") { const a = el("a", "btn sm primary", "Open control panel"); a.href = "/app/"; act.append(a); }
    act.append(button(S.busy === "out" ? "Signing out…" : "Sign out", "sm", signOut, S.busy === "out"));
    s.append(act);
    if (S.account && !sameAddr(S.account, ss.address)) {
      s.append(el("p", "small muted", `Your wallet is now on ${short(S.account)}, but this browser is signed in as ${short(ss.address)}.`), button(S.busy === "sign" ? "Check your wallet…" : "Sign in with this account", "sm", signIn, !!S.busy));
    }
    if (gateway() && ss.needsName && ss.role !== "admin") return [s, nameSection()];
    return s;
  }
  if (S.account) {
    return section("Sign in",
      ...(gateway() ? [stepper(2)] : []),
      el("p", "small", "Signing proves you own this address; no transaction, no gas, nothing is approved."),
      el("p", "muted small", gateway() ? "Only free hosted chat requires this account and a name. Market browsing and paid sessions are separate." : "Optional: get a larger free hosted quota. Market browsing and free visitor chat need no wallet; paid peer sessions require a separate deposit."),
      button(S.busy === "sign" ? "Check your wallet…" : "Sign in", "primary sm", signIn, !!S.busy));
  }
  return null;
}

function walletSection() {
  const c = S.cfg;
  if (!S.account) {
    const s = section("Connect with Reown");
    if (gateway() && !state.session.signedIn) s.append(stepper(1));
    s.append(el("p", "muted small", "Choose your wallet in Reown AppKit, or scan a WalletConnect QR code on your phone. Connecting only shares your address; signing in and funding are separate steps."));
    s.append(button(S.busy === "connect" ? "Opening Reown…" : "Choose wallet", "primary", connect, !!S.busy));
    s.append(el("p", "small muted", "Your wallet may ask to switch networks. Sign-in and token approvals always require separate confirmation."));
    return s;
  }
  const s = section("Wallet");
  s.append(kv("Connected", `${short(S.account)} · ${S.name}`));
  if (c) {
    s.append(kv("Network", c.name || "chain " + c.chainId));
    if (!S.chainOk) s.append(button("Switch to " + (c.name || "the network"), "sm", async () => { try { await ensureChain(); await read(); } catch (e) { S.msg = { ok: false, text: nice(e) }; } draw(); }));
    else {
      s.append(kv("ETH (gas)", S.eth == null ? "…" : fmtEth(S.eth)), kv(c.symbol ?? "USDG", S.bal == null ? "…" : fmt(S.bal, c.decimals)));
      if (S.eth === 0n) s.append(el("p", "small muted", c.real ? "This wallet needs ETH on the configured mainnet for transactions. Signing in itself is free." : "You need test ETH for testnet transactions. Signing in itself is free."));
      if (c.isMock) s.append(button(S.busy === "mint" ? "Confirm in your wallet…" : "Get 100 test " + (c.symbol ?? "USDG"), "sm", mint, !!S.busy || S.eth === 0n));
    }
    s.append(kv("Escrow cap", `$${c.maxDepositUsd ?? 20} ${c.symbol ?? "USDG"} / wallet`));
    const net = el("p", "net"); net.append(el("span", "badge " + (c.real ? "warn" : "good"), c.real ? "Mainnet · real money" : "Testnet · no real money")); s.append(net);
  } else s.append(el("p", "small muted", "Settlement is not set up on this node, so there are no balances to show."));
  const a = el("a", null, "Paid models need your own node"); a.href = "#/sell";
  const p = el("p", "small muted", c?.pay ? "To pay peers per token from this wallet, create a pay-per-use session below and deposit into it. " : "This wallet does not pay for chats here. "); if (!c?.pay) p.append(a, ".");
  s.append(p, button("Disconnect", "sm", disconnect));
  return s;
}

function draw() {
  drawButton();
  const had = pop.contains(document.activeElement) || S.refocus; // a redraw replaces the button that had focus: put it back on the new content
  if (document.activeElement === N.input && N.input) return; // preserve the username field and cursor on polls
  body.replaceChildren();
  const id = identity(); if (id) body.append(...[id].flat());
  body.append(walletSection());
  if (S.msg) { const m = el("div", "wmsg" + (S.msg.ok ? "" : " bad"), S.msg.text + " "); m.setAttribute("role", S.msg.ok ? "status" : "alert"); if (S.msg.tx && S.cfg?.explorer) { const a = el("a", null, "View"); a.href = `${S.cfg.explorer}/tx/${S.msg.tx}`; a.target = "_blank"; a.rel = "noopener"; m.append(a); } body.append(m); }
  if (had && !pop.hidden) { body.querySelector("button:not([disabled]), a")?.focus({ preventScroll: true }); if (!S.busy) S.refocus = false; }
  emit("wallet", { account: S.account });
}

// ---- popover ----
function setOpen(open, focus = true) {
  pop.hidden = !open; btn.setAttribute("aria-expanded", String(open));
  if (open) { loadSession(); if (focus) (body.querySelector("button:not([disabled]), a") ?? $("#wallet-x")).focus({ preventScroll: true }); }
  else if (focus) btn.focus({ preventScroll: true });
}

export function initWallet() {
  btn.addEventListener("click", (e) => { e.stopPropagation(); if (!S.account && !state.session.signedIn) connect(); else setOpen(pop.hidden); });
  $("#wallet-x").addEventListener("click", () => setOpen(false));
  document.addEventListener("click", (e) => { if (!pop.hidden && !e.composedPath().includes(pop) && !e.composedPath().includes(btn)) setOpen(false, false); }); // composedPath: the clicked button may already be gone after a redraw
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) { setOpen(false); } });
  pop.addEventListener("focusout", (e) => { if (!pop.hidden && e.relatedTarget && !pop.contains(e.relatedTarget) && e.relatedTarget !== btn) setOpen(false, false); });
  on("wallet:open", () => setTimeout(() => { if (!S.account && !state.session.signedIn) connect(); else setOpen(true); }));
  on("data", draw); // the quota line shows the tier's current limit; the gateway flag arrives with the first poll
  on("pay", draw); // a pay-per-use session appears in or leaves this menu's hint
  onConnection((connection) => { if (connection) attach(connection.provider, connection.address); else clearConnection(); });
  window.addEventListener("focus", () => { if (state.session.signedIn) loadSession(); });
  draw(); loadSession();
  chainCfg().then((c) => { S.cfg = c; }).finally(draw);
}
