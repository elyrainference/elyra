// "Back up this node" card (Connect). Explains what lives in the data directory and what losing it costs, shows where it is and whether
// secrets are encrypted at rest, a two-item checklist, and exports the PUBLIC facts only (node id, wallet address, escrow).
// Never handles secrets: /api/status only says `encrypted: true|false` and the path; keys and the passphrase never reach the panel.
import { api } from "../lib/api.js";
import { $, esc } from "../lib/dom.js";
import { S } from "../lib/store.js";
import { copy } from "../components/controls.js";
import { guard } from "../components/toast.js";

const KEY = "elyra-backup-copy"; // the user's own tick: Elyra cannot see an offline copy, so it never claims one exists

const item = (done, title, body) => `<div class="bk-item ${done ? "done" : ""}"><span class="no">${done ? "✓" : "–"}</span><div><b>${title}</b><p>${body}</p></div></div>`;

/** the facts anyone may see; no key material of any kind */
const publicFacts = (st, c) => ({
  elyra: "public-node-facts",
  exportedAt: new Date().toISOString(),
  nodeId: st.node.id,
  nodeName: st.node.name,
  walletAddress: st.node.address ?? null,
  network: c?.networkName ?? null,
  chainId: c?.chainId ?? null,
  escrow: c?.escrow ?? null,
  version: st.node.version,
});

export const backupCard = () => `<div class="card" id="cn-backup"><h3>Back up this node <span class="badge" id="bk-badge"></span></h3><div id="bk-body"></div></div>`;

export async function renderBackup() {
  const el = $("#bk-body");
  const st = S.status;
  if (!el || !st) return;
  const c = await Promise.race([api("/api/chain").catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))]);
  const n = st.node, enc = n.encrypted === true, dir = n.dataDir;
  const draw = () => {
    const copied = localStorage.getItem(KEY) === "1";
    $("#bk-badge").className = "badge " + (enc && copied ? "ok" : "warn");
    $("#bk-badge").textContent = enc && copied ? "Backed up" : "Not backed up";
    el.innerHTML = `
      <p class="help" style="margin-bottom:0">Your node's identity (its id and reputation) and its wallet key live in one folder, the <b>data directory</b>. If you lose it, the wallet and any funds or unredeemed earnings in it are gone, and the node restarts with a new id and no reputation. Nobody, Elyra included, can recover it for you.</p>
      <div style="margin-top:14px">
        <div class="row"><span class="k">Data directory</span><span class="v bk-path">${dir ? `<code>${esc(dir)}</code><button type="button" class="btn sm ghost" data-copy="${esc(dir)}" aria-label="Copy data directory path">Copy</button>` : '<span class="mut">unknown (older node)</span>'}</span></div>
        <div class="row"><span class="k">Secrets at rest</span><span class="v">${enc ? '<span class="badge ok">Encrypted</span>' : '<span class="badge warn">Not encrypted</span>'} <span class="mut">${enc ? "identity and wallet key need your passphrase" : "plain files: anyone who can read the folder can spend the wallet"}</span></span></div>
        <div class="row"><span class="k">Node id</span><span class="v mono">${esc(n.id)}</span></div>
        <div class="row"><span class="k">Wallet address</span><span class="v mono">${esc(n.address ?? "none (the chain adapter is not installed)")}</span></div>
        <div class="row"><span class="k">Escrow</span><span class="v">${c?.escrow ? `<span class="mono">${esc(c.escrow)}</span> <span class="mut">${esc(c.networkName ?? "")}</span>` : '<span class="mut">not configured (simulated ledger)</span>'}</span></div>
      </div>
      <div class="bk-list">
        ${item(enc, "Passphrase set", enc ? "Identity and wallet are encrypted with your <code>ELYRA_PASSPHRASE</code>. Keep that passphrase in a password manager, <b>apart from</b> the copy of the folder: without it the copy cannot be opened." : "Start the node with <code>ELYRA_PASSPHRASE</code> set to a long random value. It encrypts the identity and wallet key on disk the next time the node starts.")}
        <label class="bk-item ${copied ? "done" : ""}" style="cursor:pointer"><span class="no">${copied ? "✓" : "–"}</span><div><b>A copy of the data directory is stored offline</b><p>Stop the node first, copy the whole folder to a drive or vault that is not on this computer, and try restoring it once. You confirm this yourself; Elyra cannot see it.</p><span class="check" style="margin-top:8px"><input type="checkbox" id="bk-copy" ${copied ? "checked" : ""}><span>I have an offline copy</span></span></div></label>
      </div>
      <div class="sep"></div>
      <div class="row-flex"><button type="button" class="btn sm" id="bk-dl">Download public facts</button><button type="button" class="btn sm ghost" id="bk-cp">Copy as JSON</button></div>
      <p class="help" style="margin:10px 0 0">Public facts are the node id, wallet address and escrow as a small JSON file. They contain <b>no keys and no passphrase</b>, are safe to share, and let you recognise this node after a restore. They cannot restore anything on their own.</p>`;
    $("#bk-copy").onchange = (e) => { localStorage.setItem(KEY, e.target.checked ? "1" : "0"); draw(); $("#bk-copy").focus(); };
    $("#bk-dl").onclick = guard(async () => {
      const blob = new Blob([JSON.stringify(publicFacts(st, c), null, 2) + "\n"], { type: "application/json" });
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `elyra-node-${n.id}.json` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    $("#bk-cp").onclick = guard(() => copy(JSON.stringify(publicFacts(st, c), null, 2)));
  };
  draw();
}
