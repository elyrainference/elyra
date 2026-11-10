// "Fund from your wallet" card on Payments. The visitor's wallet pays; this node's address is credited in the escrow (depositFor).
// The wallet bundle (Reown AppKit + ethers, ~4.7 MB, 1.3 MB gzip) is loaded only when the visitor presses Connect, and only if the node has
// ELYRA_REOWN_PROJECT_ID. State lives here so it survives the Payments re-draws.
import { $, esc } from "../lib/dom.js";
import { shortAddr, usd } from "../lib/format.js";
import { toast } from "../components/toast.js";

const S = { kit: null, address: null, bal: null, busy: "", msg: null, sig: "" };
let lastC = null;

const bundleUrl = () => new URL("../vendor/wallet.js", import.meta.url).href;
const link = (url, text) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text));
const cfgOf = (c) => ({ token: c.token, escrow: c.escrow, node: c.address, decimals: c.tokenDecimals ?? 6, maxDepositUsd: c.maxDepositUsd ?? 20 });
const nice = (e) => (e?.code === "ACTION_REJECTED" || e?.code === 4001 || /user (rejected|denied)/i.test(e?.message ?? "") ? "Cancelled in your wallet." : (e?.shortMessage ?? e?.message ?? String(e)).slice(0, 220));

function html(c) {
  const wc = c.walletConnect?.projectId;
  if (!wc) return `<h3>Fund from your wallet</h3><p class="help" style="margin:0">Not enabled on this node. Set <code>ELYRA_REOWN_PROJECT_ID</code> to let visitors connect a wallet and fund the escrow. See the Wallet and USDG page in the docs.</p>`;
  if (c.mode !== "chain") return `<h3>Fund from your wallet</h3><p class="help" style="margin:0">Configure the escrow under Network settings first. Then you can connect a wallet and deposit from it.</p>`;
  const cap = c.maxDepositUsd ?? 20;
  const head = `<h3>Fund from your wallet <span class="badge ${c.real ? "warn" : "sim"}">${c.real ? "MAINNET" : "TESTNET"}</span></h3>`;
  const note = `<div class="note chain">The deposit is credited to <b>this node</b> (${esc(shortAddr(c.address, 8, 4))}) and pays for the requests it makes. Per-wallet escrow cap: <b>$${esc(cap)} ${esc(c.tokenSymbol ?? "USDG")}</b> while the contract is unaudited. Only the node's own key can withdraw it. Your wallet never signs requests or sees your prompts.</div>`;
  if (!S.address) {
    return `${head}<p class="help" style="margin:0 0 14px">Pay from MetaMask, Rainbow, Coinbase Wallet and others, on desktop or by QR from your phone.</p>
      <button type="button" class="btn primary" id="fw-connect" ${S.busy ? "disabled" : ""}>${S.busy === "load" ? "Loading wallet…" : "Connect wallet"}</button>${S.msg && !S.msg.ok ? `<div class="note bad">${S.msg.text}</div>` : ""}${note}`;
  }
  const b = S.bal;
  const busyLabel = { approve: "Approve in your wallet…", deposit: "Confirm the deposit in your wallet…", mint: "Minting…", read: "Reading balance…" }[S.busy];
  return `${head}
    <div class="row"><span class="k">Connected wallet</span><span class="v">${link(c.explorer && `${c.explorer}/address/${S.address}`, shortAddr(S.address, 8, 6))} <button type="button" class="btn sm ghost" id="fw-disc">Disconnect</button></span></div>
    <div class="row"><span class="k">Network</span><span class="v">${esc(c.networkName ?? "")} · chain ${esc(c.chainId)}</span></div>
    <div class="row"><span class="k">Your ${esc(c.tokenSymbol ?? "USDG")}</span><span class="v">${b ? usd(b.usd) : "…"}</span></div>
    <div class="row"><span class="k">Escrow deposit of this node</span><span class="v">${b ? usd(b.nodeDepositUsd) : usd(c.depositUsd)} <span class="mut">· cap $${esc(cap)}</span></span></div>
    <div class="field" style="margin-top:14px"><label for="fw-amt">Amount to deposit (USD · max $${esc(cap)} per wallet)</label>
    <div class="inp"><input class="txt" id="fw-amt" type="number" min="0" max="${esc(cap)}" step="any" placeholder="10" ${S.busy ? "disabled" : ""}><button type="button" class="btn primary" id="fw-dep" ${S.busy ? "disabled" : ""}>Deposit from my wallet</button></div></div>
    ${c.isMock ? `<div style="margin-top:10px"><button type="button" class="btn sm" id="fw-mint" ${S.busy ? "disabled" : ""}>Get 100 test ${esc(c.tokenSymbol ?? "USDG")} in my wallet</button> <span class="mut" style="font-size:12.5px">test token, no value</span></div>` : ""}
    ${busyLabel ? `<p class="help" style="margin:12px 0 0">${esc(busyLabel)}</p>` : ""}
    ${S.msg ? `<div class="note ${S.msg.ok ? "ok" : "bad"}">${S.msg.text}</div>` : ""}${note}`;
}

