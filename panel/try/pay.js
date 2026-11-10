// Pay-per-use from the visitor's own wallet, non-custodial. The page holds a SESSION key (a throwaway key kept in this browser). The visitor
// deposits into the escrow for the session address, so only the session key can sign vouchers or take the money back out. This node relays
// the chat to a seller and hands back the seller's receipt amount; THIS PAGE signs the voucher, after checking the amount against the price
// the visitor accepted. No dependency except the ethers-only module /try/session.js, loaded when a session is first created or used.
// Pay sessions need no account: they are separate from the wallet sign-in (auth.js). The per-wallet deposit cap comes from /pub/chain.maxDepositUsd.
// All server text goes through textContent.
import { $, el, emit, short, chainCfg } from "./lib.js";
import { walletApi } from "./wallet.js";

const body = $("#pay-body"), adv = $("#pay-adv");
  const KEY = "elyra.session.v1";
  const SEL = { allowance: "0xdd62ed3e", approve: "0x095ea7b3", depositFor: "0x2f4f21e2" };
  const pad = (h) => String(h).replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const usd = (units, dec) => { const n = Number(units) / 10 ** dec; return "$" + (n === 0 ? "0.00" : n >= 1 ? n.toFixed(2) : n.toFixed(n >= 0.01 ? 4 : 6)); };
  const nice = (e) => (e && (e.code === 4001 || e.code === "ACTION_REJECTED" || /reject|denied/i.test(e.message || "")) ? "Cancelled in your wallet." : String(e?.shortMessage || e?.message || e).slice(0, 200));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jfetch = async (url, opt) => { const r = await fetch(url, opt); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error?.message || `Request failed (${r.status})`); return j; };

  const P = { cfg: null, mod: null, s: load(), pos: null, chainPos: null, busy: "", msg: null };
  function load() { try { const j = JSON.parse(localStorage.getItem(KEY) || "null"); return j && /^0x[0-9a-fA-F]{64}$/.test(j.key) ? { cum: {}, ...j } : null; } catch { return null; } }
  const save = () => { try { if (P.s) localStorage.setItem(KEY, JSON.stringify(P.s)); else localStorage.removeItem(KEY); } catch { /* storage blocked: the session lives until the tab closes */ } };
  const changed = () => emit("pay");
  const lib = async () => (P.mod ??= await import("/try/session.js"));
  const dec = () => P.cfg?.decimals ?? 6;
  const symbol = () => P.cfg?.symbol ?? "USDG";
  const capUsd = () => (Number(P.cfg?.maxDepositUsd) > 0 ? Number(P.cfg.maxDepositUsd) : 20);
  const capUnits = () => BigInt(Math.round(capUsd() * 10 ** dec()));

  /** price the visitor accepts for a model: the dearest peer offer in the market, as shown there (never more) */
  function quote(model, market) {
    const g = market?.models?.find((x) => x.model === model);
    const peers = (g?.offers ?? []).filter((o) => o.where === "peer" && o.price != null);
    return peers.length ? Math.max(...peers.map((o) => o.price)) : null;
  }
  const priceLimit = (model, market) => { const p = quote(model, market); return p == null ? null : +(p * 1.05).toFixed(6); };

  async function create() {
    P.busy = "create"; P.msg = null; draw();
    try { const m = await lib(), key = m.newKey(); P.s = { key, address: m.addressOf(key), proofs: { [P.cfg.nodeId]: await m.bindingProof(key, P.cfg.nodeId) }, cum: {}, spentUnits: "0", created: Date.now() }; save(); await refresh(); }
    catch (e) { P.msg = { ok: false, text: nice(e) }; }
    P.busy = ""; draw(); changed();
  }
  async function proof() { if (!P.s.proofs[P.cfg.nodeId]) { P.s.proofs[P.cfg.nodeId] = await (await lib()).bindingProof(P.s.key, P.cfg.nodeId); save(); } return P.s.proofs[P.cfg.nodeId]; }
  async function refresh() {
    if (!P.s || !P.cfg) return;
    try { P.pos = await jfetch(`/pub/session?wallet=${P.s.address}`); } catch { /* keep the last value */ }
    draw(); changed();
  }
  async function chainPosition() { P.chainPos = await (await lib()).position(P.s.key, P.cfg, P.s.cum); return P.chainPos; }

  // ---- funding: the visitor's own wallet pays; the session address is credited in the escrow ----
  const wreq = (m, p) => walletApi.request(m, p);
  async function mined(h) { for (let i = 0; i < 60; i++) { const rc = await wreq("eth_getTransactionReceipt", [h]); if (rc) { if (rc.status !== "0x1") throw new Error("The transaction failed on chain."); return; } await sleep(2000); } throw new Error("The transaction is taking too long. Check your wallet."); }
  const unitsOf = (s) => { const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(s).trim()); if (!m) throw new Error("Enter an amount like 1 or 0.5"); const u = BigInt(m[1]) * 10n ** BigInt(dec()) + BigInt((m[2] ?? "").padEnd(dec(), "0")); if (u <= 0n) throw new Error("Amount must be above zero"); return u; };
  async function fund(amountText) {
    const w = walletApi; if (!w?.account) { P.msg = { ok: false, text: "Connect your wallet first (Wallet button, top right)." }; return draw(); }
    P.busy = "fund"; P.msg = null; draw();
    try {
      const units = unitsOf(amountText), c = P.cfg, cap = capUnits();
      const curDep = P.pos ? BigInt(P.pos.depositUnits) : 0n;
      if (units > cap || curDep + units > cap) throw new Error(`Deposit exceeds the $${capUsd()} ${symbol()} per-wallet cap${curDep > 0n ? ` (session already holds ${usd(curDep, dec())} in escrow)` : ""}.`);
      await w.ensureChain();
      const bal = BigInt(await wreq("eth_call", [{ to: c.token, data: "0x70a08231" + pad(w.account) }, "latest"]));
      if (bal < units) throw new Error(`Your wallet holds ${usd(bal, dec())} ${symbol()}, less than this deposit. ${c.isMock ? "Use “Get 100 test USDG” in the wallet card first." : ""}`);
      const allow = BigInt(await wreq("eth_call", [{ to: c.token, data: SEL.allowance + pad(w.account) + pad(c.escrow) }, "latest"]));
      if (allow < units) { P.busy = "approve"; draw(); await mined(await wreq("eth_sendTransaction", [{ from: w.account, to: c.token, data: SEL.approve + pad(c.escrow) + pad(units.toString(16)) }])); }
      P.busy = "deposit"; draw();
      await mined(await wreq("eth_sendTransaction", [{ from: w.account, to: c.escrow, data: SEL.depositFor + pad(P.s.address) + pad(units.toString(16)) }]));
      P.msg = { ok: true, text: `Deposited ${usd(units, dec())} for this session.` };
    } catch (e) { P.msg = { ok: false, text: nice(e) }; }
    P.busy = ""; await refresh();
  }
  async function addGas(ethText) {
    const w = walletApi; if (!w?.account) { P.msg = { ok: false, text: "Connect your wallet first." }; return draw(); }
    P.busy = "gas"; P.msg = null; draw();
    try { const wei = BigInt(Math.round(Number(ethText) * 1e6)) * 10n ** 12n; if (wei <= 0n || wei > 10n ** 17n) throw new Error("Enter between 0.000001 and 0.1 ETH"); await w.ensureChain(); await mined(await wreq("eth_sendTransaction", [{ from: w.account, to: P.s.address, value: "0x" + wei.toString(16) }])); P.msg = { ok: true, text: "Gas sent to the session address." }; }
    catch (e) { P.msg = { ok: false, text: nice(e) }; }
    P.busy = ""; await chainPosition().catch(() => {}); draw();
  }

  // ---- paying for chats ----
  /** what try.js needs to send a paid chat. Throws a readable error when it cannot. */
  async function request(model, messages, market) {
    if (!P.s || !P.cfg?.pay) throw new Error("Create a pay-per-use session first (Wallet button).");
    const maxPrice = quote(model, market); if (maxPrice == null) throw new Error("No peer sells this model right now.");
    const vouchers = {}; for (const [k, v] of Object.entries(P.s.cum)) vouchers[k] = { cumulative: v.cumulative, sig: v.sig };
    const chars = messages.reduce((a, m) => a + m.content.length, 0), maxTokens = 512;
    return { url: "/pub/paid-chat", maxPrice: priceLimit(model, market), chars, maxTokens, body: { session: { wallet: P.s.address, proof: await proof() }, model, maxPrice: priceLimit(model, market), messages, vouchers, max_tokens: maxTokens } };
  }
  /** the seller's verified receipt came back: sign the voucher, but only for an amount that fits the price the visitor accepted */
  async function settle(pay, spec) {
    const bound = BigInt(Math.ceil(spec.maxPrice * (spec.chars + spec.maxTokens) * 1.1)) + 10n; // units: $ per M tokens x tokens, an upper bound with one token per character
    const amount = BigInt(pay.amountUnits);
    if (!(Number(pay.price) <= spec.maxPrice + 1e-9) || amount > bound) return { refused: `The seller asked for ${usd(amount, dec())}, more than the price you accepted allows. Nothing was signed.` };
    const key = String(pay.providerWallet).toLowerCase(), prev = P.s.cum[key];
    const base = prev ? BigInt(prev.cumulative) : BigInt(pay.claimedUnits); // your own record is the baseline; only a fresh browser trusts the node's figure
    const cumulative = (base + amount).toString();
    const sig = await (await lib()).signVoucher(P.s.key, P.cfg, pay.providerWallet, cumulative);
    P.s.cum[key] = { cumulative, sig, providerId: pay.providerId, pushed: false }; P.s.spentUnits = (BigInt(P.s.spentUnits) + amount).toString(); save();
    let accepted = false;
    try { accepted = (await jfetch("/pub/voucher", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: { wallet: P.s.address, proof: await proof() }, providerId: pay.providerId, cumulative, sig }) })).accepted === true; } catch { /* it rides along with the next request */ }
    if (accepted) { P.s.cum[key].pushed = true; save(); }
    refresh(); return { amountUnits: amount.toString(), usd: Number(amount) / 10 ** dec(), accepted };
  }

  // ---- taking the money back: the session key moves its own deposit (it needs a little gas ETH on the session address) ----
  async function wd(step) {
    P.busy = "wd"; P.msg = null; draw();
    try {
      const m = await lib(), pos = await chainPosition(), now = pos.now;
      if (BigInt(pos.eth) === 0n) throw new Error("The session address has no gas. Use “Add gas” first (a few cents of ETH).");
      if (step === "request") { await m.requestWithdraw(P.s.key, P.cfg); P.msg = { ok: true, text: "Withdrawal requested. It can be completed after the 1-day delay." }; }
      else if (step === "cancel") { await m.cancelWithdraw(P.s.key, P.cfg); P.msg = { ok: true, text: "Withdrawal cancelled." }; }
      else if (step === "finish") {
        if (!pos.withdrawAt) throw new Error("Request the withdrawal first."); if (now < pos.withdrawAt) throw new Error("Not yet: the delay ends " + new Date(pos.withdrawAt * 1000).toLocaleString() + " (chain time).");
        const w = walletApi; if (!w?.account) throw new Error("Connect your wallet: the money is sent to it.");
        const free = BigInt(pos.deposit) - BigInt(pos.owed); // vouchers the session signed stay in the escrow until the sellers collect them
        if (free <= 0n) throw new Error(`Everything left (${usd(pos.deposit, dec())}) is owed to sellers for chats you already used. They collect it themselves.`);
        await m.withdraw(P.s.key, P.cfg, free.toString()); await m.sendToken(P.s.key, P.cfg, w.account, free.toString());
        P.msg = { ok: true, text: `Sent ${usd(free, dec())} ${symbol()} to your wallet.${BigInt(pos.owed) > 0n ? ` ${usd(pos.owed, dec())} stays in the escrow for sellers to collect.` : ""}` };
      }
    } catch (e) { P.msg = { ok: false, text: nice(e) }; }
    P.busy = ""; await chainPosition().catch(() => {}); await refresh();
  }
  function exportKey() { const t = el("textarea"); t.value = P.s.key; t.readOnly = true; t.rows = 2; t.className = "keybox"; return t; }
  function forget() { if (!confirm("Delete this session from the browser? Any money still in the escrow can only be recovered with the session key. Export it first.")) return; P.s = null; P.pos = null; P.chainPos = null; save(); P.msg = null; draw(); changed(); }

  function draw() {
    if (document.activeElement?.tagName === "INPUT" && body.contains(document.activeElement)) return; // typing an amount: a redraw would take the cursor away
    body.replaceChildren();
    const c = P.cfg; if (adv) adv.hidden = !c?.pay; if (!c?.pay) return;
    body.append(el("div", "pay-h", "Pay-per-use session"));
    if (!P.s) {
      body.append(el("p", "muted small", "1 · Create a session key here. 2 · Connect a wallet and approve + deposit USDG for that session. 3 · Review a paid model in Playground and send. Sign-in is separate and is not required for paid sessions. No transaction happens when you create the key."));
      body.append(el("p", "small warn", `Escrow cap: $${capUsd()} ${symbol()} per wallet. Save the session key before clearing browser data: only this key can spend or recover its deposit. Withdrawal has a 1-day delay and needs ETH on the session address.`));
      const b = el("button", "btn primary sm", P.busy === "create" ? "Creating…" : "Create session"); b.type = "button"; b.disabled = !!P.busy; b.addEventListener("click", create); body.append(b);
    } else {
      const k = (a, v) => { const r = el("div", "r"); r.append(el("span", "k", a), v instanceof Node ? v : el("span", "v", v)); return r; };
      const dep = P.pos ? BigInt(P.pos.depositUnits) : null;
      body.append(k("Session", short(P.s.address)), k("In escrow", dep == null ? "…" : `${usd(dep, dec())} / $${capUsd()} ${symbol()} cap`), k("Signed this session", usd(P.s.spentUnits, dec())));
      body.append(el("p", "small muted", `Funding is optional and only for paid peers. A deposit can require two wallet transactions: token approval, then escrow deposit. Cap: $${capUsd()} ${symbol()}. Signed usage is this browser session's record, not global buyer activity. Keep the key to recover unspent funds.`));
      const busy = { approve: "Approve in your wallet…", deposit: "Confirm the deposit in your wallet…", gas: "Sending gas…", wd: "Working…", fund: "Checking your wallet…", create: "" }[P.busy];
      const row = el("div", "pay-row"); const inp = el("input", "txt"); inp.type = "number"; inp.min = "0"; inp.max = String(capUsd()); inp.step = "any"; inp.placeholder = "1.00"; inp.setAttribute("aria-label", `Amount to deposit (max $${capUsd()})`); inp.disabled = !!P.busy;
      const fb = el("button", "btn primary sm", "Deposit"); fb.type = "button"; fb.disabled = !!P.busy; fb.addEventListener("click", () => fund(inp.value)); row.append(inp, fb); body.append(row);
      if (busy) body.append(el("div", "muted small", busy));
      const more = el("details", "pay-more"); more.append(el("summary", null, "Withdraw, gas and key"));
      const pos = P.chainPos; more.append(el("p", "small muted", pos ? `Gas on the session address: ${(Number(pos.eth) / 1e18).toFixed(5)} ETH. Owed to sellers, not yet collected: ${usd(pos.owed, dec())} (stays in the escrow). ${pos.withdrawAt ? "Withdrawal available after " + new Date(pos.withdrawAt * 1000).toLocaleString() + "." : ""}` : "To take money back the session needs a few cents of gas ETH, because only the session key can move its deposit."));
      const gr = el("div", "pay-row"); const gi = el("input", "txt"); gi.type = "number"; gi.step = "any"; gi.placeholder = "0.002 ETH"; gi.setAttribute("aria-label", "ETH for gas"); const gb = el("button", "btn ghost sm", "Add gas"); gb.type = "button"; gb.disabled = !!P.busy; gb.addEventListener("click", () => addGas(gi.value || "0.002")); gr.append(gi, gb); more.append(gr);
      const wr = el("div", "pay-row");
      for (const [label, step] of [["Request withdrawal", "request"], ["Finish withdrawal", "finish"], ["Cancel", "cancel"]]) { const b = el("button", "btn ghost sm", label); b.type = "button"; b.disabled = !!P.busy; b.addEventListener("click", () => wd(step)); wr.append(b); }
      more.append(wr);
      const kb = el("button", "btn ghost sm", "Show session key"); kb.type = "button"; kb.addEventListener("click", () => { kb.replaceWith(el("p", "small warn", "Anyone with this key can spend the session's money. Keep it private."), exportKey()); });
      const fg = el("button", "btn ghost sm", "Delete session"); fg.type = "button"; fg.addEventListener("click", forget);
      const kr = el("div", "pay-row"); kr.append(kb, fg); more.append(kr); body.append(more);
      wr.hidden = false;
    }
    if (P.msg) body.append(el("div", "wmsg" + (P.msg.ok ? "" : " bad"), P.msg.text));
    body.append(el("p", "small muted", `${c.real ? "Mainnet · real money · unaudited contracts." : c.isMock ? "Mock test token · no real money." : "Test / development network · check the token before funding."} Your key never leaves this browser; the node only relays the chat and the seller's receipt.`));
  }

/** what chat.js and market.js need: is a funded session there, may a model be paid for, and send/settle one paid chat */
export const pay = {
  get enabled() { return !!P.cfg?.pay; }, get ready() { return !!P.s; }, get depositUnits() { return P.pos ? BigInt(P.pos.depositUnits) : 0n; },
  funded() { return !!P.s && !!P.pos && BigInt(P.pos.depositUnits) > 0n; }, payable: (model, market) => quote(model, market) != null,
  request, settle, refresh, priceLimit, usd: (u) => usd(u, dec()),
};
export async function initPay() {
  P.cfg = await chainCfg();
  draw(); if (P.s && P.cfg?.pay) { refresh(); setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 20000); }
  changed();
}
