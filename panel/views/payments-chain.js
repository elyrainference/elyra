// Escrow panel on Payments: chain status, wallet/escrow rows, deposit/withdraw/mint actions, network settings, voucher tables.
// Redrawn only when the chain snapshot changes and never while the user is typing inside it (focus guard), so forms survive polls.
import { api, post, put } from "../lib/api.js";
import { $, esc } from "../lib/dom.js";
import { ago, shortAddr, usd } from "../lib/format.js";
import { poll } from "../lib/status.js";
import { S } from "../lib/store.js";
import { empty } from "../components/card.js";
import { field, positive, watchField } from "../components/form.js";
import { table } from "../components/table.js";
import { guard, toast } from "../components/toast.js";
import { renderFund } from "./wallet-fund.js";
import { renderFundingSteps } from "./payments-steps.js";

const link = (url, text) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text));

function walletRows(c, chainMode) {
  return `<div class="row"><span class="k">Network</span><span class="v">${esc(c.networkName ?? "—")} · chain ${esc(c.chainId ?? "—")}</span></div>
    <div class="row"><span class="k">Wallet</span><span class="v"><span class="mono">${link(c.walletUrl, c.address)}</span> <button type="button" class="btn sm ghost" data-copy="${esc(c.address)}" aria-label="Copy wallet address">Copy</button></span></div>
    ${c.escrow ? `<div class="row"><span class="k">Escrow contract</span><span class="v"><span class="mono">${link(c.escrowUrl, c.escrow)}</span> ${c.escrowVerified === true ? '<span class="badge tee">Verified · Blockscout</span>' : c.escrowVerified === false ? '<span class="badge">Not verified</span>' : ""}</span></div>` : ""}
    <div class="row"><span class="k">Gas (ETH)</span><span class="v">${c.connected ? Number(c.walletEth).toFixed(5) + " ETH" : '<span class="down">RPC unreachable</span>'}</span></div>
    ${c.token ? `<div class="row"><span class="k">Token</span><span class="v">${esc(c.tokenSymbol)} ${c.isMock ? '<span class="badge sim">MOCK TEST TOKEN</span>' : '<span class="badge tee">REAL</span>'} <span class="mono mut">${esc(c.token.slice(0, 10))}…</span></span></div>
    <div class="row"><span class="k">Wallet ${esc(c.tokenSymbol)}</span><span class="v">${usd(c.tokenUsd)}</span></div>` : ""}
    ${chainMode && c.connected && c.token ? `<div class="row"><span class="k">Escrow deposit</span><span class="v">${usd(c.depositUsd)} <span class="mut">· cap $${esc(c.maxDepositUsd ?? 20)} / wallet</span></span></div>${c.withdrawAt ? `<div class="row"><span class="k">Withdraw unlocks</span><span class="v">${new Date(c.withdrawAt).toLocaleString()}</span></div>` : ""}` : ""}
    ${c.error ? `<div class="note bad">${esc(c.error)}</div>` : ""}
    ${c.connected && !chainMode ? `<div class="note chain">Wallet is reachable but no escrow is configured. Deploy: <code>npm run chain:deploy -- --node-wallet .elyra --mock-token</code> (testnet) then paste the escrow address.</div>` : ""}
    <p class="help" style="margin:14px 0 0">Testnet ETH (gas): ${(c.faucets ?? []).map((f) => `<a href="${esc(f)}" target="_blank" rel="noopener">${esc(new URL(f).host)}</a>`).join(" · ")}</p>`;
}

const fundingControls = (c) =>
  `<div class="sep"></div><div class="form">${c.isMock ? `<div><button type="button" class="btn sm" id="ch-mint">Mint 100 test USDG</button></div>` : ""}
    ${field("ch-dep", `Deposit ${esc(c.tokenSymbol ?? "USDG")} into escrow`, `<div class="inp"><span class="pre">$</span><input class="txt" id="ch-dep" type="number" min="0" max="${esc(c.maxDepositUsd ?? 20)}" step="1" value="10"><button type="button" class="btn primary" id="ch-depgo">Approve + deposit</button></div>`, `Moves funds from the node wallet into the escrow contract (USD). Cap: $${esc(c.maxDepositUsd ?? 20)} per wallet.`)}
    <div class="row-flex"><button type="button" class="btn sm" id="ch-wreq">Request withdraw (1 day delay)</button>${c.withdrawAt ? `<button type="button" class="btn sm" id="ch-wcancel">Cancel</button><input class="txt sm" id="ch-wamt" type="number" step="1" placeholder="USD" aria-label="Withdraw amount in USD" style="max-width:110px"><button type="button" class="btn sm primary" id="ch-wexec">Withdraw</button>` : ""}</div></div>`;

function networkSettings(c, chainMode) {
  const net = (id, label) => `<option value="${id}" ${c.config?.network === id ? "selected" : ""}>${label}</option>`;
  return `<details class="fold" ${chainMode ? "" : "open"}><summary>Network settings</summary><div class="form" style="margin-top:14px">
    ${field("ch-net", "Network", `<select class="txt" id="ch-net">${net("robinhood-testnet", "Robinhood Chain Testnet (46630)")}${net("robinhood-mainnet", "Robinhood Chain Mainnet (4663), needs --allow-mainnet")}${net("local", "Local dev chain (31337)")}</select>`)}
    ${field("ch-esc", "Escrow contract address", `<input class="txt mono" id="ch-esc" placeholder="0x…" value="${esc(c.config?.escrow ?? "")}">`)}
    ${field("ch-rpc", "RPC URL override", `<input class="txt" id="ch-rpc" placeholder="${esc(c.rpcUrl ?? "")}" value="${esc(c.config?.rpcUrl ?? "")}">`, "Prices are dollars and USDG is a dollar stablecoin (6 decimals), so no exchange rate or oracle is involved. ETH is only for gas.", { opt: true })}
    <div><button type="button" class="btn primary" id="ch-save">Save network</button></div></div>
  </details>`;
}

