// Badges and logos. Privacy/origin labels are honesty-critical: CLAIMED, DEMO and SIM must never read as verified or live.
import { LOGO } from "../lib/config.js";
import { esc } from "../lib/dom.js";

export const badge = (text, cls = "") => `<span class="badge${cls ? " " + cls : ""}">${text}</span>`;

// logo names come from the catalog (and, for live peers, from a local model-name guess); only plain slugs may reach the CSS url()
export const logo = (l, name, big) =>
  l && /^[\w-]+$/.test(l)
    ? `<span class="lg ${big ? "big" : ""}"><b style="--l:url(${LOGO}${l}.svg)"></b></span>`
    : `<span class="lg ${big ? "big" : ""}">${esc((name || "?")[0].toUpperCase())}</span>`;

export const privacy = (c) =>
  c.kind === "self" ? (c.remote ? `<span class="badge" title="a machine that is not yours, reached over a tunnel: its operator can read your prompts">REMOTE · CLEAR</span>` : c.hosted ? `<span class="badge" title="your own key on a hosted API: the provider sees your prompts">HOSTED · CLEAR</span>` : `<span class="badge self">LOCAL</span>`) :
  c.tee === "verified" ? `<span class="badge tee" title="${esc((c.attest?.platform ?? "") + " · image " + (c.attest?.image ?? "").slice(0, 19) + "… · pinned by you")}">TEE · VERIFIED</span>` :
  c.tee === "claimed" ? `<span class="badge warn" title="the seller says it runs in a TEE, but there is no attestation you trust (pin the Elyra image digest under Network → TEE trust)">TEE · CLAIMED</span>` :
  c.tee === "demo" ? `<span class="badge sim">TEE · DEMO</span>` : `<span class="badge">CLEAR</span>`;

// found through the on-chain registry (still verified by the node's own signed hello; the badge only says how it was discovered)
export const fromRegistry = (p) => (p?.viaRegistry ? `<span class="badge" title="Discovered through the on-chain registry. Its identity was checked against its signed hello, like any peer.">from registry</span>` : "");

export const origin = (c) => (c.simulated ? `<span class="badge sim">SIM</span>` : `<span class="badge live">LIVE</span>`);
