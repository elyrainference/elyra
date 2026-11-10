// What a seller can set: per-model prices and how they reach the offer. Run: node --test router/test/provide.test.mjs
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cleanPrices, createProvideModels } from "../core/provider/models.mjs";

const mk = (provide, models = ["a", "b", "c"]) => createProvideModels(
  { state: { stats: {}, provide: { enabled: true, upstreamId: "u", price: 0.1, tee: "none", models: [], ...provide } }, teeMode: false },
  { upstreamById: () => ({ id: "u", kind: "openai", baseUrl: "http://x/v1", models }), tee: { active: () => false } },
);

describe("per-model prices", () => {
  test("a model with its own price uses it; the others use the default; zero is a valid price", () => {
    const o = Object.fromEntries(mk({ prices: { a: 0.3, b: 0 } })().map((m) => [m.id, m.price]));
    assert.deepEqual(o, { a: 0.3, b: 0, c: 0.1 });
  });
  test("only offered models are listed, with their prices; an old state without prices still works", () => {
    assert.deepEqual(mk({ models: ["b"], prices: { a: 9 } })().map((m) => [m.id, m.price]), [["b", 0.1]]);
    assert.equal(mk({})()[0].price, 0.1);
  });
  test("nothing is offered when providing is off", () => { assert.deepEqual(mk({ enabled: false, prices: { a: 1 } })(), []); });
  test("cleanPrices keeps plain non-negative numbers and drops everything else", () => {
    assert.deepEqual(cleanPrices({ ok: "0.25", zero: 0, neg: -1, nan: "abc", empty: "", inf: Infinity, huge: 1e9, nul: null, obj: {}, "": 1, ["x".repeat(121)]: 1 }), { ok: 0.25, zero: 0 });
    for (const bad of [null, undefined, [], "str", 5]) assert.deepEqual(cleanPrices(bad), {});
  });
  test("a hostile key set cannot grow the state without bound", () => {
    const big = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => ["m" + i, 1])); assert.equal(Object.keys(cleanPrices(big)).length, 300);
    assert.equal(Object.prototype.hasOwnProperty.call(cleanPrices(JSON.parse('{"__proto__":{"x":1},"a":1}')), "x"), false);
  });
});

