// Regression tests for the findings of the 2026-11-05 security review (F1, F2, F6).
// Run: node --test router/test/security.test.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { open as openBox, newBoxKey, sealTo } from "../seal.mjs";
import { createChain } from "../chain.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const server = join(root, "router", "server.mjs");
const J = { "content-type": "application/json" };
const canon = (v) => (v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const until = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 100)); } };

describe("F2: voucher signatures must be the exact form the contract accepts", () => {
  test("compact (EIP-2098) and v=0/1 signatures are rejected off-chain, canonical ones accepted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vpr-sec-"));
    try {
      const escrow = "0x" + "11".repeat(20);
      const chain = await createChain({ dataDir: dir, getConfig: () => ({ network: "local", escrow, rpcUrl: "", chainId: 0 }) });
      const E = await import("ethers");
      const provider = E.Wallet.createRandom().address;
      const sig = await chain.signVoucher(provider, "1000");
      assert.equal(chain.verifyVoucher(chain.address, provider, "1000", sig), true);
      const parsed = E.Signature.from(sig);
      assert.equal(chain.verifyVoucher(chain.address, provider, "1000", parsed.compactSerialized), false, "64-byte compact form");
      const v01 = sig.slice(0, 130) + (parsed.v === 27 ? "00" : "01");
      assert.equal(chain.verifyVoucher(chain.address, provider, "1000", v01), false, "v = 0/1");
      assert.equal(chain.verifyVoucher(chain.address, provider, "1001", sig), false, "different amount");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("F1 / F6 over HTTP", () => {
  const A = 18701, B = 18702, FAKE = 18703;
  const procs = [], dirs = [];
  const start = async (port, name) => {
    const dir = mkdtempSync(join(tmpdir(), "vpr-sec-")); dirs.push(dir);
    const p = spawn(process.execPath, [server, "--port", String(port), "--data", dir, "--name", name, "--no-demo"], { stdio: "pipe" });
    procs.push(p);
    await until(async () => (await fetch(`http://localhost:${port}/p2p/hello`)).ok);
  };
  const call = (port) => async (p, method = "GET", body) => { const r = await fetch(`http://localhost:${port}${p}`, { method, headers: J, body: body && JSON.stringify(body) }); return { status: r.status, ...(await r.json()) }; };
  const a = call(A), b = call(B);

  // a hostile provider: valid identity and keys, answers with a signed receipt that omits promptTokens and claims an absurd amount
  const nodeKey = crypto.generateKeyPairSync("ed25519");
  const pub = nodeKey.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const id = sha(Buffer.from(pub, "base64")).slice(0, 16);
  const sign = (o) => crypto.sign(null, Buffer.from(canon(o)), nodeKey.privateKey).toString("base64");
  const box = newBoxKey();
  let evil;

  before(async () => {
    await start(A, "consumer"); await start(B, "real-provider");
    evil = createServer((req, res) => {
      let raw = ""; req.on("data", (c) => (raw += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/p2p/hello") return res.end(JSON.stringify({ v: 3, id, pub, name: "evil", url: `http://localhost:${FAKE}`, providing: true, models: [{ id: "evil-1", price: 1, tee: "none" }], box: { pub: box.pub, sig: sign({ id, box: box.pub }) }, chain: null, peers: [] }));
        if (req.url === "/p2p/infer") {
          const { obj, session } = openBox(box.priv, box.pub, JSON.parse(raw).sealed);
          const { sig: _s, ...rest } = { consumer: obj.consumer.id, provider: id, nonce: obj.auth.nonce, id: "rc_evil1", model: "evil-1", completionTokens: 1, price: 1, amount: 5000, ts: Date.now(), tee: "none" }; // promptTokens missing → NaN cost
          const receipt = { ...rest, sig: sign(rest) };
          return res.end(JSON.stringify({ enc: session.seal({ completion: { choices: [{ message: { role: "assistant", content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }, receipt }) }));
        }
        res.statusCode = 404; res.end("{}");
      });
    });
    await new Promise((r) => evil.listen(FAKE, r));
    await a("/api/peers", "POST", { url: `http://localhost:${FAKE}` });
  });
  after(() => { evil.close(); procs.forEach((p) => p.kill()); setTimeout(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })), 500); });

  test("F1: a signed receipt with missing token counts and a huge amount is rejected and never billed", async () => {
    const r = await fetch(`http://localhost:${A}/v1/chat/completions`, { method: "POST", headers: J, body: JSON.stringify({ model: "evil-1", messages: [{ role: "user", content: "hello" }] }) });
    assert.equal(r.status, 502);
    assert.equal((await a("/api/ledger")).entries.filter((e) => e.type === "spend").length, 0);
    assert.match(await (await fetch(`http://localhost:${A}/metrics`)).text(), /elyra_receipts_rejected_total\{reason="receipt token counts malformed"\} 1/);
  });

  describe("F6: provider requests are authenticated and cannot be replayed", () => {
    const post = async (wire) => { const r = await fetch(`http://localhost:${B}/p2p/infer`, { method: "POST", headers: J, body: JSON.stringify(wire) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    let hello, up;
    const seal = (payload) => ({ from: payload.consumer.id, sealed: sealTo(hello.box.pub, payload).envelope });
    const consumerKey = crypto.generateKeyPairSync("ed25519");
    const cpub = consumerKey.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const cid = sha(Buffer.from(cpub, "base64")).slice(0, 16);
    const mk = (over = {}) => {
      const body = { messages: [{ role: "user", content: "hi" }] }, ts = over.ts ?? Date.now(), nonce = over.nonce ?? crypto.randomBytes(8).toString("hex");
      const signer = over.key ?? consumerKey.privateKey;
      return { consumer: { id: cid, pub: cpub }, model: "demo-echo-1", maxPrice: 1, body, auth: { ts, nonce, sig: crypto.sign(null, Buffer.from(canon({ provider: hello.id, ts, nonce, model: "demo-echo-1", bodyHash: sha(canon(body)) })), signer).toString("base64") } };
    };
    before(async () => { hello = await (await fetch(`http://localhost:${B}/p2p/hello`)).json(); await b("/api/provide", "PUT", { enabled: true, price: 0.1 }); hello = await (await fetch(`http://localhost:${B}/p2p/hello`)).json(); up = true; });

    test("missing, forged, stale and replayed authentication are all refused; a valid one is served exactly once", async () => {
      const noAuth = mk(); delete noAuth.auth;
      assert.equal((await post(seal(noAuth))).status, 401);
      assert.equal((await post(seal(mk({ key: crypto.generateKeyPairSync("ed25519").privateKey })))).status, 401, "signed by a different key than the claimed consumer");
      assert.equal((await post(seal(mk({ ts: Date.now() - 10 * 60000 })))).status, 401, "stale timestamp");
      const good = mk();
      assert.equal((await post(seal(good))).status, 200);
      assert.equal((await post(seal(good))).status, 409, "the same nonce a second time");
      assert.ok(up);
    });
  });
});
