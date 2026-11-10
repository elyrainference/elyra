// Routing plan: a live listing always beats the simulated market for the same request. Run: node --test router/test/market.test.mjs
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createMarket } from "../core/candidates.mjs";
import { createSettlement } from "../core/settlement.mjs";
import { DEFAULT_POLICY } from "../policy.mjs";

const catalog = {
  peers: [{ id: "p1", name: "community · #1", region: "eu", kind: "community" }],
  listings: [
    { peerId: "p1", model: "gpt-x", logo: "", vendorName: "x", price: 0.01, tps: 400, reputation: 5, ctx: 8000, tee: "none" },
    { peerId: "p1", model: "llama3.2:1b", logo: "", vendorName: "meta", price: 0.01, tps: 400, reputation: 5, ctx: 8000, tee: "none" },
  ],
};
const demoEngine = { id: "demo-engine", kind: "demo", name: "Demo engine", baseUrl: "", models: ["demo-echo-1"], price: 0 };
const ollama = { id: "up1", kind: "openai", name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", models: ["llama3.2:1b"], price: 0 };

const market = (ups, demoNetwork = true) => createMarket(
  { state: { stats: {}, peers: {}, settings: { demoNetwork }, policy: DEFAULT_POLICY, chain: { escrow: "" } }, identity: { id: "me" }, chain: { configured: () => false } },
  { catalog, upstreams: () => ups, repOf: () => 5 },
);

describe("live beats simulated", () => {
  test("with nothing live the demo market still answers (so a fresh install has something to show)", () => {
    const m = market([demoEngine]);
    assert.equal(m.plan("auto")[0].simulated, true);
    assert.ok(m.plan("gpt-x").length > 0);
  });

  test("once a real source exists, auto and every auto:* shorthand route only to live listings", () => {
    const m = market([demoEngine, ollama]);
    for (const model of ["auto", "auto:cheapest", "auto:fastest", "auto:best"]) {
      const p = m.plan(model);
      assert.ok(p.length > 0, model);
      assert.ok(p.every((c) => !c.simulated), `${model} must not pick a simulated peer`);
      assert.equal(p[0].model, "llama3.2:1b");
    }
  });

  test("a named model that exists live ignores a cheaper, faster simulated listing of the same name", () => {
    const p = market([demoEngine, ollama]).plan("llama3.2:1b");
    assert.equal(p.length, 1);
    assert.equal(p[0].simulated, false);
  });

  test("a named model that exists only in the simulated market is still reachable (labelled simulated)", () => {
    const p = market([demoEngine, ollama]).plan("gpt-x");
    assert.ok(p.length > 0);
    assert.ok(p.every((c) => c.simulated));
  });

  test("the demo engine never wins auto when anything else exists, and live still wins with the demo market off", () => {
    assert.equal(market([demoEngine, ollama], false).plan("auto")[0].model, "llama3.2:1b");
    assert.ok(market([demoEngine, ollama]).plan("auto").every((c) => c.model !== "demo-echo-1"));
  });
});

describe("an upstream that is really another machine (SSH tunnel / VPN) is never labelled private", () => {
  const tunnel = { id: "up2", kind: "openai", name: "gpu", baseUrl: "http://127.0.0.1:11435/v1", models: ["llama3.1:8b"], price: 0, remote: true };
  test("a loopback URL flagged remote is not local, not private, not hosted; unflagged loopback still is", () => {
    const m = market([demoEngine, tunnel, ollama], false);
    const by = Object.fromEntries(m.candidates().map((c) => [c.model, c]));
    assert.equal(by["llama3.1:8b"].remote, true); assert.equal(by["llama3.1:8b"].private, false); assert.equal(by["llama3.1:8b"].privacyScore, 0);
    assert.equal(by["llama3.1:8b"].hosted, false); assert.match(by["llama3.1:8b"].peerName, /^REMOTE GPU/);
    assert.equal(by["llama3.2:1b"].private, true, "a genuinely local Ollama keeps its private label");
  });
});

describe("the built-in stub model on a real node", () => {
  const mk = (demoNetwork) => createMarket(
    { state: { stats: {}, peers: {}, settings: { demoNetwork }, policy: DEFAULT_POLICY, chain: { escrow: "" } }, identity: { id: "me" }, chain: { configured: () => false } },
    { catalog, upstreams: () => [demoEngine, ollama], repOf: () => 5 },
  );
  test("--no-demo hides demo-echo-1 from buyers; demo mode still offers it by name", () => {
    assert.equal(mk(false).candidates().some((c) => c.model === "demo-echo-1"), false);
    assert.equal(mk(true).candidates().some((c) => c.model === "demo-echo-1"), true);
    assert.equal(mk(false).candidates().some((c) => c.model === "llama3.2:1b" && c.kind === "self"), true, "real sources stay");
  });
});

describe("settlement compatibility (shared by routing and the explanation of a missing route)", () => {
  const ESC = "0xe9dA82E45D8CbF84A633a0B0e46e12D2A9288092";
  const peer = (chain, over = {}) => ({ id: "p1", name: "seller-1", online: true, providing: true, box: "k", models: [{ id: "m", price: 0.1 }], chain, ...over });
  const mk = (peers, configured, escrow = "") => {
    const state = { stats: {}, peers, settings: { demoNetwork: false }, policy: DEFAULT_POLICY, chain: { escrow, network: "robinhood-testnet" } };
    const chain = { configured: () => configured };
    const s = createSettlement({ state, chain });
    return { s, m: createMarket({ state, identity: { id: "me" }, chain }, { catalog, upstreams: () => [], repOf: () => 5, settlement: s }) };
  };
  test("the same escrow written with different letter case is the same settlement (routable)", () => {
    const { m, s } = mk({ p1: peer({ network: "robinhood-testnet", escrow: ESC.toLowerCase() }) }, true, ESC);
    assert.equal(m.candidates().filter((c) => c.kind === "peer").length, 1); assert.equal(s.blocked().length, 0);
  });
  test("a chain seller is hidden from a node on the simulated ledger, and reported as blocked with the data to fix it", () => {
    const { m, s } = mk({ p1: peer({ network: "robinhood-testnet", escrow: ESC }) }, false);
    assert.equal(m.candidates().filter((c) => c.kind === "peer").length, 0);
    assert.deepEqual(s.blocked(), [{ name: "seller-1", models: 1, network: "robinhood-testnet", escrow: ESC }]);
    assert.deepEqual(s.self(), { configured: false, network: "robinhood-testnet", escrow: null });
  });
  test("a simulated seller is hidden from a chain node; offline, non-providing and empty sellers are not reported", () => {
    assert.equal(mk({ p1: peer(null) }, true, ESC).s.blocked()[0].escrow, null);
    const none = mk({ a: peer(null, { online: false }), b: peer(null, { providing: false }), c: peer(null, { models: [] }) }, true, ESC).s.blocked();
    assert.deepEqual(none, []);
  });
  test("two nodes on different escrows do not see each other", () => {
    assert.equal(mk({ p1: peer({ network: "x", escrow: "0x1111111111111111111111111111111111111111" }) }, true, ESC).m.candidates().length, 0);
  });
});
