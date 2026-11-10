// TEE attestation (Google Confidential Space tokens). The launcher and Google's signing key are simulated with a local
// RSA key; everything on the Elyra side (binding, claim checks, trust pinning, routing rules) is the real code.
// Run: node --test router/test/tee.test.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { AUDIENCE, GCP_ISSUER, bindingNonce, verifyGcpToken } from "../tee.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const server = join(root, "router", "server.mjs");
const J = { "content-type": "application/json" };
const IMAGE = "sha256:" + "ab".repeat(32);
const b64u = (b) => Buffer.from(b).toString("base64url");

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid";
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" }] };
const NONCE = bindingNonce({ id: "a".repeat(16), pub: "PUB", box: "BOX", wallet: "0x" + "1".repeat(40) });

const goodClaims = (over = {}) => ({
  iss: GCP_ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 3600, nbf: Math.floor(Date.now() / 1000) - 5, iat: Math.floor(Date.now() / 1000),
  eat_nonce: [NONCE], swname: "CONFIDENTIAL_SPACE", dbgstat: "disabled-since-boot", secboot: true, hwmodel: "GCP_INTEL_TDX",
  submods: { confidential_space: { support_attributes: ["LATEST", "STABLE", "USABLE"] }, container: { image_digest: IMAGE, restart_policy: "Never" } }, ...over,
});
const sign = (claims, { alg = "RS256", kid = KID, key = privateKey } = {}) => {
  const h = b64u(JSON.stringify({ alg, kid, typ: "JWT" })), p = b64u(JSON.stringify(claims));
  const sig = alg === "RS256" ? crypto.sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key) : alg === "HS256" ? crypto.createHmac("sha256", key).update(`${h}.${p}`).digest() : Buffer.alloc(0);
  return `${h}.${p}.${b64u(sig)}`;
};
const policy = { allowedImages: [IMAGE], jwksInline: jwks };

describe("verifyGcpToken: every way a token can lie", () => {
  const check = (token, pol = policy, binding = NONCE) => verifyGcpToken(token, pol, { binding });
  test("a good token is accepted and reports platform + image", async () => {
    const r = await check(sign(goodClaims()));
    assert.equal(r.ok, true, r.reasons?.join());
    assert.equal(r.platform, "GCP_INTEL_TDX");
    assert.equal(r.image, IMAGE);
  });
  const bad = [
    ["bound to different keys (a replayed token from another node)", () => sign(goodClaims({ eat_nonce: ["00".repeat(32)] })), /not bound/],
    ["expired", () => sign(goodClaims({ exp: Math.floor(Date.now() / 1000) - 10 })), /expired/],
    ["debugging enabled", () => sign(goodClaims({ dbgstat: "enabled" })), /debugging/],
    ["secure boot off", () => sign(goodClaims({ secboot: false })), /secure boot/],
    ["not a Confidential Space workload", () => sign(goodClaims({ swname: "SOMETHING_ELSE" })), /not a Confidential Space/],
    ["disallowed hardware", () => sign(goodClaims({ hwmodel: "GCP_UNKNOWN" })), /not allowed/],
    ["wrong audience (minted for another relying party)", () => sign(goodClaims({ aud: "someone-else" })), /audience/],
    ["wrong issuer", () => sign(goodClaims({ iss: "https://evil.example" })), /issuer/],
    ["deprecated Confidential Space image", () => sign(goodClaims({ submods: { confidential_space: { support_attributes: ["LATEST"] }, container: { image_digest: IMAGE } } })), /USABLE/],
    ["image digest the buyer never pinned", () => sign(goodClaims({ submods: { confidential_space: { support_attributes: ["USABLE"] }, container: { image_digest: "sha256:" + "cd".repeat(32) } } })), /trust list/],
    ["tampered payload (signature no longer matches)", () => { const [h, , s] = sign(goodClaims()).split("."); return `${h}.${b64u(JSON.stringify(goodClaims({ hwmodel: "GCP_AMD_SEV", dbgstat: "disabled-since-boot", submods: { confidential_space: { support_attributes: ["USABLE"] }, container: { image_digest: IMAGE } } })))}.${s}`; }, /bad signature/],
    ["unknown signing key id", () => sign(goodClaims(), { kid: "other" }), /JWKS/],
    ["alg=none", () => sign(goodClaims(), { alg: "none" }), /unsupported alg/],
    ["HS256 forged with the public key as the HMAC secret (algorithm confusion)", () => sign(goodClaims(), { alg: "HS256", key: Buffer.from(JSON.stringify(jwks.keys[0])) }), /unsupported alg/],
    ["signed by someone else's RSA key", () => sign(goodClaims(), { key: crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey }), /bad signature/],
    ["garbage", () => "not.a.jwt", /error|malformed|bad/],
  ];
  for (const [name, make, re] of bad) test(`rejects: ${name}`, async () => {
    const r = await check(make());
    assert.equal(r.ok, false);
    assert.match(r.reasons.join(" | "), re);
  });
  test("an empty trust list never verifies anything (the buyer must pin a digest first)", async () => {
    const r = await check(sign(goodClaims()), { allowedImages: [], jwksInline: jwks });
    assert.equal(r.ok, false);
    assert.match(r.reasons.join(), /no trusted image/);
  });
});