async function load(c) {
  if (S.kit) return S.kit;
  S.busy = "load"; draw(c);
  try {
    const m = await import(bundleUrl());
    S.kit = m.init({ projectId: c.walletConnect.projectId, chainId: c.chainId, name: c.networkName, rpcUrl: c.rpcUrl, explorer: c.explorer, real: c.real });
    S.kit.onAccount(({ address, connected }) => { const was = S.address; S.address = connected ? address : null; if (!connected) { S.bal = null; S.msg = null; } if (S.address && S.address !== was) refresh(); else draw(); });
    return S.kit;
  } finally { S.busy = ""; }
}

async function refresh() {
  if (!S.address || !lastC) return;
  try { S.bal = await S.kit.balances(cfgOf(lastC)); } catch (e) { S.msg = { ok: false, text: esc(nice(e)) }; }
  draw();
}

const txLinks = (c, hashes) => hashes.map((h) => (c.explorer ? `<a href="${esc(c.explorer)}/tx/${esc(h)}" target="_blank" rel="noopener">${esc(h.slice(0, 12))}…</a>` : esc(h.slice(0, 12) + "…"))).join(" · ");

async function act(kind) {
  const c = lastC;
  S.msg = null; 
  try {
    if (kind === "deposit") {
      const amt = $("#fw-amt").value.trim();
      const cap = c.maxDepositUsd ?? 20, cur = S.bal?.nodeDepositUsd ?? c.depositUsd ?? 0;
      if (Number(amt) > cap || cur + Number(amt) > cap + 1e-6) throw new Error(`Deposit exceeds the $${cap} per-wallet cap (this node already has $${Number(cur).toFixed(2)} in escrow).`);
      if (c.real && !confirm(`This is MAINNET with real funds. You are depositing $${amt} to the node ${c.address}.\n\nThe escrow contract is not independently audited. Continue?`)) return;
      S.busy = "approve"; draw();
      const r = await S.kit.deposit(cfgOf(c), amt, (s) => { S.busy = s; draw(); });
      S.msg = { ok: true, text: `Deposited $${esc(amt)}. ${txLinks(c, r.hashes)}` }; toast("Deposit confirmed", "ok");
    } else if (kind === "mint") {
      S.busy = "mint"; draw();
      const r = await S.kit.mintTest(cfgOf(c), "100");
      S.msg = { ok: true, text: `Minted 100 test tokens. ${txLinks(c, [r.hash])}` }; toast("Minted 100 test tokens", "ok");
    }
  } catch (e) { S.msg = { ok: false, text: esc(nice(e)) }; }
  S.busy = "";
  await refresh();
}

function draw() {
  const el = $("#pay-wallet");
  if (!el || !lastC) return;
  if (el.contains(document.activeElement) && document.activeElement.tagName === "INPUT" && !S.busy) return; // never wipe what the visitor is typing
  const h = html(lastC);
  if (el.dataset.h === h) return;
  el.dataset.h = h; el.innerHTML = h;
  const on = (id, fn) => { const b = $("#" + id); if (b) b.onclick = fn; };
  on("fw-connect", async () => { S.msg = null; try { const kit = await load(lastC); kit.open(); } catch (e) { S.msg = { ok: false, text: esc("Could not load the wallet component: " + nice(e)) }; draw(); } });
  on("fw-disc", async () => { await S.kit?.disconnect(); });
  on("fw-dep", () => act("deposit"));
  on("fw-mint", () => act("mint"));
}

/** called from renderChain with the latest /api/chain snapshot */
export function renderFund(c) {
  const el = $("#pay-wallet");
  if (!el) return;
  if (!c.available) { el.hidden = true; return; }
  el.hidden = false; lastC = c;
  draw();
}
