// Buyer alerts on Home and Payments: low escrow, no gas, daily-cap usage. Derived on every refresh from data the panel already has
// (/api/status, and the /api/chain snapshot the views already load); nothing is stored and nothing new is polled. Each alert carries the
// one action that fixes it. Banners are non-blocking and disappear by themselves once the cause is gone.
import { esc, setHtml } from "../lib/dom.js";
import { usd } from "../lib/format.js";
import { S } from "../lib/store.js";

export const MIN_ESCROW_USD = 1;
export const MIN_GAS_ETH = 0.0005; // a few deposits or redemptions on the L2 (same threshold as the Provide go-live checklist)
export const CAP_WARN = 0.8;

/** Live funding facts shared by the alerts and the Payments stepper. `c` is the /api/chain snapshot (null while unknown). */
export function fundingFacts(st, c) {
  const chainMode = c?.mode === "chain" && !!c.connected;
  const gasEth = Number(c?.walletEth ?? 0);
  return {
    chainMode, gasEth, gasOk: gasEth >= MIN_GAS_ETH,
    tokenUsd: Number(c?.tokenUsd ?? 0), depositUsd: Number(c?.depositUsd ?? 0),
    escrowUsd: Number(st?.balance ?? 0), escrowOk: Number(st?.balance ?? 0) >= MIN_ESCROW_USD,
  };
}

const act = (label, attrs, primary) => `<button type="button" class="btn sm${primary ? " primary" : ""}" ${attrs}>${label}</button>`;

/**
 * The alerts to show. `page` is "home" or "payments": the same alert points at the fix on that page (a link to Payments from Home,
 * a scroll or a faucet link on Payments itself). `c` is the chain snapshot or null.
 */
export function alertsFor(st, c, page) {
  if (!st) return [];
  const f = fundingFacts(st, c), here = page === "payments", list = [];
  const to = (label, focus, primary = true) => act(label, here ? `data-focus="${focus}"` : `data-go="payments" data-focus="${focus}"`, primary);

  // a seller-only node has no reason to hold escrow: warn buyers, and anyone who has paid or deposited before
  const buyer = S.role !== "sell" || st.stats.spentTotal > 0 || f.depositUsd > 0;
  if (f.chainMode && !f.gasOk) { // sellers need gas to redeem, buyers to deposit
    const none = f.gasEth <= 0, faucet = c.network === "robinhood-testnet" && c.faucets?.[0];
    list.push({
      kind: "bad", title: none ? "No ETH for gas" : "Low on ETH for gas",
      text: `The node wallet holds ${f.gasEth.toFixed(5)} ETH. Every deposit and redemption on ${esc(c.networkName ?? "the chain")} needs a little ETH for gas.`,
      action: here && faucet
        ? `<a class="btn sm primary" href="${esc(faucet)}" target="_blank" rel="noopener">Open faucet</a><button type="button" class="btn sm" data-copy="${esc(c.address)}">Copy wallet address</button>`
        : to(here ? "Show the steps" : "Get gas", "pay-steps"),
    });
  }
  if (f.chainMode && !f.escrowOk && buyer) {
    list.push({
      kind: "warn", title: `Escrow below $${MIN_ESCROW_USD}`,
      text: `You can spend ${usd(f.escrowUsd)} on paid models. Requests to paid peers are refused when the escrow cannot cover their worst-case cost; free and local models keep working.`,
      action: to("Add funds", "pay-steps"),
    });
  }
  const cap = st.spendCap?.usdDay, spent = st.spendCap?.spentUsd ?? 0;
  if (cap != null) {
    const used = cap > 0 ? spent / cap : 1;
    if (used >= 1) {
      list.push({
        kind: "bad", title: "Daily spend cap reached",
        text: `${usd(spent)} of ${usd(cap)} spent in the last 24 hours. Paid requests are refused until older spend rolls off or you raise the cap.`,
        action: to("Raise the cap", "pc-cap"),
      });
    } else if (used >= CAP_WARN) {
      list.push({
        kind: "warn", title: `You used ${Math.floor(used * 100)}% of today's spend cap`,
        text: `${usd(spent)} of ${usd(cap)} in the last 24 hours. Paid requests that could cross the cap are refused.`,
        action: to("Raise the cap", "pc-cap", false),
      });
    }
  }
  return list;
}

const alertHtml = (a) =>
  `<div class="alert ${a.kind}" role="status"><span class="ic" aria-hidden="true">!</span><div class="tx"><b>${a.title}</b><p>${a.text}</p></div><div class="act">${a.action}</div></div>`;

/** Draw into `el` (written only when the markup changed, so the refresh never flickers or steals focus). */
export function renderAlerts(el, list) {
  setHtml(el, list.map(alertHtml).join(""));
}

export const alertsRegion = (id) => `<div class="alerts" id="${id}" aria-live="polite"></div>`;