describe("end to end: seller inside a (simulated) Confidential Space, buyer pins the image", () => {
  const A = 18801, B = 18802, LAUNCHER_PORT = 18803, STUB = 18804;
  const sock = process.platform === "win32" ? `\\\\.\\pipe\\elyra-tee-test-${process.pid}` : join(tmpdir(), `elyra-tee-${process.pid}.sock`);
  const procs = [], dirs = [];
  let launcher, stub, image = IMAGE;
  const call = (port) => async (p, method = "GET", body) => { const r = await fetch(`http://localhost:${port}${p}`, { method, headers: J, body: body && JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
  const a = call(A), b = call(B);
  const start = async (port, name, env) => {
    const dir = mkdtempSync(join(tmpdir(), "vpr-tee-")); dirs.push(dir);
    procs.push(spawn(process.execPath, [server, "--port", String(port), "--data", dir, "--name", name, "--no-demo"], { env: { ...process.env, ...env }, stdio: "pipe" }));
    for (let i = 0; i < 200; i++) { try { if ((await fetch(`http://localhost:${port}/p2p/hello`)).ok) return; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 150)); }
    throw new Error("node did not start");
  };
  const chat = () => fetch(`http://localhost:${A}/v1/chat/completions`, { method: "POST", headers: J, body: JSON.stringify({ model: "tee-model", messages: [{ role: "user", content: "secret question" }] }) });

  before(async () => {
    // the "launcher": mints a token for whatever nonce the workload asks for, like /run/container_launcher/teeserver.sock
    launcher = createServer((req, res) => {
      let raw = ""; req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const { audience, nonces } = JSON.parse(raw);
        res.end(sign(goodClaims({ aud: audience, eat_nonce: nonces, submods: { confidential_space: { support_attributes: ["USABLE"] }, container: { image_digest: image, restart_policy: "Never" } } })));
      });
    });
    await new Promise((r) => launcher.listen(sock, r));
    stub = createServer((req, res) => {
      if (req.url.endsWith("/models")) return res.setHeader("content-type", "application/json"), res.end(JSON.stringify({ data: [{ id: "tee-model" }] }));
      req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } })); });
    });
    await new Promise((r) => stub.listen(STUB, r));
    await start(B, "tee-seller", { ELYRA_TEE: "gcp-confidential-space", ELYRA_TEE_SOCKET: sock });
    await start(A, "buyer", { ELYRA_ALLOW_TEST_TRUST: "1" });
    const up = await b("/api/upstreams", "POST", { name: "local-model", baseUrl: `http://localhost:${STUB}/v1` });
    await b("/api/provide", "PUT", { enabled: true, upstreamId: up.id, price: 1 });
  });
  after(() => { launcher.close(); stub.close(); procs.forEach((p) => p.kill()); setTimeout(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })), 500); });

  const model = async () => (await a("/api/models")).models.find((m) => m.model === "tee-model");

  test("without a pinned image the seller is only 'claimed', and TEE-only routing refuses it", async () => {
    await a("/api/trust", "PUT", { jwksInline: jwks }); // test-only switch, the real node uses Google's JWKS
    await a("/api/peers", "POST", { url: `http://localhost:${B}` });
    assert.equal((await model()).tee, "claimed");
    await a("/api/policy", "PUT", { teeOnly: true });
    assert.equal((await chat()).status, 404);
  });

  test("after the buyer pins the Elyra image digest the seller becomes VERIFIED and TEE-only routing accepts it", async () => {
    await a("/api/trust", "PUT", { allowedImages: [IMAGE] });
    const m = await model();
    assert.equal(m.tee, "verified");
    assert.equal(m.attest.platform, "GCP_INTEL_TDX");
    assert.equal(m.attest.image, IMAGE);
    assert.equal((await chat()).status, 200);
  });

  test("if the buyer un-pins the digest (or the seller runs another image) trust is withdrawn immediately", async () => {
    await a("/api/trust", "PUT", { allowedImages: ["sha256:" + "ee".repeat(32)] });
    assert.equal((await model()).tee, "claimed");
    assert.equal((await chat()).status, 404);
    await a("/api/trust", "PUT", { allowedImages: [IMAGE] });
  });

  test("a seller in TEE mode refuses a remote model upstream, because the privacy claim would be false", async () => {
    const r = await b("/api/upstreams", "POST", { name: "hosted", baseUrl: "https://api.openai.com/v1", models: ["gpt"] });
    assert.equal(r.status, 400);
    assert.match(r.error.message, /TEE mode/);
  });

  test("the inline JWKS escape hatch is refused on a node that was not started for tests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vpr-tee-")); dirs.push(dir);
    const p = spawn(process.execPath, [server, "--port", "18805", "--data", dir, "--no-demo"], { env: { ...process.env, ELYRA_ALLOW_TEST_TRUST: "" }, stdio: "pipe" });
    procs.push(p);
    for (let i = 0; i < 60; i++) { try { if ((await fetch("http://localhost:18805/p2p/hello")).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 150)); }
    const r = await call(18805)("/api/trust", "PUT", { jwksInline: jwks });
    assert.equal(r.status, 403);
  });
});
