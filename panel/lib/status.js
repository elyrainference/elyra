// Status polling + the always-visible chrome (workspace switcher, network chip, top bar chips, sidebar node card, offline overlay).
// Owns: S.status / S.online. Must not: render view content. The first successful poll calls the handler given to onFirstConnect();
// every successful poll then fires "elyra:status" on document (breadcrumb, account menu and switcher listen to it).
import { api } from "./api.js";
import { API } from "./config.js";
import { $, esc, setHtml } from "./dom.js";
import { usd } from "./format.js";
import { S } from "./store.js";

let connected = () => {};
export const onFirstConnect = (fn) => { connected = fn; };

/** Which money this node settles with. Only robinhood-mainnet is real money; no escrow configured means a simulated ledger. */
export function netOf(st) {
  const s = st.network.settlement;
  if (!s?.configured) return { k: "sim", label: "Simulated", long: "Simulated ledger", note: "Nothing is settled on-chain. Receipts are signed, balances are test numbers." };
  if (s.network === "robinhood-mainnet") return { k: "real", label: "Mainnet", extra: " · real money", long: "Robinhood Chain mainnet", note: "Real USDG. The contracts are unaudited and deposits are capped per wallet." };
  return { k: "test", label: s.network === "local" ? "Local chain" : "Testnet", long: s.network === "local" ? "Local dev chain" : "Robinhood Chain testnet", note: "A test network: no real money moves." };
}

const netChip = (n) => `<i class="dot"></i>${esc(n.label)}${n.extra ? `<span class="nx">${esc(n.extra)}</span>` : ""}`;

function renderChrome(st) {
  $("#dot").classList.remove("off");
  $("#vprstate").textContent = `Online · :${st.node.port}`;
  $("#balchip").textContent = "Wallet " + usd(st.balance);
  const sc = $("#simchip");
  sc.hidden = !st.network.demoNetwork;
  sc.textContent = `Demo market · ${st.network.simPeers} simulated peers`;
  $("#ver").textContent = "v" + st.node.version;
  $("#ws-name").textContent = st.node.name;
  const n = netOf(st);
  document.body.dataset.net = n.k;
  for (const id of ["net-side", "net-top"]) { const el = $("#" + id); el.className = "net " + n.k; setHtml(el, netChip(n)); }
  setHtml($("#nodecard"), `<div class="nc-top"><span class="dot"></span><b>${esc(st.node.name)}</b></div><div class="nc-id" title="${esc(st.node.id)}">${esc(st.node.id)}</div>
    <dl><dt>Peers</dt><dd>${st.network.peersLive} live</dd><dt>Listings</dt><dd>${st.network.listings} · ${st.network.models} models</dd><dt>Providing</dt><dd>${st.providing.enabled ? "Yes" : "No"}</dd></dl>`);
  const setN = (id, v) => { const el = $("#n-" + id); el.hidden = !v; el.textContent = v; };
  setN("models", st.network.models);
  setN("network", st.network.peersLive || "");
}

export async function poll() {
  try {
    const st = await api("/api/status");
    S.status = st;
    if (!S.online) { S.online = true; $("#offline").classList.remove("on"); if (S.view) connected(); }
    renderChrome(st);
    document.dispatchEvent(new CustomEvent("elyra:status"));
  } catch {
    S.online = false;
    $("#offline").classList.add("on");
    $("#dot").classList.add("off");
    $("#vprstate").textContent = "Offline";
    $("#offhint").textContent = `Trying ${API || location.origin} …`;
  }
}
