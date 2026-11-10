// Reputation signals a buyer can compare: success, speed, time to first token, and peer uptime. Run: node --test router/test/reputation.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { createMarket } from "../core/candidates.mjs";
import { MIN_PROBES, countProbe, createReputation, uptimeOf, withUptime } from "../core/reputation.mjs";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
const J = { "content-type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("uptime from probes (unit)", () => {
  test("unknown until enough probes, then the share answered", () => {
    const p = {}; for (let i = 0; i < MIN_PROBES - 1; i++) countProbe(p, i % 2 === 0);
    assert.equal(uptimeOf(p), null, "too little data to say");
    countProbe(p, true); assert.equal(typeof uptimeOf(p), "number");
    const q = {}; for (let i = 0; i < 40; i++) countProbe(q, i >= 10); assert.equal(uptimeOf(q), 0.75);
    assert.equal(uptimeOf(undefined), null); assert.equal(uptimeOf({}), null);
  });
  test("the window is bounded: a long good record does not hide a bad hour, and counts stay small", () => {
    const p = {}; for (let i = 0; i < 5000; i++) countProbe(p, true);
    assert.ok(p.probes <= 240); for (let i = 0; i < 120; i++) countProbe(p, false);
    assert.ok(uptimeOf(p) < 0.75, "recent misses count for a lot: " + uptimeOf(p));
  });
  test("withUptime: full uptime keeps the score, none halves it, unknown changes nothing", () => {
    assert.equal(withUptime(4, 1), 4); assert.equal(withUptime(4, 0), 2); assert.equal(withUptime(4, 0.5), 3); assert.equal(withUptime(4, null), 4);
  });
});

describe("uptime reaches the candidate score (unit)", () => {
  const peer = (id, over) => ({ id, name: id, online: true, providing: true, box: "b", url: "http://x", models: [{ id: "m", price: 1, tps: 10 }], ...over });
  const market = (peers) => createMarket({ state: { peers, stats: {}, settings: { demoNetwork: false }, chain: {} }, identity: {}, chain: { configured: () => false } },
    { catalog: [], upstreams: () => [], repOf: () => 5, settlement: { compatible: () => true } }).candidates();
  test("a peer that is often away scores lower than one that is not; one with too little data is unchanged", () => {
    const c = Object.fromEntries(market({ good: peer("good", { probes: 100, misses: 0 }), bad: peer("bad", { probes: 100, misses: 60 }), nw: peer("nw", { probes: 3, misses: 3 }) }).map((x) => [x.peerId, x]));
    assert.equal(c.good.reputation, 4.3); assert.ok(c.bad.reputation < 3.2, "bad " + c.bad.reputation); assert.equal(c.nw.reputation, 4.3, "new peer is not punished");
    assert.equal(c.bad.uptime, 0.4); assert.equal(c.nw.uptime, null);
  });
});

describe("time to first token (unit)", () => {
  const mk = () => { const state = { stats: {} }; return { state, rep: createReputation({ state, save() {} }) }; };
  test("recorded as a smoothed value for streamed answers; no ttft leaves it unset; failures never set it", () => {
    const { state, rep } = mk();
    rep.record("k", true, 50, 1000, 400); assert.equal(state.stats.k.ttft, 400);
    rep.record("k", true, 50, 1000, 800); assert.equal(Math.round(state.stats.k.ttft), 520);
    rep.record("j", true, 50, 1000); assert.equal(state.stats.j.ttft, undefined);
    rep.record("f", false, 0, 1000, 999); assert.equal(state.stats.f.ttft, undefined);
  });
});

describe("a peer that goes away loses uptime (two real nodes)", () => {
  const dirs = [], procs = []; const A = 18770, B = 18771;
  const start = async (port, name) => {
    const dir = mkdtempSync(join(tmpdir(), "vpr-rep-")); dirs.push(dir);
    const p = spawn(process.execPath, [server, "--port", String(port), "--data", dir, "--name", name, "--no-demo", "--allow-private-peers"], { stdio: "pipe" }); procs.push(p);
    for (let i = 0; i < 300; i++) { try { if ((await fetch(`http://localhost:${port}/p2p/hello`)).ok) return p; } catch { /* booting */ } await sleep(100); }
    throw new Error("node did not start");
  };
  const j = async (port, path, method = "GET", body) => (await fetch(`http://localhost:${port}${path}`, { method, headers: J, body: body && JSON.stringify(body) })).json();
  const stub = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "m1" }] })); });
  after(() => { stub.close(); procs.forEach((p) => p.kill()); setTimeout(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })), 300); });

  test("answered probes give a high uptime; after the peer stops, misses pull it down", async () => {
    await new Promise((r) => stub.listen(18779, r));
    await start(A, "buyer"); const sellerProc = await start(B, "seller");
    const up = await j(B, "/api/upstreams", "POST", { name: "s", baseUrl: "http://localhost:18779/v1" }); await j(B, "/api/provide", "PUT", { enabled: true, upstreamId: up.id, price: 1 });
    await j(A, "/api/peers", "POST", { url: `http://localhost:${B}` });
    for (let i = 0; i < MIN_PROBES + 8; i++) await j(A, "/api/peers/refresh", "POST", {});
    let peer = (await j(A, "/api/peers")).peers[0]; assert.ok(peer.uptime >= 0.95, "healthy peer: " + peer.uptime);
    const d = new Promise((r) => sellerProc.once("exit", r)); sellerProc.kill(); await d;
    for (let i = 0; i < 12; i++) await j(A, "/api/peers/refresh", "POST", {});
    peer = (await j(A, "/api/peers")).peers[0]; assert.ok(peer.uptime < 0.8, "after 12 missed probes: " + peer.uptime);
    assert.equal(peer.online, false);
  });
});
