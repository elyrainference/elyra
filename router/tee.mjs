// Real TEE attestation, platform: Google Cloud Confidential Space (AMD SEV / Intel TDX confidential VM, one measured container).
//
// What a buyer can conclude from a token that passes verifyGcpToken():
//   * Google Cloud Attestation signed it (RS256, key from Google's published OIDC JWKS), it is fresh, and it was minted for Elyra (audience);
//   * the hardware is a confidential VM (hwmodel), secure boot is on, debugging is disabled since boot;
//   * the single workload container has exactly an image digest the buyer has PINNED (the buyer's trust list, never the seller's claim);
//   * the token's nonce equals sha256 of this node's identity key, sealing (box) key and wallet address, i.e. these keys were handed to the
//     attestation service by the code running in that measured container. Sealed prompts encrypted to that box key can only be opened there.
// What it does NOT prove: that Google is honest (it is the root of trust), side-channel resistance, or that the model server runs inside the
// same container (the image must bundle it; the node refuses non-local upstreams in TEE mode). See docs/TEE.md.
import crypto from "node:crypto";
import http from "node:http";
import { dohFetch } from "./net.mjs";

export const GCP_ISSUER = "https://confidentialcomputing.googleapis.com";
export const GCP_DISCOVERY = `${GCP_ISSUER}/.well-known/openid-configuration`;
export const AUDIENCE = "elyra:v3";
export const DEFAULT_SOCKET = "/run/container_launcher/teeserver.sock";
export const DEFAULT_HW = ["GCP_AMD_SEV", "GCP_INTEL_TDX"];

const canon = (v) => (v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}");
const b64u = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** What the attestation must commit to: the keys a buyer will seal prompts to and pay. Recomputed independently by the buyer from the hello. */
export const bindingNonce = ({ id, pub, box, wallet }) => crypto.createHash("sha256").update(canon({ id, pub, box, wallet: wallet ?? null })).digest("hex");

// ---------------------------------------------------------------- JWKS (cached; fail closed)
const jwksCache = new Map(); // url → { keys, t }
async function loadJwks(policy) {
  if (policy.jwksInline) return policy.jwksInline.keys ?? policy.jwksInline; // tests only; the server refuses to accept this setting in production
  const hit = jwksCache.get("gcp");
  if (hit && Date.now() - hit.t < 3600_000) return hit.keys;
  const disc = await (await dohFetch(GCP_DISCOVERY, { timeout: 8000 })).json();
  if (disc.issuer !== GCP_ISSUER || !String(disc.jwks_uri).startsWith("https://www.googleapis.com/")) throw new Error("unexpected OIDC discovery document");
  const keys = (await (await dohFetch(disc.jwks_uri, { timeout: 8000 })).json()).keys;
  if (!Array.isArray(keys) || !keys.length) throw new Error("empty JWKS");
  jwksCache.set("gcp", { keys, t: Date.now() });
  return keys;
}

/**
 * Verify a Confidential Space OIDC attestation token.
 * policy = { allowedImages: ["sha256:…"], allowedHw?: [...], jwksInline?: JWK[] }  (the BUYER's trust list)
 * expect = { binding: <hex nonce> }
 * Returns { ok, reasons[], platform, image, exp }. Never throws: any failure is `ok:false` with a reason.
 */
export async function verifyGcpToken(token, policy, expect, now = Date.now()) {
  const fail = (...reasons) => ({ ok: false, reasons });
  try {
    if (typeof token !== "string" || token.length > 20000) return fail("no token");
    const parts = token.split(".");
    if (parts.length !== 3) return fail("malformed token");
    const header = JSON.parse(b64u(parts[0]).toString("utf8"));
    const claims = JSON.parse(b64u(parts[1]).toString("utf8"));
    if (header.alg !== "RS256") return fail(`unsupported alg ${header.alg}`); // never accept alg=none / HS256 confusion
    const keys = await loadJwks(policy);
    const jwk = keys.find((k) => k.kid === header.kid && (!k.alg || k.alg === "RS256"));
    if (!jwk) return fail("signing key not in Google's JWKS");
    const ok = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), crypto.createPublicKey({ key: jwk, format: "jwk" }), b64u(parts[2]));
    if (!ok) return fail("bad signature");

    const reasons = [];
    const s = Math.floor(now / 1000);
    if (claims.iss !== GCP_ISSUER) reasons.push("wrong issuer");
    if (!(claims.exp > s)) reasons.push("expired");
    if (claims.nbf && claims.nbf > s + 60) reasons.push("not yet valid");
    if (claims.aud !== AUDIENCE) reasons.push("wrong audience");
    const nonces = [].concat(claims.eat_nonce ?? []);
    if (!nonces.includes(expect.binding)) reasons.push("token is not bound to this node's keys");
    if (claims.swname !== "CONFIDENTIAL_SPACE") reasons.push("not a Confidential Space workload");
    if (claims.dbgstat !== "disabled-since-boot") reasons.push("debugging not disabled");
    if (claims.secboot !== true) reasons.push("secure boot off");
    if (!(policy.allowedHw ?? DEFAULT_HW).includes(claims.hwmodel)) reasons.push(`hardware ${claims.hwmodel} not allowed`);
    if (!(claims.submods?.confidential_space?.support_attributes ?? []).includes("USABLE")) reasons.push("Confidential Space image is not USABLE (deprecated)");
    const image = claims.submods?.container?.image_digest;
    if (!policy.allowedImages?.length) reasons.push("no trusted image digests configured (pin the Elyra image digest first)");
    else if (!policy.allowedImages.includes(image)) reasons.push(`image ${String(image).slice(0, 19)}… is not in your trust list`);
    if (claims.submods?.container?.restart_policy && claims.submods.container.restart_policy !== "Never" && claims.submods.container.restart_policy !== "OnFailure") reasons.push("unexpected restart policy");
    return reasons.length ? { ok: false, reasons, platform: claims.hwmodel, image } : { ok: true, reasons: [], platform: claims.hwmodel, image, exp: claims.exp * 1000 };
  } catch (e) { return fail("verification error: " + e.message); }
}

// ---------------------------------------------------------------- producer (runs inside the workload)
/** Ask the Confidential Space launcher for a token bound to `binding`. Only works inside a Confidential Space VM (or a test socket). */
export function fetchGcpToken(binding, socketPath = process.env.ELYRA_TEE_SOCKET || DEFAULT_SOCKET) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ audience: AUDIENCE, token_type: "OIDC", nonces: [binding] });
    const req = http.request({ socketPath, path: "/v1/token", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, timeout: 15000 }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => (res.statusCode === 200 ? resolve(out.trim()) : reject(new Error(`launcher ${res.statusCode}: ${out.slice(0, 200)}`))));
    });
    req.on("timeout", () => req.destroy(new Error("launcher timeout")));
    req.on("error", (e) => reject(new Error("cannot reach the Confidential Space launcher: " + e.message)));
    req.end(body);
  });
}
