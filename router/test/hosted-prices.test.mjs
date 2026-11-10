// Hosted sources (OpenRouter style) publish a list price per model; the router must rank by it, not treat every hosted model as free.
// Run: node --test router/test/hosted-prices.test.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, test } from "node:test";
import { createUpstreams, listPrice } from "../core/upstreams.mjs";
import { createMarket } from "../core/candidates.mjs";
import { DEFAULT_POLICY } from "../policy.mjs";

const DATA = [
  { id: "v/cheap", pricing: { prompt: "0.00000005", completion: "0.00000015" } },
  { id: "v/dear", pricing: { prompt: "0.000003", completion: "0.000015" } },
  { id: "v/free", pricing: { prompt: "0", completion: "0" } },
  { id: "router/auto", pricing: { prompt: "-1", completion: "-1" } },
  { id: "v/nopricing" },
  { id: "v/half", pricing: { prompt: "0.000001" } },
  { id: "v/junk", pricing: { prompt: "abc", completion: "1" } },
];
const serve = () => new Promise((res) => { const s = createServer((q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ data: DATA })); }); s.listen(0, "127.0.0.1", () => res(s)); });
const setup = () => {
  const state = { upstreams: [], stats: {}, peers: {}, settings: { demoNetwork: false }, policy: DEFAULT_POLICY, chain: { escrow: "" } };
  const u = createUpstreams({ state, save() {}, teeMode: false });
  const m = createMarket({ state, identity: { id: "me" }, chain: { configured: () => false } }, { catalog: { peers: [], listings: [] }, upstreams: u.upstreams, repOf: () => 5, upstreamUp: u.upstreamUp });
  return { state, u, m };
};
const price = (m, id) => m.candidates().find((c) => c.model === id)?.price;

describe("listPrice", () => {
  test("input and output averaged, per million tokens; zero is a price; unknown is null, never zero", () => {
    assert.equal(listPrice({ prompt: "0.00000005", completion: "0.00000015" }), 0.1);
    assert.equal(listPrice({ prompt: "0", completion: "0" }), 0);
    for (const bad of [null, undefined, {}, { prompt: "1" }, { prompt: "-1", completion: "-1" }, { prompt: "x", completion: "1" }, { prompt: "", completion: "" }, { prompt: null, completion: null }, "str", 5]) assert.equal(listPrice(bad), null, JSON.stringify(bad));
  });
});

describe("a hosted source is ranked by its published prices", () => {
  test("discovered models carry their own price; models without a usable price fall back to the source price (default 0 stays explicit)", async () => {
    const srv = await serve();
    try {
      const { u, m } = setup();
      await u.addUpstream({ name: "or", baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, price: 0.5 });
      assert.equal(price(m, "v/cheap"), 0.1); assert.equal(price(m, "v/dear"), 9); assert.equal(price(m, "v/free"), 0, "a free model is free");
      for (const id of ["router/auto", "v/nopricing", "v/half", "v/junk"]) assert.equal(price(m, id), 0.5, id + " has no usable price: the source price applies, not zero");
    } finally { srv.closeAllConnections?.(); srv.close(); }
  });
  test("refresh updates the prices; a manual model list keeps using the source price", async () => {
    const srv = await serve();
    try {
      const { state, u, m } = setup(); const base = `http://127.0.0.1:${srv.address().port}/v1`;
      const up = await u.addUpstream({ name: "or", baseUrl: base });
      state.upstreams[0].modelPrices["v/cheap"] = 99; assert.equal(price(m, "v/cheap"), 99);
      await u.refreshUpstream(up.id); assert.equal(price(m, "v/cheap"), 0.1, "refreshed from the source");
      const manual = await u.addUpstream({ name: "hand", baseUrl: base, models: ["x1"], price: 2 });
      assert.equal(manual.modelPrices, undefined); assert.equal(price(m, "x1"), 2);
    } finally { srv.closeAllConnections?.(); srv.close(); }
  });
  test("auto:cheapest no longer prefers a model only because its price was never recorded", async () => {
    const srv = await serve();
    try {
      const { u, m } = setup(); await u.addUpstream({ name: "or", baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, price: 3 });
      const cs = m.candidates(); const cheapest = cs.filter((c) => c.price === Math.min(...cs.map((x) => x.price)));
      assert.deepEqual(cheapest.map((c) => c.model), ["v/free"], "only the genuinely free model is at zero");
    } finally { srv.closeAllConnections?.(); srv.close(); }
  });
});
