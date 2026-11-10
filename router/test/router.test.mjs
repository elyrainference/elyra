// Run: node --test router/test/router.test.mjs   (or: npm test)
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { DEFAULT_POLICY, rank } from "../policy.mjs";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
const J = { "content-type": "application/json" };

describe("router ranking", () => {
  const c = (model, price, tps, reputation, priv = false, extra = {}) => ({ key: model + price, model, price, tps, reputation, private: priv, privacyScore: priv ? 0.8 : 0, ...extra });
  const cands = [c("m", 1, 50, 5), c("m", 0.1, 50, 3), c("m", 0.5, 200, 4, true), c("other", 0.01, 999, 5)];

  test("price-only weights pick the cheapest listing of the requested model", () => {
    const pol = { ...DEFAULT_POLICY, weights: { price: 1, speed: 0, reputation: 0, privacy: 0 } };
    assert.equal(rank(cands, pol, "m")[0].price, 0.1);
  });
  test("auto:fastest overrides the stored policy for one request", () => {
    const pol = { ...DEFAULT_POLICY, weights: { price: 100, speed: 0, reputation: 0, privacy: 0 } };
    assert.equal(rank(cands, pol, "auto:fastest")[0].model, "other");
  });
  test("teeOnly drops non-private listings and may leave no route", () => {
    const pol = { ...DEFAULT_POLICY, teeOnly: true };
    assert.deepEqual(rank(cands, pol, "m").map((x) => x.price), [0.5]);
    assert.equal(rank([c("m", 1, 1, 1)], pol, "m").length, 0);
  });
  test("maxPrice is a hard ceiling", () => {
    const pol = { ...DEFAULT_POLICY, maxPrice: 0.2 };
    assert.ok(rank(cands, pol, "m").every((x) => x.price <= 0.2));
  });
  test("a lone candidate scores without NaN", () => {
    const [only] = rank([c("m", 1, 50, 5)], DEFAULT_POLICY, "m");
    assert.ok(Number.isFinite(only.score));
  });
});

