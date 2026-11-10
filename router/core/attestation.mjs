// Seller-side TEE attestation: when running inside a Confidential Space workload, fetch a Google-signed token that
// binds this node's identity, box key and wallet, and keep it fresh. Buyer-side verification lives in hello.mjs.
// A node that cannot attest never advertises TEE (fail closed).
import { bindingNonce, fetchGcpToken } from "../tee.mjs";
import { log } from "../obs.mjs";

export async function createAttestation(ctx) {
  const { opts, identity, chain, teeMode, every } = ctx;
  let current = null; // { type, token, exp }
  const active = () => teeMode && !!current && current.exp > Date.now();
  async function refresh() {
    if (!teeMode) return;
    try {
      const binding = bindingNonce({ id: identity.id, pub: identity.pub, box: identity.box.pub, wallet: chain.address });
      const token = await fetchGcpToken(binding, opts.teeSocket);
      const exp = JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")).exp * 1000;
      current = { type: "gcp-confidential-space", token, exp };
      log("info", "attestation refreshed", { expires: new Date(exp).toISOString() });
    } catch (e) { current = null; log("error", "attestation failed: this node will NOT advertise TEE", { reason: e.message }); }
  }
  await refresh();
  every(60000, () => { if (teeMode && (!current || current.exp - Date.now() < 20 * 60000)) refresh(); });
  return { active, current: () => current };
}