function voucherTables(c) {
  const vo = (c.vouchersOut ?? []).map((v) => `<tr><td>${esc(v.peer)}</td><td class="mono mut">${esc(shortAddr(v.providerAddress, 10, 0))}</td><td class="r">${usd(v.cumulativeUsd)}</td><td class="mut">${ago(v.ts)}</td></tr>`);
  const vi = (c.vouchersIn ?? []).map((v) => `<tr><td>${esc(v.peer)}</td><td class="mono mut">${esc(shortAddr(v.consumerAddress, 10, 0))}</td><td class="r">${usd(v.claimableUsd)}</td><td class="r ${v.exposureUsd ? "warn" : ""}">${usd(v.exposureUsd)}</td></tr>`);
  return `<div class="sep"></div><div class="grid g2"><div><h3 class="t">Vouchers you signed (consumer)</h3>${vo.length ? `<div class="tablewrap">${table(["Provider", "Wallet", ["Cumulative", "r"], "When"], vo)}</div>` : '<p class="help" style="margin:0">None yet.</p>'}</div>
    <div><h3 class="t">Vouchers you can redeem (provider)</h3>${vi.length ? `<div class="tablewrap">${table(["Consumer", "Wallet", ["Claimable", "r"], ["Unvouchered", "r"]], vi)}</div>` : '<p class="help" style="margin:0">None yet.</p>'}</div></div>`;
}

const modeNote = (c, chainMode) =>
  chainMode
    ? `<div class="note ok" style="margin:0"><b>On-chain settlement is live on ${esc(c.networkName)}</b>${c.real ? " — <b>Real funds</b>" : " (testnet)"}. Consumers sign vouchers, providers redeem them from the escrow contract and pay the gas. Simulated peers are never settled.</div>`
    : `<div class="note chain" style="margin:0"><b>Settlement is simulated.</b> Receipts are real and verified (ed25519), but no transaction is broadcast. Configure the escrow below to settle on Robinhood Chain.</div>`;

// wires a button to an action; afterwards the snapshot is invalidated so the panel and ledger refresh
function bindActions(view) {
  const run = (id, fn) => { const el = $("#" + id); if (el) el.onclick = guard(async () => { await fn(); view.ck = null; await view.tick(); poll(); }); };
  run("ch-save", async () => { await put("/api/chain", { network: $("#ch-net").value, escrow: $("#ch-esc").value.trim(), rpcUrl: $("#ch-rpc").value.trim() }); toast("Network settings saved", "ok"); });
  const dep = $("#ch-dep"), depOk = dep ? watchField(dep, positive) : () => true;
  run("ch-depgo", async () => { if (!depOk()) throw new Error("Enter an amount above 0."); toast("Approving + depositing…"); const t = await post("/api/chain/deposit", { usd: +$("#ch-dep").value }); toast("Deposit confirmed · " + t.hash.slice(0, 12) + "…", "ok"); });
  run("ch-wreq", async () => { await post("/api/chain/withdraw", { action: "request" }); toast("Withdrawal requested", "ok"); });
  run("ch-wcancel", async () => { await post("/api/chain/withdraw", { action: "cancel" }); toast("Withdrawal cancelled", "ok"); });
  run("ch-wexec", async () => { await post("/api/chain/withdraw", { action: "execute", usd: +$("#ch-wamt").value }); toast("Withdrawn", "ok"); });
  run("ch-mint", async () => { toast("Minting test USDG…"); await post("/api/chain/mint", { usd: 100 }); toast("Minted 100 test USDG", "ok"); });
}

export async function renderChain(view) {
  const c = await api("/api/chain");
  renderFund(c); // its own card: independent of the redraw guard below
  view.snap = c; view.alerts(); // alerts and the funding steps follow every snapshot, also when the escrow card below is left alone
  renderFundingSteps(c, S.status, view);
  const key = JSON.stringify([c.mode, c.connected, c.error, c.escrow, c.walletEth, c.depositEth, c.withdrawAt, c.vouchersOut, c.vouchersIn, c.config, c.maxDepositUsd]);
  if (key === view.ck || $("#pay-chain").contains(document.activeElement)) return;
  view.ck = key;
  const chainMode = c.mode === "chain";
  $("#pay-mode").innerHTML = modeNote(c, chainMode);
  $("#pay-chain").innerHTML = `
    <h3>Escrow · Robinhood Chain <span class="badge ${chainMode ? "tee" : "sim"}">${chainMode ? "CHAIN MODE" : "SIM MODE"}</span></h3>
    ${!c.available ? empty("Chain adapter unavailable", esc(c.error)) : `
    <div class="grid g2">
      <div>${walletRows(c, chainMode)}${chainMode ? fundingControls(c) : ""}</div>
      <div>${networkSettings(c, chainMode)}</div>
    </div>
    ${chainMode ? voucherTables(c) : ""}`}`;
  bindActions(view);
}
