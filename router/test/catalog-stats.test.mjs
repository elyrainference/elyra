// Tests for tools/catalog-stats.mjs: deduplication rules, vendor normalization, date-pin collapsing, and hosted vs peer separation.
// Run: node --test router/test/catalog-stats.test.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, test } from "node:test";
import {
  DEDUPE_RULES,
  canonicalModelKey,
  classifySourceKind,
  formatReport,
  isMetaRouter,
  isMovingAlias,
  measureCatalog,
  normalizeVendor,
  sourcesFromState,
  sourcesFromUrl,
  stripTierSuffix,
} from "../../tools/catalog-stats.mjs";

describe("isMetaRouter and isMovingAlias", () => {
  test("openrouter/*, auto slugs, and negative-priced routers are meta-routers; free/paid models are not", () => {
    for (const m of [
      "openrouter/auto",
      "openrouter/free",
      "openrouter/bodybuilder",
      "router/auto",
      "x/auto-code",
      { id: "typesafe/jev-router", pricing: { prompt: "-1", completion: "-1" } },
      { id: "nvidia/switchyard", pricing: { prompt: "0", completion: "-1" } },
      "",
    ]) {
      assert.equal(isMetaRouter(m), true, JSON.stringify(m));
    }
    for (const m of [
      "openai/gpt-5.2",
      { id: "liquid/lfm-3-1.7b:free", pricing: { prompt: "0", completion: "0" } },
      { id: "qwen/qwen-2.5-coder-7b-instruct", pricing: { prompt: "0.0000001", completion: "0.0000002" } },
      "llama3.2:1b",
    ]) {
      assert.equal(isMetaRouter(m), false, JSON.stringify(m));
    }
  });

  test("moving '~vendor/*-latest' aliases are flagged separately from versioned models", () => {
    assert.equal(isMovingAlias("~openai/gpt-sol-latest"), true);
    assert.equal(isMovingAlias({ id: "~anthropic/claude-sonnet-latest" }), true);
    assert.equal(isMovingAlias("openai/gpt-6.1-sol"), false);
  });
});