describe("multi-source and all-healthy-local-sources offering", () => {
  const ups = [
    { id: "demo-engine", kind: "demo", baseUrl: "", models: ["demo-echo-1"], builtin: true },
    { id: "gpu", kind: "openai", baseUrl: "http://127.0.0.1:11435/v1", remote: true, models: ["qwen-32b", "deepseek-r1"] },
    { id: "cpu", kind: "openai", baseUrl: "http://127.0.0.1:11434/v1", remote: false, models: ["llama3.2:1b", "qwen-32b"] },
    { id: "hosted", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", remote: false, models: ["gpt-4o"] },
  ];
  const mkMulti = (provide, upMap = { gpu: true, cpu: true, hosted: true }) => createProvideModels(
    { state: { stats: {}, provide: { enabled: true, upstreamId: "gpu", upstreamIds: [], price: 0.2, prices: {}, tee: "none", models: [], ...provide } }, teeMode: false },
    { upstreams: () => ups, upstreamById: (id) => ups.find((u) => u.id === id), upstreamUp: (id) => upMap[id] !== false, tee: { active: () => false } },
  );

  test("explicit upstreamIds offers models from all healthy listed sources, deduplicates in order, and keeps CPU live when GPU is offline", () => {
    const both = mkMulti({ upstreamIds: ["gpu", "cpu"], prices: { "llama3.2:1b": 0.05, "qwen-32b": 0.8 } });
    assert.deepEqual(both().map((m) => [m.id, m.price]), [["qwen-32b", 0.8], ["deepseek-r1", 0.2], ["llama3.2:1b", 0.05]]);
    assert.equal(both.upstreamFor("qwen-32b")?.id, "gpu");
    assert.equal(both.upstreamFor("llama3.2:1b")?.id, "cpu");

    const gpuDown = mkMulti({ upstreamIds: ["gpu", "cpu"], prices: { "llama3.2:1b": 0.05, "qwen-32b": 0.8 } }, { gpu: false, cpu: true });
    assert.deepEqual(gpuDown().map((m) => [m.id, m.price]), [["llama3.2:1b", 0.05], ["qwen-32b", 0.8]]);
    assert.equal(gpuDown.upstreamFor("llama3.2:1b")?.id, "cpu");
    assert.equal(gpuDown.upstreamFor("qwen-32b")?.id, "cpu", "falls back to healthy CPU source for shared model");
    assert.equal(gpuDown.upstreamFor("deepseek-r1"), null, "offline GPU-only model cannot be resolved");
  });

  test("upstreamId '*' offers all healthy local/tunnel sources, never demo-engine or hosted API keys, and never marks a remote tunnel as TEE", () => {
    const allUp = mkMulti({ upstreamId: "*", tee: "claimed", prices: { "llama3.2:1b": 0 } });
    assert.deepEqual(allUp().map((m) => [m.id, m.price, m.tee]), [
      ["qwen-32b", 0.2, "none"],
      ["deepseek-r1", 0.2, "none"],
      ["llama3.2:1b", 0, "claimed"],
    ]);
    const gpuDown = mkMulti({ upstreamId: "*", prices: { "llama3.2:1b": 0.03 } }, { gpu: false, cpu: true });
    assert.deepEqual(gpuDown().map((m) => [m.id, m.price]), [["llama3.2:1b", 0.03], ["qwen-32b", 0.2]]);
  });

  test("end-to-end node: multi-source seller serves both sources, and keeps CPU priced in /pub/market and /p2p/hello when GPU goes down", async () => {
    const { createServer } = await import("node:http");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const crypto = await import("node:crypto");
    const { createNode } = await import("../core/node.mjs");
    const { createApi } = await import("../http/api.mjs");
    const { createPublicTry } = await import("../http/public.mjs");
    const { sealTo } = await import("../seal.mjs");
    const { canon, sha } = await import("../lib/canon.mjs");

    let gpuAlive = true;
    const mkSrv = (tag, models, liveFn = () => true) => createServer((req, res) => {
      if (!liveFn()) { res.writeHead(503); return res.end("offline"); }
      if (req.url.endsWith("/models")) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ data: models.map((id) => ({ id })) })); }
      req.resume(); req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `from-${tag}` } }], usage: { prompt_tokens: 4, completion_tokens: 2 } }));
      });
    });
    const gpuSrv = mkSrv("gpu", ["gpu-70b"], () => gpuAlive);
    const cpuSrv = mkSrv("cpu", ["cpu-1b"]);
    await new Promise((r) => gpuSrv.listen(0, "127.0.0.1", r));
    await new Promise((r) => cpuSrv.listen(0, "127.0.0.1", r));
    const dir = mkdtempSync(join(tmpdir(), "vpr-multi-"));
    const node = await createNode({ dataDir: dir, port: 18991, host: "127.0.0.1", demoNetwork: false });
    const api = createApi(node);
    const pub = createPublicTry(node, { staticFile: async () => {}, env: { ELYRA_PUBLIC_TRY: "1" } });
    const callApi = async (method, path, body) => {
      let code, out;
      const req = { method, headers: { "content-type": "application/json" }, [Symbol.asyncIterator]: async function* () { if (body) yield Buffer.from(JSON.stringify(body)); } };
      const res = { writeHead(c) { code = c; }, end(b) { out = JSON.parse(b); } };
      await api(req, res, path, new URLSearchParams());
      return { code, out };
    };
    try {
      const upGpu = (await callApi("POST", "/api/upstreams", { name: "gpu", baseUrl: `http://127.0.0.1:${gpuSrv.address().port}/v1`, remote: true })).out;
      const upCpu = (await callApi("POST", "/api/upstreams", { name: "cpu", baseUrl: `http://127.0.0.1:${cpuSrv.address().port}/v1` })).out;

      await assert.rejects(() => callApi("PUT", "/api/provide", { upstreamIds: ["nope"] }), /unknown upstream/);
      await assert.rejects(() => callApi("PUT", "/api/provide", { upstreamIds: [] }), /upstreamIds/);

      const pr = (await callApi("PUT", "/api/provide", { enabled: true, upstreamIds: [upGpu.id, upCpu.id], price: 0.5, prices: { "cpu-1b": 0.04 } })).out;
      assert.deepEqual(pr.offered.map((m) => [m.id, m.price]), [["gpu-70b", 0.5], ["cpu-1b", 0.04]]);

      const hello = node.helloInfo();
      const cKey = crypto.generateKeyPairSync("ed25519");
      const cpub = cKey.publicKey.export({ type: "spki", format: "der" }).toString("base64");
      const cid = sha(Buffer.from(cpub, "base64")).slice(0, 16);
      const infer = async (model) => {
        const body = { messages: [{ role: "user", content: "hi" }] }, ts = Date.now(), nonce = crypto.randomBytes(8).toString("hex");
        const payload = { consumer: { id: cid, pub: cpub }, model, maxPrice: 1, body, auth: { ts, nonce, sig: crypto.sign(null, Buffer.from(canon({ provider: hello.id, ts, nonce, model, bodyHash: sha(canon(body)) })), cKey.privateKey).toString("base64") } };
        let resJson;
        await node.serve({ from: cid, sealed: sealTo(hello.box.pub, payload).envelope }, { head() {}, json(o) { resJson = o; } }, new AbortController());
        return resJson;
      };
      assert.ok((await infer("gpu-70b")).enc);
      assert.ok((await infer("cpu-1b")).enc);

      // Now GPU goes offline (2 failed health probes)
      gpuAlive = false;
      await node.probeAll();
      await node.probeAll();
      assert.equal(node.upstreamUp(upGpu.id), false);
      assert.equal(node.upstreamUp(upCpu.id), true);

      assert.deepEqual(node.provideModels().map((m) => [m.id, m.price]), [["cpu-1b", 0.04]]);
      const mkt = pub.market();
      assert.deepEqual(mkt.models.map((m) => [m.model, m.cheapest]), [["cpu-1b", 0.04]]);
      assert.equal(mkt.totals.cheapest, 0.04, "CPU model stays priced for sale when GPU is down");
      await assert.rejects(() => infer("gpu-70b"), /not offered here/);
      assert.ok((await infer("cpu-1b")).enc);
    } finally {
      node.close(); gpuSrv.close(); cpuSrv.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
