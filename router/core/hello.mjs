// Peer hello: what this node advertises (helloInfo) and how a peer's advertisement is verified (fetchHello).
// Identity, box key and wallet must be signed by the peer's node key; TEE claims are checked against the BUYER's
// own pinned trust list (state.trust), never against what the seller says about itself.
import { sha } from "../lib/canon.mjs";
import { cleanHello } from "../lib/peer-hello.mjs";
import { fetchJson } from "../lib/fetch-json.mjs";
import { log } from "../obs.mjs";
import { bindingNonce, verifyGcpToken } from "../tee.mjs";
import { PROTOCOL, VERSION, depositCapOf } from "./limits.mjs";

export function createHello({ state, identity, chain, publicUrl }, { provideModels, tee }) {
  const helloInfo = () => ({
    v: PROTOCOL, id: identity.id, pub: identity.pub, name: state.name, url: publicUrl, providing: state.provide.enabled, models: provideModels(), version: VERSION, ts: Date.now(),
    box: { pub: identity.box.pub, sig: identity.sign({ id: identity.id, box: identity.box.pub }) },
    ...(chain.address ? { wallet: { address: chain.address, sig: identity.sign({ id: identity.id, wallet: chain.address }) } } : {}),
    chain: chain.configured() ? { network: state.chain.network, escrow: state.chain.escrow, maxDepositUsd: depositCapOf(state.provide) } : null,
    ...(tee.active() ? { attestation: { type: tee.current().type, token: tee.current().token } } : {}),
  });

  async function fetchHello(url) {
    const t0 = Date.now();
    const h = await fetchJson(url + "/p2p/hello");
    if (!h?.id || !h?.pub || sha(Buffer.from(h.pub, "base64")).slice(0, 16) !== h.id) throw new Error("invalid hello");
    if (h.v !== PROTOCOL) throw new Error(`peer speaks protocol v${h.v ?? 1}, this node speaks v${PROTOCOL}: upgrade the older node`);
    if (!h.box?.pub || !identity.verify({ id: h.id, box: h.box.pub }, h.box.sig, h.pub)) throw new Error("hello box key not signed by node identity");
    if (h.wallet && (!chain.isAddress(h.wallet.address) || !identity.verify({ id: h.id, wallet: h.wallet.address }, h.wallet.sig, h.pub))) throw new Error("hello wallet not signed by node identity");
    // TEE: the buyer verifies the seller's attestation against the BUYER's trust list; the seller's own `tee` field is only a claim
    let attest = null;
    if (h.attestation?.token) {
      attest = await verifyGcpToken(h.attestation.token, state.trust, { binding: bindingNonce({ id: h.id, pub: h.pub, box: h.box.pub, wallet: h.wallet?.address }) });
      if (!attest.ok) log("info", "attestation not accepted", { peer: h.name, reasons: attest.reasons });
    }
    return { h, rtt: Date.now() - t0, attest };
  }

  const peerFields = (h, attest) => {
    const c = cleanHello(h);
    return { name: c.name, providing: c.providing, models: c.models, version: c.version, box: h.box.pub, wallet: h.wallet?.address ?? null, chain: c.chain, attest: attest ?? null };
  };

  return { helloInfo, fetchHello, peerFields };
}
