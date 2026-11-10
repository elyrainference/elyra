// What a buyer is told when it cannot pay: a clear "fund it" (402) instead of "all routes failed". Run: node --test router/test/funds.test.mjs
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createChat } from "../core/consumer/chat.mjs";

const peer = { key: "peer:p:m", kind: "peer", peerName: "seller-1", model: "m", price: 0.05, tee: "none", simulated: false };
const own = { key: "self:u:m", kind: "self", peerName: "SELF - ollama", model: "m", price: 0, tee: "none", simulated: false };
const body = { messages: [{ role: "user", content: "hi" }], max_tokens: 16 };
const out = () => { const o = { status: null, json: null, head(s) { o.status = s; }, json_(j) {} }; o.json = (j) => (o.body = j); o.write = () => {}; o.end = () => {}; return o; };
const mk = (cands, { balance = 0, configured = true, execPeer, execLocal } = {}) => createChat(
  { state: { routes: [], ledger: [], stats: {}, peers: {} }, save() {}, chain: { configured: () => configured } },
  { plan: () => cands, execLocal: execLocal ?? (async () => ({ json: { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }, usage: Promise.resolve({ p: 1, c: 1 }) })),
    execPeer: execPeer ?? (async () => { throw new Error("must not be called without funds"); }), wallet: { balance: () => balance }, record() {} },
);

describe("a buyer that cannot pay", () => {
  test("every route skipped for lack of funds: 402 payment_required that says how to fund, and the seller is never called", async () => {
    await assert.rejects(() => mk([peer])(body, out(), new AbortController()), (e) => e.status === 402 && e.type === "payment_required" && /Fund it first/.test(e.message) && /seller-1/.test(e.message) && /\$0\.05 per million/.test(e.message));
  });
  test("wallet-mode (no chain) with an empty wallet says the same", async () => {
    await assert.rejects(() => mk([peer], { configured: false })(body, out(), new AbortController()), (e) => e.status === 402);
  });
  test("a free own model needs no funds", async () => {
    const o = out(); await mk([own])(body, o, new AbortController()); assert.equal(o.status, 200);
  });
  test("a free route after an unfunded one still answers (failover), a real failure is still a 502", async () => {
    const o = out(); await mk([peer, own])(body, o, new AbortController()); assert.equal(o.status, 200);
    await assert.rejects(() => mk([own], { execLocal: async () => { throw new Error("boom"); } })(body, out(), new AbortController()), (e) => e.status === 502 && /all routes failed/.test(e.message));
    await assert.rejects(() => mk([peer, own], { execLocal: async () => { throw new Error("boom"); } })(body, out(), new AbortController()), (e) => e.status === 502, "mixed causes stay a 502 with both reasons");
  });
});
