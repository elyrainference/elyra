// Guided funding on Payments (buyer): 1 gas (ETH), 2 USDG in the node wallet, 3 deposit into the escrow. Every step is derived from the
// live /api/chain snapshot and /api/status; nothing is stored. The first unfinished step is NEXT; once all three are done the card collapses
// to one line. The advanced form (payments-chain.js) stays below and is untouched. Only chain mode needs funding: in sim mode the card is hidden.
// Redrawn only when the facts it shows change and never while the user is typing in it, so the deposit amount survives refreshes.
import { post } from "../lib/api.js";
import { $, esc } from "../lib/dom.js";
import { shortAddr, usd } from "../lib/format.js";
import { poll } from "../lib/status.js";
import { guard, toast } from "../components/toast.js";
import { fundingFacts, MIN_ESCROW_USD } from "./alerts.js";

const host = (u) => { try { return new URL(u).host; } catch { return u; } };
let snap = null; // latest chain snapshot: handlers bound once per redraw must not validate against a stale one

function stepHtml({ no, title, desc, done, next, acts = "" }) {
  return `<div class="step ${done ? "done" : ""} ${next ? "next" : ""}"><span class="no">${done ? "✓" : no}</span><div><h4>${title}${next ? ' <span class="badge live">Next</span>' : ""}</h4><p>${desc}</p></div>${!done && acts ? `<div class="acts">${acts}</div>` : ""}</div>`;
}

