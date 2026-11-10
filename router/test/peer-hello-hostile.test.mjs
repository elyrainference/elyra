// A peer's hello is the peer's claim. Found by audit: one hostile peer (`models: 5`, `[null]`, `[{}]`) made /pub/market, /api/status,
// /v1/models and every chat answer 500 on the whole node, persistently; the hello body had no size cap; a gossip list started unbounded
// fetches; throwaway identities could fill the peer table. These tests pin the fixes. Run: node --test router/test/peer-hello-hostile.test.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { canon, sha } from "../lib/canon.mjs";
import { fetchJson } from "../lib/fetch-json.mjs";
import { cleanChain, cleanGossip, cleanHello, cleanModels } from "../lib/peer-hello.mjs";
import { createPeers } from "../core/peers.mjs";
import { newBoxKey } from "../seal.mjs";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("peer hello sanitising (pure)", () => {
  test("models: anything that is not a list of {id: string, price: number >= 0} is dropped", () => {
    for (const bad of [5, "abc", {}, null, undefined, true, [null], [{}], [5], [[]], [{ id: 7, price: 1 }], [{ id: "x" }], [{ id: "x", price: null }], [{ id: "x", price: "0" }], [{ id: "x", price: -1 }], [{ id: "x", price: Infinity }], [{ id: "x", price: 1e9 }], [{ id: "", price: 1 }]]) assert.deepEqual(cleanModels(bad), [], JSON.stringify(bad));
    assert.deepEqual(cleanModels([{ id: "a", price: 0 }, { id: "a", price: 5 }, { id: "b", price: 0.5, tps: 40, tee: "claimed", evil: "x" }]), [{ id: "a", price: 0 }, { id: "b", price: 0.5, tps: 40, tee: "claimed" }], "free is valid, duplicates collapse, unknown fields are not kept");
    assert.equal(cleanModels([{ id: "x", price: 1, tee: "verified" }])[0].tee, undefined, "a seller can never claim `verified` itself");
  });
  test("models: bounded count and id length, control characters removed", () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ id: "m" + i, price: 1 }));
    assert.equal(cleanModels(many).length, 200);
    assert.equal(cleanModels([{ id: "x".repeat(500), price: 1 }])[0].id.length, 120);
    assert.equal(cleanModels([{ id: "a\u0000b\nc\u202ed", price: 1 }])[0].id, "a b c d");
  });
  test("name, chain and gossip are bounded and typed", () => {
    assert.equal(cleanHello({ name: 5 }).name, "peer"); assert.equal(cleanHello({ name: "n".repeat(900) }).name.length, 60); assert.equal(cleanHello({ name: "a\u001b[31mred" }).name, "a [31mred");
    assert.equal(cleanChain({ escrow: "nope" }), null); assert.equal(cleanChain([]), null); assert.equal(cleanChain({ escrow: "0x" + "a".repeat(40), network: 5 }).network, "");
    assert.deepEqual(cleanGossip("x"), []); assert.equal(cleanGossip(Array.from({ length: 5000 }, () => "http://a.example")).length, 20); assert.deepEqual(cleanGossip([5, null, "http://" + "a".repeat(400), "http://ok.example"]), ["http://ok.example"]);
    assert.equal(cleanHello({ providing: "yes" }).providing, false, "only a real boolean counts");
  });
});

describe("fetchJson size cap", () => {
  const srv = http.createServer((q, r) => {
    if (q.url === "/small") { r.setHeader("content-type", "application/json"); return r.end('{"ok":1}'); }
    if (q.url === "/declared") { r.setHeader("content-length", String(5_000_000)); r.write("{"); return; }
    r.setHeader("content-type", "application/json"); r.write('{"a":"'); const chunk = "x".repeat(100_000); let n = 0; const t = setInterval(() => { if (r.destroyed || n++ > 200) { clearInterval(t); return r.end('"}'); } r.write(chunk); }, 1); r.on("close", () => clearInterval(t));
  }); const ready = new Promise((r) => srv.listen(0, r));
  after(() => srv.close());
  test("a small answer works; a chunked answer over the cap and a declared oversize answer are refused without buffering them", async () => {
    await ready; const base = `http://127.0.0.1:${srv.address().port}`;
    assert.deepEqual(await fetchJson(base + "/small"), { ok: 1 });
    await assert.rejects(fetchJson(base + "/stream", {}, 4000, 1_000_000), /too large/);
    await assert.rejects(fetchJson(base + "/declared", {}, 4000, 1_000_000), /too large/);
    const before = process.memoryUsage().rss; await fetchJson(base + "/stream", {}, 4000, 300_000).catch(() => {}); assert.ok(process.memoryUsage().rss - before < 60e6, "memory stayed bounded");
  });
});