describe("two nodes over HTTP", () => {
  const procs = [], dirs = [];
  const start = async (port, name, ...extra) => {
    const dir = mkdtempSync(join(tmpdir(), "vpr-"));
    dirs.push(dir);
    const p = spawn(process.execPath, [server, "--port", String(port), "--data", dir, "--name", name, ...extra], { stdio: "pipe" });
    procs.push(p);
    for (let i = 0; i < 300; i++) { // 30 s: boot is slow on a loaded CI box or VPS
      try { if ((await fetch(`http://localhost:${port}/p2p/hello`)).ok) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("node did not start");
  };
  const A = 18545, B = 18546, STUB = 18599;
  const a = (p, o) => fetch(`http://localhost:${A}${p}`, o);
  const aj = async (p, method = "GET", body) => (await a(p, { method, headers: J, body: body && JSON.stringify(body) })).json();
  const bj = async (p, method = "GET", body) => (await fetch(`http://localhost:${B}${p}`, { method, headers: J, body: body && JSON.stringify(body) })).json();
  const chat = (body) => a("/v1/chat/completions", { method: "POST", headers: J, body: JSON.stringify({ model: "stub-1", messages: [{ role: "user", content: "ping" }], ...body }) });

  // minimal OpenAI-compatible upstream behind provider B: 7 prompt + 11 completion tokens per call
  const stub = createServer((req, res) => {
    if (req.url.endsWith("/models")) return res.setHeader("content-type", "application/json"), res.end(JSON.stringify({ data: [{ id: "stub-1" }] }));
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const inflate = raw.includes('"inflate"');
      const usage = { prompt_tokens: 7, completion_tokens: inflate ? 100000 : 11, total_tokens: 18 };
      const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ choices: [{ delta }], ...extra })}\n\n`;
      if (JSON.parse(raw).stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(chunk({ content: "pong " }));
        res.write(chunk({ content: "pong" }, { usage }));
        return res.end("data: [DONE]\n\n");
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "stub-1", choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }], usage }));
    });
  });

  before(async () => {
    await new Promise((r) => stub.listen(STUB, r));
    await start(A, "consumer", "--no-demo");
    await start(B, "provider", "--no-demo");
    const up = await bj("/api/upstreams", "POST", { name: "stub", baseUrl: `http://localhost:${STUB}/v1` });
    await bj("/api/provide", "PUT", { enabled: true, upstreamId: up.id, price: 2, tee: "claimed" }); // $2 / MTok
    await aj("/api/peers", "POST", { url: `http://localhost:${B}` });
  });
  after(() => { stub.close(); procs.forEach((p) => p.kill()); setTimeout(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })), 300); });

  test("request is served by the peer; ledger debits exactly the signed receipt and the provider is credited the same", async () => {
    const r = await chat({});
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-elyra-route"), "peer:provider");
    assert.equal((await r.json()).choices[0].message.content, "pong");
    const expected = (18 * 2) / 1e6;
    const spend = (await aj("/api/ledger")).entries.find((e) => e.type === "spend");
    assert.ok(Math.abs(spend.amount - expected) < 1e-12, `spend ${spend.amount} vs ${expected}`);
    assert.ok(spend.receipt.sig, "receipt carries a signature");
    const earn = (await bj("/api/ledger")).entries.find((e) => e.type === "earn");
    assert.ok(Math.abs(earn.amount - expected) < 1e-12);
  });

  test("streaming through the peer: usage from upstream is billed, receipt event never reaches the client, [DONE] is last", async () => {
    const before = (await aj("/api/ledger")).entries.filter((e) => e.type === "spend").length;
    const text = await (await chat({ stream: true })).text();
    assert.ok(!text.includes("receipt"));
    assert.ok(text.trimEnd().endsWith("data: [DONE]"));
    assert.ok(text.includes("pong"));
    const entries = (await aj("/api/ledger")).entries.filter((e) => e.type === "spend");
    assert.equal(entries.length, before + 1);
    assert.equal(entries[0].p + entries[0].c, 18);
    const m = (await aj("/api/models")).models.find((x) => x.kind === "peer" && x.model === "stub-1");
    assert.ok(m.ttft > 0 && m.ttft < 5000, "a streamed answer records the time to its first token: " + m.ttft);
  });

  test("provider that raises its price after the quote is refused; router fails instead of overpaying", async () => {
    await bj("/api/provide", "PUT", { price: 5 });
    const before = (await aj("/api/ledger")).entries.filter((e) => e.type === "spend").length;
    const r = await chat({}); // consumer still holds the $2 quote until the next gossip refresh
    assert.equal(r.status, 502);
    assert.equal((await aj("/api/ledger")).entries.filter((e) => e.type === "spend").length, before);
  });

  test("TEE-only policy never routes to a clear peer, nor to one that merely CLAIMS a TEE (only a verified attestation counts)", async () => {
    await bj("/api/provide", "PUT", { price: 2, tee: "none" });
    await aj("/api/peers/refresh", "POST", {});
    await aj("/api/policy", "PUT", { teeOnly: true });
    assert.equal((await chat({})).status, 404);
    await bj("/api/provide", "PUT", { tee: "claimed" });
    await aj("/api/peers/refresh", "POST", {});
    assert.equal((await chat({})).status, 404, "a self-declared TEE is not enough");
    await aj("/api/policy", "PUT", { teeOnly: false });
  });

  test("provider rejects unsealed requests: prompts never travel in clear", async () => {
    const r = await fetch(`http://localhost:${B}/p2p/infer`, { method: "POST", headers: J, body: JSON.stringify({ from: "x", consumer: {}, model: "stub-1", body: { messages: [{ role: "user", content: "secret" }] } }) });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.type, "unsealed");
  });

  test("a provider that inflates its token count is rejected and not paid", async () => {
    await aj("/api/peers/refresh", "POST", {});
    const before = (await aj("/api/ledger")).entries.filter((e) => e.type === "spend").length;
    const r = await chat({ messages: [{ role: "user", content: "inflate" }] }); // stub reports 100k completion tokens for a 4-char answer
    assert.equal(r.status, 502);
    assert.equal((await aj("/api/ledger")).entries.filter((e) => e.type === "spend").length, before);
  });

  test("a peer announced by a stranger over loopback is not added (SSRF guard)", async () => {
    await fetch(`http://localhost:${A}/p2p/hello`, { method: "POST", headers: J, body: JSON.stringify({ url: `http://127.0.0.1:${B + 7}` }) });
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!(await aj("/api/peers")).peers.some((p) => p.url.endsWith(String(B + 7))));
  });

  test("/metrics counts routed traffic without leaking prompt text, and /healthz reports the protocol version", async () => {
    await chat({ messages: [{ role: "user", content: "TOP-SECRET-PROMPT-TEXT" }] });
    const m = await (await a("/metrics")).text();
    assert.match(m, /elyra_route_total\{kind="peer",result="ok"\} [1-9]/);
    assert.match(m, /elyra_tokens_total\{dir="out"\} [1-9]/);
    assert.ok(!m.includes("TOP-SECRET-PROMPT-TEXT"));
    const h = await (await a("/healthz")).json();
    assert.equal(h.ok, true);
    assert.equal(h.protocol, 3);
  });

  test("a peer speaking another protocol version is refused with an explanation", async () => {
    const { publicKey } = crypto.generateKeyPairSync("ed25519");
    const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const id = crypto.createHash("sha256").update(Buffer.from(pub, "base64")).digest("hex").slice(0, 16);
    const old = createServer((_q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ v: 1, id, pub, name: "old-node", models: [] })); });
    await new Promise((r) => old.listen(18599 + 1, r));
    try {
      const r = await aj("/api/peers", "POST", { url: "http://localhost:18600" });
      assert.match(r.error.message, /protocol v1/);
    } finally { old.close(); }
  });

  test("control API refuses cross-site browser requests and non-local Host headers", async () => {
    const evil = await a("/api/policy", { method: "PUT", headers: { ...J, origin: "https://evil.example" }, body: "{}" });
    assert.equal(evil.status, 403);
    const status = await new Promise((res, rej) =>
      httpRequest({ host: "127.0.0.1", port: A, path: "/api/status", headers: { host: "evil.example" } }, (r) => (r.resume(), res(r.statusCode))).on("error", rej).end());
    assert.equal(status, 403);
  });
});

