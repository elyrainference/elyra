// Navigation model. Owns: the ordered list of views, their sub-tabs, and the sidebar (collapsible groups, remembered in localStorage).
// Add a view: add it to VIEWS (and an icon in icons.js), to views/index.js and a <section id="v-…"> in index.html.
import { $ } from "./dom.js";
import { icon } from "./icons.js";

export const VIEWS = [
  ["overview", "Home & usage", "This node"], ["live", "Private Live", "This node"],
  ["models", "Models & sellers", "Use AI"], ["playground", "Playground", "Use AI"], ["routing", "Routing", "Use AI"],
  ["connect", "Sources & tools", "Set up"], ["network", "Network", "Set up"],
  ["provide", "Sell capacity", "Earn & pay"], ["payments", "Payments", "Earn & pay"],
];

/** Pages with tabs: view -> [[tab id, label], ...]. IDs remain stable for contextual links and remembered tabs. */
export const TABS = {
  provide: [["offer", "Models & pricing"], ["golive", "Reachability"], ["earnings", "Earnings"]],
  payments: [["fund", "Fund"], ["ledger", "Ledger"], ["escrow", "Escrow"]],
  network: [["topology", "Topology"], ["peers", "Peers"], ["trust", "Trust"]],
};

const KEY = "elyra-nav-closed";
const groups = [...new Set(VIEWS.map((v) => v[2]))];
const closed = () => { try { return new Set(JSON.parse(localStorage.getItem(KEY) || "[]")); } catch { return new Set(); } };

export function buildNav() {
  const shut = closed();
  $("#nav").innerHTML = groups.map((g, i) => {
    const items = VIEWS.filter((v) => v[2] === g).map(([id, label]) =>
      `<button type="button" class="nav" data-view="${id}">${icon(id)}<span>${label}</span><span class="n" id="n-${id}" hidden></span></button>`).join("");
    return `<div class="grpw"><button type="button" class="grp" data-g="${i}" aria-expanded="${!shut.has(g)}" aria-controls="grp-${i}"><span>${g.replace("&", "&amp;")}</span>${icon("chev")}</button><div class="grpb" id="grp-${i}"${shut.has(g) ? " hidden" : ""}>${items}</div></div>`;
  }).join("");
  $("#nav").addEventListener("click", (e) => {
    const b = e.target.closest(".grp");
    if (b) setOpen(Number(b.dataset.g), b.getAttribute("aria-expanded") !== "true");
  });
}

function setOpen(i, open) {
  const b = $(`.grp[data-g="${i}"]`), shut = closed();
  b.setAttribute("aria-expanded", String(open));
  $("#grp-" + i).hidden = !open;
  open ? shut.delete(groups[i]) : shut.add(groups[i]);
  try { localStorage.setItem(KEY, JSON.stringify([...shut])); } catch { /* storage blocked */ }
}

/** The group holding the current view is never left collapsed (you could not see where you are). */
export function openGroupOf(view) {
  const i = groups.indexOf(VIEWS.find((v) => v[0] === view)?.[2]);
  if (i >= 0 && $("#grp-" + i)?.hidden) setOpen(i, true);
}

export const groupOf = (view) => VIEWS.find((v) => v[0] === view)?.[2] ?? "";
