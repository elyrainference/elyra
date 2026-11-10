// Daily spend cap (buyer safety): the cap blocks only the request that would cross it, the 24 h window rolls, free routes are
// never limited, and the setting is validated. Run: node --test router/test/spendcap.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { createChat } from "../core/consumer/chat.mjs";
import { DAY } from "../core/limits.mjs";

const peer = { key: "peer:p:m", kind: "peer", peerName: "seller-1", model: "m", price: 10, tee: "none", simulated: false };
const own = { key: "self:u:m", kind: "self", peerName: "SELF - ollama", model: "m", price: 0, tee: "none", simulated: false };
const freePeer = { ...peer, key: "peer:f:m", peerName: "free-seller", price: 0 };
const body = { messages: [{ role: "user", content: "hi" }], max_tokens: 100 }; // worst case about $0.0011 at $10/MTok, a real answer costs $0.00108
const out = () => { const o = { status: null }; o.head = (s) => { o.status = s; }; o.json = (j) => { o.body = j; }; o.write = () => {}; o.end = () => {}; return o; };
const answer = (gate) => async () => {
  await gate;
  return { json: { choices: [{ message: { content: "ok" } }] }, usage: Promise.resolve({ p: 8, c: 100 }) };
};
const spend = (age, amount = 0.01) => ({ id: "l" + age, ts: Date.now() - age, type: "spend", amount, peer: "x", simulated: false });

function mk(cands, { cap = null, ledger = [], execPeer = answer(), balance = 100 } = {}) {
  const state = { routes: [], ledger, stats: {}, peers: {}, settings: { spendCapUsdDay: cap } };
  const calls = { peer: 0, local: 0 };
  const chat = createChat({ state, save() {}, chain: { configured: () => true } }, {
    plan: () => cands, wallet: { balance: () => balance }, record() {},
    execPeer: async (...a) => { calls.peer++; return execPeer(...a); },
    execLocal: async () => { calls.local++; return { json: { choices: [{ message: { content: "free" } }] }, usage: Promise.resolve({ p: 1, c: 1 }) }; },
  });
  const o = out();
  return { state, calls, o, run: () => chat(body, o, new AbortController()) };
}
const capped = (e) => e.status === 402 && e.type === "spend_cap_reached" && /Daily spend cap reached/.test(e.message) && /Payments/.test(e.message) && /spendCapUsdDay/.test(e.message);

describe("daily spend cap in the router", () => {
  test("it blocks exactly the request that would cross the cap, and the seller is not called for it", async () => {
    const { run, calls, state } = mk([peer], { cap: 0.0025 });
    await run(); await run(); // $0.00108 each: the second still fits under $0.0025 including its worst case
    assert.equal(calls.peer, 2);
    await assert.rejects(run, capped);
    assert.equal(calls.peer, 2, "no request reached the seller");
    assert.equal(state.ledger.length, 2, "nothing was spent by the blocked request");
  });

  test("spend older than 24 hours no longer counts (rolling window); spend just inside it does", async () => {
    await mk([peer], { cap: 0.011, ledger: [spend(DAY + 1000)] }).run(); // the old $0.01 has rolled off
    await assert.rejects(mk([peer], { cap: 0.011, ledger: [spend(DAY - 60_000)] }).run, capped);
  });

  test("earned entries never count against the cap", async () => {
    await mk([peer], { cap: 0.01, ledger: [{ id: "e", ts: Date.now(), type: "earn", amount: 50, peer: "buyer", simulated: false }] }).run();
  });

  test("no cap (null) never blocks; a cap of 0 blocks every paid route", async () => {
    await mk([peer], { cap: null, ledger: [spend(0, 999)] }).run();
    await assert.rejects(mk([peer], { cap: 0 }).run, capped);
  });

  test("free and local routes are unaffected by an exhausted cap, and a paid route over the cap fails over to them", async () => {
    for (const free of [own, freePeer]) {
      const m = mk([free], { cap: 0, ledger: [spend(0, 5)], balance: 0 }); // not even funds: free routes need none
      await m.run();
      assert.equal(m.o.status, 200, free.peerName);
    }
    const m = mk([peer, own], { cap: 0.001 });
    await m.run();
    assert.equal(m.o.status, 200);
    assert.deepEqual([m.calls.peer, m.calls.local], [0, 1], "the capped paid route was skipped, the local model answered");
  });

  test("requests in flight count against the cap, so parallel requests cannot all slip under it", async () => {
    let open; const gate = new Promise((r) => { open = r; });
    const { run, calls } = mk([peer], { cap: 0.002, execPeer: answer(gate) }); // room for one worst case ($0.0011), not two
    const first = run();
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(run, capped);
    open(); await first;
    assert.equal(calls.peer, 1);
  });

  test("a failed upstream releases its reservation instead of locking the cap", async () => {
    let fail = true;
    const { run, calls } = mk([peer], { cap: 0.002, execPeer: async () => { if (fail) throw new Error("boom"); return answer()(); } });
    await assert.rejects(run, (e) => e.status === 502);
    fail = false; await run();
    assert.equal(calls.peer, 2);
  });
});