describe("encryption at rest", () => {
  const run = (dir, env, ms = 20000) => new Promise((resolve) => {
    const p = spawn(process.execPath, [server, "--port", "18577", "--data", dir, "--no-demo"], { env: { ...process.env, ...env }, stdio: "pipe" });
    let out = "";
    p.stdout.on("data", (d) => { out += d; if (/\n\s+data\s/.test(out)) setTimeout(() => p.kill(), 300); }); p.stderr.on("data", (d) => (out += d)); // banner prints `data` last
    p.on("exit", (code) => resolve({ code, out }));
    setTimeout(() => p.kill(), ms).unref?.();
  });
  test("secrets are encrypted with ELYRA_PASSPHRASE, keep the same identity, and cannot be opened without it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vpr-vault-"));
    try {
      const a = await run(dir, { ELYRA_PASSPHRASE: "correct horse" });
      const id1 = /node ([0-9a-f]{16})/.exec(a.out)?.[1];
      assert.ok(id1, a.out);
      const files = ["identity.json", "wallet.json"].map((f) => readFileSync(join(dir, f), "utf8"));
      for (const f of files) { assert.ok(JSON.parse(f).enc === 1); assert.ok(!/privateKey|"priv"/.test(f)); }
      const b = await run(dir, { ELYRA_PASSPHRASE: "correct horse" });
      assert.equal(/node ([0-9a-f]{16})/.exec(b.out)?.[1], id1);
      const c = await run(dir, { ELYRA_PASSPHRASE: "" });
      assert.notEqual(c.code, 0);
      assert.match(c.out, /ELYRA_PASSPHRASE/);
      const d = await run(dir, { ELYRA_PASSPHRASE: "wrong" });
      assert.match(d.out, /wrong ELYRA_PASSPHRASE/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