function build(c, st) {
  const f = fundingFacts(st, c), sym = esc(c.tokenSymbol ?? "USDG"), addr = esc(c.address);
  const faucets = c.network === "robinhood-testnet" ? c.faucets ?? [] : [];
  const tokenOk = f.tokenUsd > 0 || f.depositUsd > 0, depOk = f.escrowOk;
  const next = !f.gasOk ? 1 : !tokenOk ? 2 : !depOk ? 3 : 0;
  const wc = !!c.walletConnect?.projectId;
  const steps = [
    {
      no: 1, done: f.gasOk, next: next === 1,
      title: "Get gas (ETH)",
      desc: f.gasOk
        ? `The node wallet holds ${f.gasEth.toFixed(5)} ETH, enough for gas.`
        : `Deposits cost a little ETH for gas. The node wallet <code>${esc(shortAddr(c.address, 8, 4))}</code> holds ${f.gasEth.toFixed(5)} ETH. ${faucets.length ? `Copy the address, then request test ETH from a faucet${faucets.length > 1 ? ` (others: ${faucets.slice(1).map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(host(u))}</a>`).join(", ")})` : ""}.` : "Send a little ETH on this network to the wallet address."}`,
      acts: `${faucets[0] ? `<a class="btn sm ${next === 1 ? "primary" : ""}" href="${esc(faucets[0])}" target="_blank" rel="noopener">Open faucet</a>` : ""}<button type="button" class="btn sm" data-copy="${addr}">Copy address</button>`,
    },
    {
      no: 2, done: tokenOk, next: next === 2,
      title: `Get ${sym} ${c.isMock ? '<span class="badge sim">MOCK TEST TOKEN</span>' : ""}`,
      desc: tokenOk
        ? `The node wallet holds ${usd(f.tokenUsd)} ${sym}${f.depositUsd > 0 ? ` and ${usd(f.depositUsd)} is in the escrow` : ""}.`
        : c.isMock
          ? `This network uses an open-mint <b>MockUSDG</b> that is worth nothing: mint some to try paid models${wc ? ", or fund from your own wallet" : ""}.${f.gasOk ? "" : " Needs gas first (step 1)."}`
          : `Send ${sym} on ${esc(c.networkName ?? "this network")} to the node wallet address${wc ? ", or fund the escrow straight from your own wallet" : ""}.`,
      acts: `${c.isMock ? `<button type="button" class="btn sm ${next === 2 ? "primary" : ""}" id="pf-mint" ${f.gasOk ? "" : 'disabled title="Needs ETH for gas first"'}>Mint 100 test ${sym}</button>` : `<button type="button" class="btn sm" data-copy="${addr}">Copy address</button>`}${wc ? '<button type="button" class="btn sm" data-focus="pay-wallet">Fund from your wallet</button>' : ""}`,
    },
    {
      no: 3, done: depOk, next: next === 3,
      title: "Deposit into the escrow",
      desc: depOk
        ? `${usd(f.escrowUsd)} is spendable in the escrow. Providers are paid from it as you use paid models.`
        : `Moves ${sym} from the node wallet into the escrow contract, which pays providers as you use paid models. Spendable now: ${usd(f.escrowUsd)}; at least $${MIN_ESCROW_USD} is recommended.${tokenOk ? "" : " Needs " + sym + " first (step 2)."}`,
      acts: `<span class="inp"><span class="pre">$</span><input class="txt" id="pf-dep" type="number" min="0" step="1" value="${Math.max(1, Math.min(10, Math.floor(f.tokenUsd)))}" aria-label="Amount to deposit in USD" ${tokenOk && f.gasOk ? "" : "disabled"}></span><button type="button" class="btn sm ${next === 3 ? "primary" : ""}" id="pf-depgo" ${tokenOk && f.gasOk ? "" : "disabled"}>Approve + deposit</button>`,
    },
  ];
  return { f, steps, done: steps.filter((s) => s.done).length, list: steps.map(stepHtml).join("") };
}

/** Draw into #pay-steps from the latest chain snapshot `c` and status `st`. `view` is the Payments view (refreshed after an action). */
export function renderFundingSteps(c, st, view) {
  const el = $("#pay-steps");
  if (!el) return;
  snap = c;
  if (c.mode !== "chain" || !c.address) { el.hidden = true; return; }
  el.hidden = false;
  if (el.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
  const head = `<h3>Fund this node <span class="badge ${c.real ? "warn" : "sim"}">${c.real ? "MAINNET" : "TESTNET"}</span></h3>`;
  let html;
  if (!c.connected) {
    html = `${head}<div class="note chain" style="margin-top:0">The RPC is not answering${c.error ? ": " + esc(c.error) : ""}. The steps come back when the network does.</div>`;
  } else {
    const { f, steps, done, list } = build(c, st);
    html = done === steps.length
      ? `<details class="fold"><summary><span class="fund-done">Funded <span class="badge ok">Gas ${f.gasEth.toFixed(4)} ETH</span><span class="badge ok">${usd(f.tokenUsd)} ${esc(c.tokenSymbol ?? "USDG")}</span><span class="badge ok">Escrow ${usd(f.escrowUsd)}</span>${c.isMock ? '<span class="badge sim">MOCK</span>' : ""}</span></summary><div class="steps">${list}</div></details>`
      : `${head}<div class="guide-meta">${done} of ${steps.length} done</div><div class="steps">${list}</div>`;
  }
  if (el.dataset.h === html) return;
  el.dataset.h = html;
  el.innerHTML = html;
  const run = (fn) => guard(async () => { await fn(); view.ck = null; await view.tick(); poll(); });
  const mint = $("#pf-mint"), dep = $("#pf-depgo");
  if (mint) mint.onclick = run(async () => { toast("Minting test USDG…"); await post("/api/chain/mint", { usd: 100 }); toast("Minted 100 test USDG", "ok"); });
  if (dep) dep.onclick = run(async () => {
    const amount = Number($("#pf-dep").value);
    if (!(amount > 0)) throw new Error("Enter an amount above 0.");
    if (amount > snap.tokenUsd + 1e-9) throw new Error(`The wallet holds only ${usd(snap.tokenUsd)} ${snap.tokenSymbol ?? "USDG"}.`);
    toast("Approving + depositing…");
    const t = await post("/api/chain/deposit", { usd: amount });
    toast("Deposit confirmed · " + t.hash.slice(0, 12) + "…", "ok");
  });
}
