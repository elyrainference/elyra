// Shell menus: the workspace (node) switcher in the sidebar header, the account menu top right, and the search buttons that open the palette.
// Identity: on a remote admin hostname /auth/session says who is signed in (wallet or token session); on localhost the owner is the machine itself,
// so nothing is asked (no request, no console noise). Sign out posts the same form the old button did (/admin/logout).
import { copy } from "./components/controls.js";
import { pop } from "./components/pop.js";
import { toast } from "./components/toast.js";
import { API, toolUrl } from "./lib/config.js";
import { $, esc } from "./lib/dom.js";
import { icon } from "./lib/icons.js";
import { shortAddr } from "./lib/format.js";
import { netOf } from "./lib/status.js";
import { S } from "./lib/store.js";
import { currentDensity, currentTheme, toggleDensity, toggleTheme } from "./lib/theme.js";
import { closeDrawer } from "./lib/drawer.js";
import { DOCS, openPalette, REPO } from "./palette.js";
import { go } from "./router.js";

const REMOTE = !API && !/^(localhost|127\.|\[::1\])/.test(location.hostname);
let who = null; // { role, address, username } | null (local owner, or not asked yet)

const item = (pick, ic, label, hint = "") => `<button type="button" class="pi" role="menuitem" data-pick="${pick}">${icon(ic)}<span>${label}</span>${hint}</button>`;
const link = (href, ic, label) => `<a class="pi" role="menuitem" href="${href}" target="_blank" rel="noopener">${icon(ic)}<span>${label}</span><span class="ext" aria-hidden="true">↗</span></a>`;

async function loadWho() {
  if (!REMOTE) return;
  try {
    const r = await fetch("/auth/session", { credentials: "same-origin", cache: "no-store" });
    const j = r.ok ? await r.json() : null;
    who = j?.signedIn ? { role: j.role, address: j.address ?? null, username: j.username ?? null } : { role: "admin", address: null, username: null };
  } catch { who = { role: "admin", address: null, username: null }; }
  paintAvatar();
}

function paintAvatar() {
  $("#acct").innerHTML = who?.address ? `<span>${esc(who.address.slice(2, 4).toUpperCase())}</span>` : icon("user");
}

const identity = () => !REMOTE ? ["Local owner", "This browser is on the machine that runs the node. The control API is loopback-only."]
  : who?.address ? [who.username ? esc(who.username) : esc(shortAddr(who.address, 6, 4)), `${esc(who.role === "admin" ? "Admin" : "User")} · signed in with a wallet`]
    : ["Admin session", "Signed in with the admin token."];

function accountMenu(btn) {
  const [name, sub] = identity(), light = currentTheme() === "light", compact = currentDensity() === "compact";
  pop(btn, `<div class="ph"><b>${name}</b><span>${sub}</span></div><div class="pdiv"></div>
    ${item("theme", light ? "moon" : "sun", light ? "Switch to dark theme" : "Switch to light theme")}
    ${item("density", "density", compact ? "Use comfortable density" : "Use compact density")}
    ${item("keys", "keyboard", "Keyboard shortcuts", "<kbd>?</kbd>")}
    <div class="pdiv"></div>${link(DOCS, "book", "Documentation")}${link(REPO, "github", "GitHub")}
    ${REMOTE ? `<div class="pdiv"></div><form method="post" action="/admin/logout"><button type="submit" class="pi" role="menuitem">${icon("logout")}<span>Sign out</span></button></form>` : ""}`, {
    align: "end", onPick: (k) => {
      if (k === "theme") toast(toggleTheme() === "light" ? "Light theme" : "Dark theme");
      else if (k === "density") toast(toggleDensity() === "compact" ? "Compact density" : "Comfortable density");
      else document.dispatchEvent(new CustomEvent("elyra:shortcuts"));
    },
  });
}

function nodeMenu(btn) {
  const st = S.status;
  if (!st) return;
  const n = netOf(st), url = toolUrl(st.node.port);
  pop(btn, `<div class="ph"><b>${esc(st.node.name)}</b><span class="mono" title="${esc(st.node.id)}">${esc(st.node.id)}</span></div>
    <div class="pnet ${n.k}"><span class="net ${n.k}"><i class="dot"></i>${esc(n.label + (n.extra ?? ""))}</span><p>${esc(n.note)}</p></div><div class="pdiv"></div>
    ${item("ep", "copy", "Copy endpoint URL")}${item("id", "copy", "Copy node id")}${item("network", "network", "Network and peers")}${item("payments", "payments", "Payments and settlement")}
    <div class="pfoot">Managing <span class="mono">${esc(API || location.origin)}</span>. To manage another node, open that node's own panel.</div>`, {
    onPick: (k) => { if (k === "ep") copy(url); else if (k === "id") copy(st.node.id); else go(k); },
  });
}

export function initMenus() {
  $("#ws").innerHTML = `<span class="mark" role="img" aria-label="Elyra"></span><span class="ws-t"><b id="ws-name">Elyra</b><span class="ver" id="ver">VPR</span></span>${icon("chev")}<span class="net" id="net-side"></span>`;
  $("#cmdk").innerHTML = `${icon("search")}<span class="lbl">Search</span><kbd>${/Mac|iP/.test(navigator.platform) ? "⌘" : "Ctrl"} K</kbd>`;
  $("#cmdk-side").innerHTML = `${icon("search")}<span>Search</span><kbd>${/Mac|iP/.test(navigator.platform) ? "⌘" : "Ctrl"} K</kbd>`;
  paintAvatar();
  $("#ws").onclick = (e) => nodeMenu(e.currentTarget);
  $("#acct").onclick = (e) => accountMenu(e.currentTarget);
  for (const id of ["cmdk", "cmdk-side"]) $("#" + id).onclick = () => { closeDrawer(); openPalette(); };
  loadWho();
}
