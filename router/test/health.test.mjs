// Upstream health: a source that stops answering is not offered, and comes back by itself.
// Run: node --test router/test/health.test.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, test } from "node:test";
import { createUpstreams } from "../core/upstreams.mjs";
import { createMarket } from "../core/candidates.mjs";
import { DEFAULT_POLICY } from "../policy.mjs";

const listen = (status = 200) => new Promise((res) => { const s = createServer((req, r) => { r.statusCode = status; r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ data: [{ id: "m1" }] })); }); s.listen(0, "127.0.0.1", () => res(s)); });
const close = (s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); });
const setup = () => {
  const state = { upstreams: [], stats: {}, peers: {}, settings: { demoNetwork: false }, policy: DEFAULT_POLICY, chain: { escrow: "" } };
  const u = createUpstreams({ state, save() {}, teeMode: false });
  const m = createMarket({ state, identity: { id: "me" }, chain: { configured: () => false } }, { catalog: { peers: [], listings: [] }, upstreams: u.upstreams, repOf: () => 5, upstreamUp: u.upstreamUp });
  return { state, u, m };
};
const models = (m) => m.candidates().filter((c) => c.model === "m1").length;

describe("upstream health", () => {
  test("unknown counts as up; two failed probes take it out of routing; one success brings it back", async () => {
    const srv = await listen(); const port = srv.address().port; let back = null;
    try {
      const { u, m } = setup();
      const up = await u.addUpstream({ name: "gpu", baseUrl: `http://127.0.0.1:${port}/v1`, models: ["m1"] });
      assert.equal(models(m), 1, "offered before any probe result");
      await u.probeAll(); assert.equal(u.upstreamHealth(up.id).status, "up"); assert.equal(models(m), 1);
      await close(srv);
      await u.probeAll(); assert.equal(models(m), 1, "one miss is not enough (no flapping)");
      await u.probeAll(); assert.equal(u.upstreamHealth(up.id).status, "down"); assert.equal(models(m), 0, "a down source is not offered");
      assert.ok(u.upstreamHealth(up.id).error, "the reason is reported");
      back = createServer((q, r) => { r.setHeader("content-type", "application/json"); r.end("{}"); }); await new Promise((r) => back.listen(port, "127.0.0.1", r));
      await u.probeAll(); assert.equal(u.upstreamHealth(up.id).status, "up"); assert.equal(models(m), 1, "back as soon as it answers");
    } finally { srv.closeAllConnections?.(); srv.close(); if (back) { back.closeAllConnections?.(); back.close(); } }
  });
  test("a source that has never answered is down after its first failed probe (a restarted node must not advertise a dead machine)", async () => {
    const srv = await listen(); const port = srv.address().port; await close(srv);
    const { u, m } = setup();
    const up = await u.addUpstream({ name: "gone", baseUrl: `http://127.0.0.1:${port}/v1`, models: ["m1"] });
    await u.probeAll(); assert.equal(u.upstreamHealth(up.id).status, "down"); assert.equal(models(m), 0);
  });
  test("a 401/404 on /models still proves a server is there; a 5xx does not", async () => {
    for (const [status, want] of [[401, "up"], [404, "up"], [503, "down"]]) {
      const srv = await listen(status);
      try {
        const { u } = setup();
        const up = await u.addUpstream({ name: "x", baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, models: ["m1"] });
        await u.probeAll(); await u.probeAll();
        assert.equal(u.upstreamHealth(up.id).status, want, `HTTP ${status}`);
      } finally { srv.closeAllConnections?.(); srv.close(); }
    }
  });
  test("the built-in demo engine is never probed or marked down", async () => {
    const { u } = setup(); await u.probeAll(); assert.equal(u.upstreamUp("demo-engine"), true);
  });
});