describe("peer table", () => {
  const mk = (peers, fetchHello) => {
    const state = { peers };
    const api = createPeers({ opts: { allowPrivatePeers: true }, state, save() {}, identity: { id: "self" }, publicUrl: "http://127.0.0.1:1", every: () => {} }, { helloInfo: () => ({}), fetchHello, peerFields: () => ({ name: "p", models: [] }) });
    return { state, ...api };
  };
  const full = (offline) => Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`p${i}`, { id: `p${i}`, url: `http://127.0.0.1:${40000 + i}`, online: !offline.includes(i), lastSeen: 1000 + i }]));
  test("a full table makes room by dropping the oldest DEAD peer, never a live one", async () => {
    const t = mk(full([5, 3]), async (url) => ({ h: { id: "new-" + url, pub: "x", box: { pub: "x" } }, rtt: 1, attest: null }));
    await t.addPeer("http://127.0.0.1:50001"); assert.equal(Object.keys(t.state.peers).length, 200); assert.ok(!t.state.peers.p3, "oldest offline peer made room"); assert.ok(t.state.peers.p5 && t.state.peers.p0, "others untouched");
    const t2 = mk(full([]), async (url) => ({ h: { id: "new-" + url, pub: "x", box: { pub: "x" } }, rtt: 1, attest: null }));
    await assert.rejects(t2.addPeer("http://127.0.0.1:50002"), /peer table full/); assert.equal(Object.keys(t2.state.peers).length, 200);
  });
  test("a state file with a poisoned peer entry is cleaned at start", () => {
    const t = mk({ a: { id: "a", url: "http://127.0.0.1:2", online: true, models: 5, chain: "x", name: 9 }, b: { id: "b", url: "http://127.0.0.1:3", online: true, models: [null, { id: "ok", price: 1 }] } }, async () => { throw new Error("no"); });
    assert.deepEqual(t.state.peers.a.models, []); assert.equal(t.state.peers.a.chain, null); assert.equal(t.state.peers.a.name, "peer"); assert.deepEqual(t.state.peers.b.models, [{ id: "ok", price: 1 }]);
  });
  test("a gossip list triggers at most 8 lookups at once and at most 20 in total", async () => {
    let inflight = 0, peak = 0, total = 0;
    const gate = new Promise(() => {}); // never resolves: the worst case for concurrency
    const urls = Array.from({ length: 500 }, (_, i) => `http://127.0.0.1:${30000 + i}`);
    const t = mk({}, async (url) => { total++; if (url.endsWith(":9")) return { h: { id: "root", pub: "x", box: { pub: "x" }, peers: urls }, rtt: 1, attest: null }; inflight++; peak = Math.max(peak, inflight); await gate; });
    await t.addPeer("http://127.0.0.1:9"); await sleep(100);
    assert.ok(peak <= 8, "peak concurrent lookups " + peak); assert.ok(total <= 9, "total lookups " + total);
  });
});