describe("daily spend cap over HTTP", () => {
  const dirs = [], procs = [];
  const free = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => res(port)); }); });
  const J = { "content-type": "application/json" };
  const boot = async (env = {}) => {
    const port = await free(), dir = mkdtempSync(join(tmpdir(), "vpr-cap-"));
    dirs.push(dir);
    const p = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs"), "--port", String(port), "--data", dir], { stdio: "pipe", env: { ...process.env, ...env } });
    procs.push(p);
    let up = false;
    for (let i = 0; i < 300 && !up; i++) { try { up = (await fetch(`http://localhost:${port}/p2p/hello`)).ok; } catch { /* not up yet */ } if (!up) await new Promise((r) => setTimeout(r, 100)); }
    if (!up) throw new Error("node did not start");
    const j = async (path, method = "GET", b) => { const r = await fetch(`http://localhost:${port}${path}`, { method, headers: J, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const chat = (model) => j("/v1/chat/completions", "POST", { model, messages: [{ role: "user", content: "hi" }], max_tokens: 50 });
    return { j, chat, dir };
  };
  after(() => { procs.forEach((p) => p.kill()); setTimeout(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })), 300); });

  test("setting, reading, clearing and rejecting bad values", async () => {
    const { j } = await boot();
    assert.equal((await j("/api/status")).body.spendCap.usdDay, null);
    assert.equal((await j("/api/settings", "PUT", { spendCapUsdDay: 2.5 })).body.settings.spendCapUsdDay, 2.5);
    assert.deepEqual((await j("/api/status")).body.spendCap, { usdDay: 2.5, spentUsd: 0 });
    assert.equal((await j("/api/settings", "PUT", { spendCapUsdDay: "3" })).body.settings.spendCapUsdDay, 3, "numeric strings from a form are accepted");
    assert.equal((await j("/api/settings", "PUT", { spendCapUsdDay: 0 })).body.settings.spendCapUsdDay, 0);
    for (const bad of [-1, "abc", "Infinity", "-0.5", true, [], {}, " "]) {
      const r = await j("/api/settings", "PUT", { spendCapUsdDay: bad, name: "renamed" });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    const st = (await j("/api/status")).body;
    assert.equal(st.spendCap.usdDay, 0, "a rejected value changes nothing");
    assert.notEqual(st.node.name, "renamed", "nor does anything else in the same request");
    assert.equal((await j("/api/settings", "PUT", { spendCapUsdDay: null })).body.settings.spendCapUsdDay, null);
  });

  test("a paid route is refused with 402 spend_cap_reached; a free route and removing the cap still work", async () => {
    const { j, chat } = await boot(); // demo market on: "auto" lands on a simulated paid peer
    await j("/api/settings", "PUT", { spendCapUsdDay: 0 });
    const blocked = await chat("auto");
    assert.equal(blocked.status, 402); assert.equal(blocked.body.error.type, "spend_cap_reached");
    assert.equal((await chat("demo-echo-1")).status, 200, "the built-in demo engine is free and local");
    await j("/api/settings", "PUT", { spendCapUsdDay: null });
    assert.equal((await chat("auto")).status, 200);
    assert.ok((await j("/api/status")).body.spendCap.spentUsd > 0, "the paid request shows up in today's spend");
  });

  test("status says whether secrets are encrypted at rest and where the data lives, as plain facts only", async () => {
    const plain = (await (await boot()).j("/api/status")).body.node;
    assert.equal(plain.encrypted, false); assert.equal(typeof plain.dataDir, "string");
    const enc = await boot({ ELYRA_PASSPHRASE: "correct horse battery" });
    const body = (await enc.j("/api/status")).body;
    assert.equal(body.node.encrypted, true); assert.equal(body.node.dataDir, enc.dir);
    assert.ok(!JSON.stringify(body).includes("correct horse"), "the passphrase is never echoed");
  });
});
