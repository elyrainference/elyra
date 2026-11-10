// Reference prices from OpenRouter's public list: exact family/version/size matches only. Run: node --test router/test/reference.test.mjs
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildIndex, lookup, parseModel } from "../lib/reference.mjs";
import { createPublicTry } from "../http/public.mjs";

const OR = [
  { id: "meta-llama/llama-3.1-8b-instruct", pricing: { prompt: "0.00000005", completion: "0.00000008" } },
  { id: "aion-labs/aion-rp-llama-3.1-8b", pricing: { prompt: "0.0000008", completion: "0.0000016" } },
  { id: "meta-llama/llama-3.2-1b-instruct", pricing: { prompt: "0.000000027", completion: "0.000000201" } },
  { id: "qwen/qwen-2.5-coder-32b-instruct", pricing: { prompt: "0.00000066", completion: "0.000001" } },
  { id: "deepseek/deepseek-r1-0528", pricing: { prompt: "0.0000005", completion: "0.00000215" } },
  { id: "meta-llama/llama-3.3-70b-instruct:free", pricing: { prompt: "0", completion: "0" } },
  { id: "meta-llama/llama-3.3-70b-instruct", pricing: { prompt: "0.0000001", completion: "0.00000032" } },
  { id: "meta-llama/llama-3.3-70b-instruct:extended", pricing: { prompt: "0.00000001", completion: "0.00000002" } },
  { id: "vendor/my-phi-3-3b-merge", pricing: { prompt: "0.00000001", completion: "0.00000001" } },
  { id: "mistralai/mistral-7b-instruct", pricing: { prompt: "0.0000002", completion: "0.0000002" } },
  { id: "google/gemma-2-9b-it", pricing: { prompt: "0.00000003", completion: "0.00000009" } },
  { id: "vendor-a/qwen2.5-14b-instruct", pricing: { prompt: "0.0000002", completion: "0.0000004" } },
  { id: "vendor-b/qwen-2.5-14b-instruct", pricing: { prompt: "0.0000001", completion: "0.0000003" } },
  { id: "broken/llama-3.1-8b-instruct", pricing: { prompt: "x", completion: null } },
  null, { id: 5 },
];
const idx = buildIndex(OR);

describe("parseModel", () => {
  test("plain family, version, size; quantisation and instruct tags are fine, distills and variants are not", () => {
    assert.deepEqual(parseModel("llama3.1:8b"), { family: "llama", version: "3.1", variant: "", size: "8" });
    assert.deepEqual(parseModel("qwen2.5-coder:7b"), { family: "qwen", version: "2.5", variant: "coder", size: "7" });
    assert.equal(parseModel("llama3.1:8b-instruct-q4_K_M").size, "8"); assert.equal(parseModel("mistral:7b").version, "");
    for (const bad of ["deepseek-r1:8b", "llama3.2-vision:11b", "llama3.1:8b-distill", "llama3.1", "x:latest", "llama3.1:70b-moe", "", "a:b:c"]) assert.equal(parseModel(bad), null, bad);
  });
});

describe("lookup: exact matches only", () => {
  test("same family, version and size gives the list price per million tokens", () => {
    assert.deepEqual(lookup(idx, "llama3.1:8b"), { source: "OpenRouter", id: "meta-llama/llama-3.1-8b-instruct", inPerM: 0.05, outPerM: 0.08 });
    assert.deepEqual(lookup(idx, "llama3.2:1b"), { source: "OpenRouter", id: "meta-llama/llama-3.2-1b-instruct", inPerM: 0.027, outPerM: 0.201 });
    assert.equal(lookup(idx, "mistral:7b").id, "mistralai/mistral-7b-instruct"); assert.equal(lookup(idx, "gemma2:9b").id, "google/gemma-2-9b-it");
  });
  test("no reference rather than a look-alike: a 7B coder is not the 32B coder, a distilled R1 is not R1, a name that only contains the family is not it", () => {
    assert.equal(lookup(idx, "qwen2.5-coder:7b"), null); assert.equal(lookup(idx, "qwen2.5-coder:32b")?.id, "qwen/qwen-2.5-coder-32b-instruct");
    assert.equal(lookup(idx, "deepseek-r1:8b"), null); assert.equal(lookup(idx, "llama3.1:70b"), null); assert.equal(lookup(idx, "phi3:3b"), null, "a merge whose name merely contains phi-3 and 3b");
    assert.notEqual(lookup(idx, "llama3.1:8b").id, "aion-labs/aion-rp-llama-3.1-8b", "a fine-tune that contains the name");
  });
  test("free variants, unpriced and malformed entries never count; several vendors: the cheapest, named", () => {
    assert.equal(lookup(idx, "llama3.3:70b").inPerM, 0.1, "the :free and :extended variants are ignored even when cheaper");
    assert.equal(lookup(idx, "qwen2.5:14b").id, "vendor-b/qwen-2.5-14b-instruct");
    assert.equal(idx.has("llama-3.1-8b"), true); assert.equal(idx.get("llama-3.1-8b").length, 1, "the entry with unusable prices was dropped");
    assert.equal(lookup(null, "llama3.1:8b"), null); assert.equal(lookup(buildIndex(undefined), "llama3.1:8b"), null); assert.equal(buildIndex("nope").size, 0);
  });
});

describe("market() carries the reference (opt-in, never blocking, never fatal)", () => {
  const node = () => ({ cands: () => [{ kind: "self", hosted: false, simulated: false, sourceId: "u1", model: "llama3.1:8b", key: "k", reputation: 5, price: 0, tps: 60 }], upstreamById: () => ({ kind: "openai", name: "x" }),
    state: { name: "n", peers: {}, stats: {}, chain: {} }, chain: { configured: () => false }, provideModels: () => [] });
  const mk = (env, fetchList, t = { v: 1_000_000 }) => ({ p: createPublicTry(node(), { staticFile: async () => {}, env: { ELYRA_PUBLIC_TRY: "1", ...env }, now: () => t.v, fetchList }), t });
  const tick = () => new Promise((r) => setTimeout(r, 20));
  test("off by default: nothing is fetched and no reference is shown", async () => {
    let calls = 0; const { p } = mk({}, async () => { calls++; return OR; });
    p.market(); await tick(); assert.equal(calls, 0); assert.equal(p.market().models[0].reference, null);
  });
  test("on: the first call does not wait for the network; the next one carries the reference; the list is fetched once per six hours", async () => {
    let calls = 0; const { p, t } = mk({ ELYRA_REFERENCE_PRICES: "1" }, async () => { calls++; return OR; });
    assert.equal(p.market().models[0].reference, null, "first view is not blocked"); await tick();
    assert.equal(p.market().models[0].reference.id, "meta-llama/llama-3.1-8b-instruct"); p.market(); assert.equal(calls, 1);
    t.v += 5 * 3_600_000; p.market(); await tick(); assert.equal(calls, 1); t.v += 2 * 3_600_000; p.market(); await tick(); assert.equal(calls, 2);
  });
  test("a failing source leaves the market working without a reference and is retried later, not in a loop", async () => {
    let calls = 0; const { p, t } = mk({ ELYRA_REFERENCE_PRICES: "1" }, async () => { calls++; throw new Error("down"); });
    for (let i = 0; i < 5; i++) { assert.equal(p.market().models[0].reference, null); await tick(); }
    assert.equal(calls, 1); t.v += 31 * 60_000; p.market(); await tick(); assert.equal(calls, 2);
  });
});