describe("a hostile peer cannot break a whole node (full process)", () => {
  const dirs = [], procs = [], srvs = [];
  after(() => { procs.forEach((p) => p.kill()); srvs.forEach((s) => s.close()); setTimeout(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })), 500); });
  const ident = () => { const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519"); const pubB = publicKey.export({ type: "spki", format: "der" }); const box = newBoxKey(); return { id: sha(pubB).slice(0, 16), pub: pubB.toString("base64"), box, sign: (o) => crypto.sign(null, Buffer.from(canon(o)), privateKey).toString("base64") }; };
  const call = (port, host, method, path, body) => new Promise((resolve) => { const r = http.request({ host: "127.0.0.1", port, method, path, headers: { host, ...(body ? { "content-type": "application/json" } : {}) } }, (x) => { let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => resolve({ s: x.statusCode, b: d })); }); r.on("error", () => resolve({ s: 0, b: "" })); if (body) r.write(JSON.stringify(body)); r.end(); });
  const start = async (port) => { const dir = mkdtempSync(join(tmpdir(), "vpr-hh-")); dirs.push(dir); const p = spawn(process.execPath, [server, "--port", String(port), "--data", dir, "--name", "gw", "--no-demo", "--allow-private-peers"], { env: { ...process.env, ELYRA_ADMIN_HOST: "admin.test", ELYRA_ADMIN_TOKEN: "t".repeat(30), ELYRA_PUBLIC_TRY: "1" }, stdio: "pipe" }); procs.push(p); for (let i = 0; i < 80; i++) { if ((await call(port, "localhost", "GET", "/p2p/hello")).s === 200) return; await sleep(250); } throw new Error("gateway did not start"); };
  const peer = (port, extra) => { const I = ident(); const s = http.createServer((q, r) => { r.setHeader("content-type", "application/json"); if (q.url === "/p2p/hello" && q.method === "GET") return r.end(JSON.stringify({ v: 3, id: I.id, pub: I.pub, name: "evil", url: `http://127.0.0.1:${port}`, providing: true, models: [{ id: "ok1", price: 0.01 }], version: "0.1.0", ts: Date.now(), box: { pub: I.box.pub, sig: I.sign({ id: I.id, box: I.box.pub }) }, ...extra })); r.end("{}"); }); s.listen(port); srvs.push(s); return s; };
  const variants = [["models=5", { models: 5 }], ["models=[null]", { models: [null] }], ["models=[{}]", { models: [{}] }], ["peers=5, chain=5", { peers: 5, chain: 5 }]];
  variants.forEach(([name, extra], i) => test(`${name}: market, status, /v1/models and chat still answer (no 500)`, async () => {
    const G = 19310 + i, P = 19410 + i; await start(G); peer(P, extra);
    assert.equal((await call(G, "localhost", "POST", "/api/peers", { url: `http://127.0.0.1:${P}` })).s, 200);
    await call(G, "localhost", "POST", "/api/peers/refresh", {}); await sleep(300);
    for (const [host, m, path, body] of [["admin.test", "GET", "/pub/market"], ["localhost", "GET", "/api/status"], ["localhost", "GET", "/v1/models"], ["localhost", "POST", "/v1/chat/completions", { model: "auto", messages: [{ role: "user", content: "hi" }] }]]) { const r = await call(G, host, m, path, body); assert.ok(r.s !== 500 && r.s !== 0, `${path} -> ${r.s} ${r.b.slice(0, 100)}`); }
  }));
  test("bad prices and markup never reach the market; the name is bounded", async () => {
    const G = 19330, P = 19430; await start(G);
    peer(P, { name: "<img src=x onerror=1>" + "n".repeat(200), models: [{ id: "neg", price: -5 }, { id: "nul", price: null }, { id: "str", price: "0" }, { id: "inf", price: 1e999 }, { id: "good", price: 0.02 }] });
    await call(G, "localhost", "POST", "/api/peers", { url: `http://127.0.0.1:${P}` }); await call(G, "localhost", "POST", "/api/peers/refresh", {}); await sleep(300);
    const m = JSON.parse((await call(G, "admin.test", "GET", "/pub/market")).b); assert.deepEqual(m.models.map((x) => x.model), ["good"]);
    const peers = JSON.parse((await call(G, "localhost", "GET", "/api/peers")).b).peers; assert.ok(peers[0].name.length <= 60); assert.deepEqual(peers[0].models.map((x) => x.id), ["good"], "the stored copy is clean too, not only the market view");
  });
});