describe("stripTierSuffix, normalizeVendor, and canonicalModelKey", () => {
  test("billing/throughput tiers (:free, :batch, :extended, :latest) collapse while Ollama parameter sizes (:1b, :8b, :70b) stay distinct", () => {
    assert.equal(stripTierSuffix("liquid/lfm-3-1.7b:free").baseId, "liquid/lfm-3-1.7b");
    assert.equal(stripTierSuffix("openai/gpt-6.1-terra:batch").baseId, "openai/gpt-6.1-terra");
    assert.equal(stripTierSuffix("meta-llama/llama-3.3-70b-instruct:extended").baseId, "meta-llama/llama-3.3-70b-instruct");
    assert.equal(stripTierSuffix("nomic-embed-text:latest").baseId, "nomic-embed-text");

    assert.equal(stripTierSuffix("llama3.2:1b").baseId, "llama3.2:1b");
    assert.equal(stripTierSuffix("llama3.2:3b").baseId, "llama3.2:3b");
    assert.equal(stripTierSuffix("llama3.1:8b-instruct-q4_K_M").baseId, "llama3.1:8b");
    assert.notEqual(canonicalModelKey("llama3.2:1b").key, canonicalModelKey("llama3.2:3b").key);
  });

  test("same open-weights model across Ollama, OpenRouter and third-party vendor prefixes maps to one canonical key; distills and fine-tunes do not", () => {
    const k1 = canonicalModelKey("llama3.2:1b");
    const k2 = canonicalModelKey("llama3.2:1b-instruct-q4_K_M");
    const k3 = canonicalModelKey("meta-llama/llama-3.2-1b-instruct");
    assert.equal(k1.key, "meta/llama-3.2-1b");
    assert.equal(k2.key, "meta/llama-3.2-1b");
    assert.equal(k3.key, "meta/llama-3.2-1b");
    assert.equal(k1.vendor, "meta");

    assert.equal(canonicalModelKey("qwen2.5-coder:7b").key, "qwen/qwen-2.5-coder-7b");
    assert.equal(canonicalModelKey("qwen/qwen-2.5-coder-7b-instruct").key, "qwen/qwen-2.5-coder-7b");
    assert.notEqual(canonicalModelKey("qwen2.5-coder:7b").key, canonicalModelKey("qwen/qwen-2.5-coder-32b-instruct").key);

    assert.equal(canonicalModelKey("vendor-a/qwen2.5-14b-instruct").key, "qwen/qwen-2.5-14b");
    assert.equal(canonicalModelKey("vendor-b/qwen-2.5-14b-instruct").key, "qwen/qwen-2.5-14b");

    // Distill (deepseek-r1:8b) must not merge with full deepseek/deepseek-r1
    assert.notEqual(canonicalModelKey("deepseek-r1:8b").key, canonicalModelKey("deepseek/deepseek-r1").key);
    assert.notEqual(canonicalModelKey("deepseek-r1:8b").key, canonicalModelKey("deepseek-r1:14b").key);
    // Fine-tune must not merge with base Llama 3.1 8B
    assert.notEqual(canonicalModelKey("aion-labs/aion-rp-llama-3.1-8b").key, canonicalModelKey("meta-llama/llama-3.1-8b-instruct").key);
  });

  test("vendor aliases merge multi-prefix makers and infer makers for local models", () => {
    assert.equal(normalizeVendor("meta-llama/llama-3.3-70b-instruct"), "meta");
    assert.equal(normalizeVendor("meta/muse-wonder"), "meta");
    assert.equal(normalizeVendor("bytedance-seed/seed-2.0-mini"), "bytedance");
    assert.equal(normalizeVendor("bytedance/ui-tars-1.5-7b"), "bytedance");
    assert.equal(normalizeVendor("mistralai/mistral-large-2512"), "mistral");
    assert.equal(normalizeVendor("~openai/gpt-sol-latest"), "openai");
    assert.equal(normalizeVendor("deepseek-r1:8b"), "deepseek");
    assert.equal(normalizeVendor("gemma2:9b"), "google");
    assert.equal(normalizeVendor("phi3:3.8b"), "microsoft");
  });
});

