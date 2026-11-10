// Live feed event -> row. Shared by the Live view and the Home activity card. Every event field passes through esc(); the output is trusted markup.
import { esc } from "../lib/dom.js";
import { usd } from "../lib/format.js";

const REASONS = { spend_cap: "Spend cap", unfunded: "Not funded", no_route: "No route", rate_limited: "Rate limited", busy: "Busy", payment_required: "Payment required", denied: "Denied", no_model: "Model not offered", price_mismatch: "Price changed", upstream_error: "Upstream error", unauthenticated: "Not authenticated", bad_request: "Bad request", replay: "Replay refused", other: "Refused" };
export const group = (e) => (e.kind === "request" ? (e.role === "seller" ? "sell" : "buy") : e.kind === "peer" ? "peer" : e.kind === "voucher" ? "money" : "alert");
export const num = (v) => typeof v === "number" && Number.isFinite(v);
export const ms = (n) => (n < 1000 ? Math.round(n) + " ms" : (n / 1000).toFixed(1) + " s");
const clock = (t) => new Date(t).toLocaleTimeString([], { hour12: false });
const mono = (s) => `<span class="mono">${esc(s)}</span>`;

/** { tone, kind, main, metrics:[tokens, cost, time], status } for one event; all dynamic text escaped here */
export function describe(e) {
  if (e.kind === "request") {
    const buy = e.role !== "seller";
    const sim = e.simulated ? ' <span class="badge sim" title="Simulated peer: no real inference, never settled">SIM</span>' : "";
    const who = buy ? (e.peer ? `from <b>${esc(e.peer)}</b>` : "") : `for ${esc(e.peer ?? "a peer")}${e.counterparty ? " " + mono(e.counterparty) : ""}`;
    return {
      tone: e.status === "ok" ? "ok" : e.status === "error" ? "bad" : "warn",
      kind: buy ? '<span class="badge live">Buying</span>' : '<span class="badge self">Selling</span>',
      main: `<b class="lv-model">${esc(e.model ?? "no model")}</b>${sim} <span class="mut">${who}</span>`,
      metrics: [num(e.promptTokens) || num(e.completionTokens) ? `<span title="prompt → completion tokens">${esc(e.promptTokens ?? 0)}→${esc(e.completionTokens ?? 0)} tok</span>` : "<span></span>",
        num(e.costUsd) ? `<span title="cost of this request">${esc(usd(e.costUsd))}</span>` : "<span></span>",
        num(e.latencyMs) ? `<span title="${num(e.ttftMs) ? "first token " + esc(ms(e.ttftMs)) + " · " : ""}total ${esc(ms(e.latencyMs))}">${esc(ms(e.latencyMs))}</span>` : "<span></span>"],
      status: e.status === "ok" ? "OK" : e.status === "error" ? "Failed" : REASONS[e.reason] ?? "Refused",
    };
  }
  if (e.kind === "peer") {
    const verb = e.state === "online" ? "is online" : e.state === "offline" ? "went offline" : "discovered";
    return {
      tone: e.state === "online" ? "ok" : e.state === "offline" ? "warn" : "info",
      kind: '<span class="badge">Peer</span>',
      main: `<b class="lv-model">${esc(e.name)}</b> <span class="mut">${verb}</span>${e.viaRegistry ? ' <span class="badge" title="Found through the on-chain registry; its identity was still checked against its signed hello.">from registry</span>' : ""}`,
      metrics: [num(e.rttMs) ? `<span title="round trip to the peer">${esc(ms(e.rttMs))}</span>` : "<span></span>", "<span></span>", "<span></span>"],
      status: e.state === "online" ? "Online" : e.state === "offline" ? "Offline" : "New",
    };
  }
  if (e.kind === "voucher") {
    const text = e.action === "issued" ? `Voucher signed for <b>${esc(e.peer ?? "a seller")}</b>${e.counterparty ? " " + mono(e.counterparty) : ""}` : e.action === "received" ? `Voucher received from ${mono(e.counterparty ?? "a buyer")}` : `Redeemed from ${mono(e.counterparty ?? "a buyer")}`;
    return {
      tone: "info",
      kind: '<span class="badge warn">Money</span>',
      main: `${text}${e.tx ? ` <span class="mut">tx</span> ${mono(e.tx)}` : ""}`,
      metrics: ["<span></span>", num(e.amountUsd) ? `<span title="amount">${esc(usd(e.amountUsd))}</span>` : "<span></span>", "<span></span>"],
      status: e.action === "issued" ? "Signed" : e.action === "received" ? "Received" : "Redeemed",
    };
  }
  const text = e.code === "spend_cap" ? `Daily spend cap hit${num(e.spentUsd) && num(e.capUsd) ? ` (${esc(usd(e.spentUsd))} of ${esc(usd(e.capUsd))})` : ""}${e.subject ? ` while routing to <b>${esc(e.subject)}</b>` : ""}`
    : e.code === "low_gas" ? `Low on gas: add a little ETH${e.subject ? ` (${esc(e.subject)})` : ""}`
      : `<b>${esc(e.subject ?? "A model source")}</b> stopped answering`;
  return { tone: "bad", kind: '<span class="badge bad">Alert</span>', main: text, metrics: ["<span></span>", "<span></span>", "<span></span>"], status: "Alert" };
}

export function row(e) {
  const d = describe(e), li = document.createElement("li");
  li.className = "lv-row s-" + d.tone; li.dataset.g = group(e); li.dataset.id = e.id;
  li.innerHTML = `<time class="lv-t" datetime="${esc(new Date(e.ts).toISOString())}">${esc(clock(e.ts))}</time><span class="lv-k">${d.kind}</span><span class="lv-m">${d.main}</span><span class="lv-x">${d.metrics.join("")}</span><span class="lv-st">${esc(d.status)}</span>`;
  return li;
}