describe("measureCatalog: deduplication, date pins, and hosted vs peer separation", () => {
  test("counts unique models and vendors accurately, separates hosted from P2P/self, and satisfies the entry accounting identity", () => {
    const sources = [
      {
        name: "demo-engine",
        kind: "demo",
        simulated: true,
        models: ["gpt-5.2", "claude-opus-4.6", "llama-4-405b"],
      },
      {
        name: "offline-gpu",
        kind: "remote",
        remote: true,
        online: false,
        models: ["qwen2.5:72b"],
      },
      {
        name: "local-ollama",
        kind: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        online: true,
        models: ["llama3.2:1b", "llama3.2:1b-instruct-q4_K_M", "qwen2.5-coder:7b"],
      },
      {
        name: "peer-seller-1",
        kind: "peer",
        online: true,
        models: [{ id: "llama3.2:1b" }, { id: "deepseek-r1:8b" }],
      },
      {
        name: "openrouter",
        kind: "hosted",
        baseUrl: "https://openrouter.ai/api/v1",
        online: true,
        models: [
          { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
          { id: "typesafe/jev-router", pricing: { prompt: "-1", completion: "-1" } },
          { id: "~openai/gpt-sol-latest", pricing: { prompt: "0.000002", completion: "0.00001" } },
          { id: "meta-llama/llama-3.2-1b-instruct", pricing: { prompt: "0.00000003", completion: "0.0000002" } },
          { id: "meta-llama/llama-3.2-1b-instruct:free", pricing: { prompt: "0", completion: "0" } },
          { id: "meta/muse-wonder", pricing: { prompt: "0.000001", completion: "0.000002" } },
          { id: "openai/gpt-5.2", pricing: { prompt: "0.000002", completion: "0.000008" } },
          { id: "openai/gpt-5.2:batch", pricing: { prompt: "0.000001", completion: "0.000004" } },
          { id: "openai/gpt-5.2-chat", pricing: { prompt: "0.000002", completion: "0.000008" } },
          { id: "openai/gpt-4o", pricing: { prompt: "0.0000025", completion: "0.00001" } },
          { id: "openai/gpt-4o-2024-11-20", pricing: { prompt: "0.0000025", completion: "0.00001" } },
          { id: "deepseek/deepseek-r1-0528", pricing: { prompt: "0.0000005", completion: "0.000002" } },
          { id: "mistralai/codestral-2501", pricing: { prompt: "0.0000003", completion: "0.0000009" } },
          { id: "mistralai/codestral-2508", pricing: { prompt: "0.0000003", completion: "0.0000009" } },
        ],
      },
    ];

    const res = measureCatalog(sources);
    assert.equal(res.excluded.simulatedSources, 1);
    assert.equal(res.excluded.simulatedModels, 3);
    assert.equal(res.excluded.offlineSources, 1);
    assert.equal(res.excluded.offlineModels, 1);
    assert.equal(res.excluded.metaRouters, 2);
    assert.equal(res.excluded.movingAliases, 1);

    // Accounting identity: rawEntries = keptEntries + metaRouters + movingAliases
    assert.equal(res.totals.rawEntries, res.totals.keptEntries + res.excluded.metaRouters + res.excluded.movingAliases);
    // keptEntries = uniqueModels + exactDuplicates + tierVariants + chatAndFormatVariants + datedSnapshots
    const d = res.deduped;
    assert.equal(
      res.totals.keptEntries,
      res.totals.uniqueModels + d.exactDuplicates + d.tierVariants + d.chatAndFormatVariants + d.datedSnapshots
    );

    // Unique canonical models across all active sources:
    // 1. meta/llama-3.2-1b (on local, peer, and hosted!)
    // 2. qwen/qwen-2.5-coder-7b (local)
    // 3. deepseek/deepseek-r1:8b (peer)
    // 4. meta/muse-wonder (hosted, merges vendor meta-llama + meta -> meta)
    // 5. openai/gpt-5.2 (hosted, collapses :batch and -chat)
    // 6. openai/gpt-4o (hosted, collapses gpt-4o-2024-11-20)
    // 7. deepseek/deepseek-r1-0528 (hosted, kept because undated deepseek/deepseek-r1 is absent)
    // 8. mistral/codestral-2501 (hosted, kept because undated mistral/codestral is absent)
    // 9. mistral/codestral-2508 (hosted, kept because undated mistral/codestral is absent)
    assert.equal(res.totals.uniqueModels, 9);
    assert.equal(res.models.includes("deepseek/deepseek-r1-0528"), true);
    assert.equal(res.models.includes("mistral/codestral-2501"), true);
    assert.equal(res.models.includes("mistral/codestral-2508"), true);
    assert.deepEqual(res.vendors, ["deepseek", "meta", "mistral", "openai", "qwen"]);
    assert.equal(res.totals.uniqueVendors, 5);
    assert.equal(d.datedSnapshots, 1, "gpt-4o-2024-11-20 collapsed into gpt-4o, while deepseek-r1-0528 and codestral-2501/2508 stayed");
    assert.equal(d.vendorAliases, 1, "meta-llama and meta merged into meta");

    // Hosted vs Peer vs Self separation
    assert.equal(res.byHosting.peer.uniqueModels, 2); // llama-3.2-1b, deepseek-r1:8b
    assert.equal(res.byHosting.local.uniqueModels, 2); // llama-3.2-1b, qwen-2.5-coder-7b
    assert.equal(res.byHosting.remote.uniqueModels, 0); // offline-gpu excluded
    assert.equal(res.byHosting.p2pAndSelf.uniqueModels, 3); // llama-3.2-1b, qwen-2.5-coder-7b, deepseek-r1:8b
    assert.equal(res.byHosting.hosted.uniqueModels, 7); // llama-3.2-1b, muse-wonder, gpt-5.2, gpt-4o, deepseek-r1-0528, codestral-2501, codestral-2508

    // With includeOffline: true, offline-gpu adds qwen-2.5-72b to remote and p2pAndSelf
    const withOff = measureCatalog(sources, { includeOffline: true });
    assert.equal(withOff.byHosting.remote.uniqueModels, 1);
    assert.equal(withOff.totals.uniqueModels, 10);
    assert.equal(DEDUPE_RULES.length, 6);
    assert.match(formatReport(res), /Unique canonical:\s+9 models from 5 vendors/);
  });

  test("classifySourceKind distinguishes simulated, peer, local, remote tunnel, and hosted URLs", () => {
    assert.equal(classifySourceKind({ kind: "demo" }), "simulated");
    assert.equal(classifySourceKind({ simulated: true }), "simulated");
    assert.equal(classifySourceKind({ kind: "peer" }), "peer");
    assert.equal(classifySourceKind({ baseUrl: "http://127.0.0.1:11435/v1", remote: true }), "remote");
    assert.equal(classifySourceKind({ baseUrl: "http://127.0.0.1:11434/v1", remote: false }), "local");
    assert.equal(classifySourceKind({ baseUrl: "https://openrouter.ai/api/v1" }), "hosted");
  });

  test("sourcesFromState probes upstreams and sourcesFromUrl parses both /v1/models and /pub/market", async () => {
    const srv = await new Promise((resolve) => {
      const s = createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/v1/models") {
          res.end(JSON.stringify({ data: [{ id: "llama3.2:1b" }, { id: "qwen2.5-coder:7b" }] }));
        } else if (req.url === "/down/models") {
          res.statusCode = 502;
          res.end("bad gateway");
        } else if (req.url === "/pub/market") {
          res.end(JSON.stringify({
            node: { name: "live" },
            totals: { models: 2, sellers: 2 },
            models: [
              { model: "llama3.2:1b", offers: [{ where: "this-node", privacy: "local" }] },
              { model: "qwen2.5:14b", offers: [{ where: "peer", privacy: "none" }] },
            ],
          }));
        } else {
          res.statusCode = 404;
          res.end();
        }
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const port = srv.address().port;
      const state = {
        upstreams: [
          { id: "u1", name: "local-ok", baseUrl: `http://127.0.0.1:${port}/v1`, models: ["llama3.2:1b"] },
          { id: "u2", name: "gpu-down", baseUrl: `http://127.0.0.1:${port}/down`, remote: true, models: ["deepseek-r1:8b"] },
        ],
        peers: {
          p1: { id: "p1", name: "peer-a", providing: true, online: true, models: [{ id: "llama3.2:1b" }] },
          p2: { id: "p2", name: "peer-off", providing: true, online: false, models: [{ id: "mistral:7b" }] },
        },
      };
      const probed = await sourcesFromState(state, { probe: true });
      const rProbed = measureCatalog(probed);
      assert.equal(rProbed.byHosting.local.uniqueModels, 2, "probed /v1/models discovered the second local model");
      assert.equal(rProbed.excluded.offlineSources, 2, "502 upstream and offline peer excluded");

      const mktSources = await sourcesFromUrl(`http://127.0.0.1:${port}/pub/market`);
      const rMkt = measureCatalog(mktSources);
      assert.equal(rMkt.byHosting.local.uniqueModels, 1);
      assert.equal(rMkt.byHosting.peer.uniqueModels, 1);
      assert.equal(rMkt.totals.uniqueModels, 2);
    } finally {
      srv.closeAllConnections?.();
      srv.close();
    }
  });
});
