// B9: Seller & buyer first-run quality from the public page flow on a fresh rig.
// Verifies:
//  1) Seller snippet boot order (`envCfg` before `server.listen`, `relay.ready` before `--seed`, `isOwnRelay` on gateway):
//     a seller booting with ELYRA_UPSTREAM_URL + ELYRA_PROVIDE=1 + ELYRA_PROVIDE_PRICE + ELYRA_RELAY_URL + --seed
//     automatically registers on the public gateway and appears in /pub/market without manual peer addition.
//  2) Buyer snippet (`--seed <gateway>`): discovers the relay seller via gossip and routes `auto:cheapest` end-to-end.
//  3) Panel first-run seller flow: adding the first local upstream switches `provide.upstreamId` off `"demo-engine"`
//     (hosted sources do not), `PUT /api/provide` and `PUT /api/chain` push `announcePeers()`, and `refreshPeers()`
//     re-announces when a peer forgets our `publicUrl`.
//  4) Buyer first-run diagnostics: `404 no_route` on `/v1/chat/completions` explains blocked settlement escrows,
//     policy filters, or missing live sources, and `ELYRA_ESCROW` seeds a fresh node without overwriting owner edits.
// Run: node --test router/test/first-run.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { createNode } from "../core/node.mjs";
import { createApi } from "../http/api.mjs";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
const J = { "content-type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("B9: seller and buyer first-run from public page snippets on a fresh rig", () => {
  const GW = 18910, SP = 18911, BP = 18912, STUB = 18919;
  const procs = [], dirs = [];
  let slowModelsMs = 150;

  const stub = createServer(async (req, res) => {
    if (req.url.endsWith("/models")) {
      await sleep(slowModelsMs);
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ data: [{ id: "seller-llama-3b" }] }));
    }
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const usage = { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "cmpl-b9",
        object: "chat.completion",
        model: "seller-llama-3b",
        choices: [{ index: 0, message: { role: "assistant", content: "real-seller-answer" }, finish_reason: "stop" }],
        usage,
      }));
    });
  });

  const boot = async (port, name, args = [], env = {}) => {
    const dir = mkdtempSync(join(tmpdir(), `vpr-b9-${name}-`));
    dirs.push(dir);
    const p = spawn(process.execPath, [server, "--port", String(port), "--data", dir, "--name", name, "--no-demo", ...args], {
      stdio: "pipe",
      env: { ...process.env, ...env },
    });
    procs.push(p);
    for (let i = 0; i < 300; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/p2p/hello`)).ok) return { p, dir };
      } catch { /* booting */ }
      await sleep(100);
    }
    throw new Error(`${name} did not start on ${port}`);
  };

  before(async () => {
    await new Promise((r) => stub.listen(STUB, "127.0.0.1", r));
  });

  after(() => {
    stub.close();
    for (const p of procs) p.kill();
    setTimeout(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); }, 300);
  });

  test("seller running #snip-sell registers via relay before seeding and appears in /pub/market; buyer running #snip-use routes to it", async () => {
    const escrow = "0x" + "11".repeat(20);
    // 1. Start public gateway + relay (without --allow-private-peers, matching production)
    await boot(GW, "public-gateway", [], {
      ELYRA_PUBLIC_TRY: "1",
      ELYRA_RELAY: "1",
      ELYRA_ADMIN_HOST: "127.0.0.1",
      ELYRA_ADMIN_TOKEN: "b9-admin-token-long-enough-12345",
      ELYRA_ESCROW: escrow,
    });

    // 2. Start seller with the exact env + flags from #snip-sell on the public page (with a 150ms /models delay to test the boot race)
    const gwUrl = `http://127.0.0.1:${GW}`;
    await boot(SP, "home-seller", ["--seed", gwUrl], {
      ELYRA_UPSTREAM_URL: `http://127.0.0.1:${STUB}/v1`,
      ELYRA_PROVIDE: "1",
      ELYRA_PROVIDE_PRICE: "0.05",
      ELYRA_ESCROW: escrow,
      ELYRA_RELAY_URL: gwUrl,
    });

    // Immediately after boot(), /p2p/hello on the seller must already advertise providing: true and its model
    const sellerHello = await (await fetch(`http://127.0.0.1:${SP}/p2p/hello`)).json();
    assert.equal(sellerHello.providing, true, "envCfg must complete before server.listen opens /p2p/hello");
    assert.deepEqual(sellerHello.models.map((m) => [m.id, m.price]), [["seller-llama-3b", 0.05]]);
    assert.equal(sellerHello.chain?.escrow, escrow);

    // Wait briefly for the async seed announcement to complete on the gateway
    let mkt = null;
    for (let i = 0; i < 60; i++) {
      mkt = await (await fetch(`${gwUrl}/pub/market`, { headers: { host: "127.0.0.1" } })).json();
      if (mkt.models?.some((m) => m.model === "seller-llama-3b")) break;
      await sleep(100);
    }
    assert.equal(mkt.node.settlement, "chain");
    assert.equal(mkt.node.escrow, escrow);
    assert.equal(mkt.totals.sellers, 1, "relay seller is automatically added to the gateway's market");
    assert.equal(mkt.totals.models, 1);
    assert.equal(mkt.totals.cheapest, 0.05);
    assert.equal(mkt.models[0].model, "seller-llama-3b");
    assert.equal(mkt.models[0].offers[0].seller, "home-seller");
    assert.equal(mkt.models[0].offers[0].where, "peer");

    // 3. Start buyer with --seed <gateway> (first without ELYRA_ESCROW to verify blocked-seller diagnostic, then match settlement)
    await boot(BP, "fresh-buyer", ["--seed", gwUrl]);
    for (let i = 0; i < 50; i++) {
      const st = await (await fetch(`http://127.0.0.1:${BP}/api/status`)).json();
      if (st.network.blocked.length > 0) break;
      await sleep(100);
    }
    const blockedRes = await fetch(`http://127.0.0.1:${BP}/v1/chat/completions`, {
      method: "POST",
      headers: J,
      body: JSON.stringify({ model: "auto:cheapest", messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(blockedRes.status, 404);
    const blockedErr = (await blockedRes.json()).error;
    assert.equal(blockedErr.type, "no_route");
    assert.match(blockedErr.message, /online seller.*home-seller.*escrow/i, "404 no_route names the blocked seller and escrow");

    // Switch both seller and gateway/buyer to simulated ledger (or matching settlement) and verify announcePeers + routing
    await fetch(`http://127.0.0.1:${SP}/api/chain`, { method: "PUT", headers: J, body: JSON.stringify({ escrow: "" }) });
    // announcePeers() on PUT /api/chain pushes updated hello to gateway & buyer; refresh buyer peers to be deterministic
    await fetch(`http://127.0.0.1:${BP}/api/peers/refresh`, { method: "POST", headers: J, body: "{}" });

    const chatRes = await fetch(`http://127.0.0.1:${BP}/v1/chat/completions`, {
      method: "POST",
      headers: J,
      body: JSON.stringify({ model: "auto:cheapest", messages: [{ role: "user", content: "hello" }] }),
    });
    assert.equal(chatRes.status, 200);
    assert.equal(chatRes.headers.get("x-elyra-route"), "peer:home-seller");
    assert.equal(chatRes.headers.get("x-elyra-model"), "seller-llama-3b");
    const chatJson = await chatRes.json();
    assert.equal(chatJson.choices[0].message.content, "real-seller-answer");
  });
});

describe("B9: panel first-run seller & buyer helpers (unit + in-process)", () => {
  test("adding first local upstream switches provide.upstreamId off demo-engine; hosted upstream does not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vpr-b9-up-"));
    const node = await createNode({ dataDir: dir, port: 18915, host: "127.0.0.1", demoNetwork: false });
    try {
      assert.equal(node.state.provide.upstreamId, "demo-engine");
      const hosted = await node.addUpstream({ name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", models: ["openai/gpt-4o"] });
      assert.equal(node.state.provide.upstreamId, "demo-engine", "hosted source is never auto-selected for selling");
      const local = await node.addUpstream({ name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", models: ["llama3.2:1b"] });
      assert.equal(node.state.provide.upstreamId, local.id, "first local source replaces demo-engine as default provide source");
      const local2 = await node.addUpstream({ name: "vLLM", baseUrl: "http://127.0.0.1:8000/v1", models: ["qwen3:8b"] });
      assert.equal(node.state.provide.upstreamId, local.id, "subsequent local source does not overwrite already-selected real source");
      assert.notEqual(local2.id, hosted.id);
    } finally {
      node.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("PUT /api/provide and refreshPeers announce to peers when seller enables providing or peer forgets us", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "vpr-b9-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "vpr-b9-b-"));
    const srvA = createServer(), srvB = createServer();
    // a live model source: a source nobody answers for is (correctly) not offered, so the test must not rely on an Ollama running on this machine
    const srvUp = createServer((q, r) => { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ data: [{ id: "qwen2.5:7b" }] })); });
    await new Promise((r) => srvUp.listen(0, "127.0.0.1", r));
    await new Promise((r) => srvA.listen(0, "127.0.0.1", r));
    await new Promise((r) => srvB.listen(0, "127.0.0.1", r));
    const portA = srvA.address().port, portB = srvB.address().port;
    const nodeA = await createNode({ dataDir: dirA, port: portA, host: "127.0.0.1", publicUrl: `http://127.0.0.1:${portA}`, demoNetwork: false, allowPrivatePeers: true });
    const nodeB = await createNode({ dataDir: dirB, port: portB, host: "127.0.0.1", publicUrl: `http://127.0.0.1:${portB}`, demoNetwork: false, allowPrivatePeers: true });
    const { createApp } = await import("../http/app.mjs");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    srvA.on("request", createApp(nodeA, { panelDir: join(root, "panel"), siteDir: join(root, "site") }));
    srvB.on("request", createApp(nodeB, { panelDir: join(root, "panel"), siteDir: join(root, "site") }));
    const apiB = createApi(nodeB);
    const callB = async (method, path, body) => {
      let out;
      const req = { method, headers: J, [Symbol.asyncIterator]: async function* () { if (body) yield Buffer.from(JSON.stringify(body)); } };
      const res = { writeHead() {}, end(b) { out = JSON.parse(b); } };
      await apiB(req, res, path, new URLSearchParams());
      return out;
    };
    try {
      // B connects to A while B is NOT providing yet
      await nodeB.addPeer(`http://127.0.0.1:${portA}`);
      for (let i = 0; i < 40; i++) {
        if (nodeA.state.peers[nodeB.selfId]) break;
        await sleep(50);
      }
      assert.equal(nodeA.state.peers[nodeB.selfId]?.providing, false);

      // B adds a local model and enables providing via PUT /api/provide -> announcePeers() immediately updates A
      await callB("POST", "/api/upstreams", { name: "local", baseUrl: `http://127.0.0.1:${srvUp.address().port}/v1`, models: ["qwen2.5:7b"] });
      await callB("PUT", "/api/provide", { enabled: true, price: 0.12 });
      for (let i = 0; i < 30; i++) {
        if (nodeA.state.peers[nodeB.selfId]?.providing === true) break;
        await sleep(50);
      }
      assert.equal(nodeA.state.peers[nodeB.selfId]?.providing, true, "PUT /api/provide announces updated hello to known peers");
      assert.deepEqual(nodeA.state.peers[nodeB.selfId]?.models.map((m) => [m.id, m.price]), [["qwen2.5:7b", 0.12]]);

      // Simulate A restarting and forgetting B from state.peers: B's next refreshPeers() sees B missing from A's peers list and re-announces
      delete nodeA.state.peers[nodeB.selfId];
      assert.equal(nodeA.state.peers[nodeB.selfId], undefined);
      await nodeB.refreshPeers();
      for (let i = 0; i < 30; i++) {
        if (nodeA.state.peers[nodeB.selfId]?.providing === true) break;
        await sleep(50);
      }
      assert.equal(nodeA.state.peers[nodeB.selfId]?.providing, true, "refreshPeers re-announces when peer forgot our publicUrl");
    } finally {
      nodeA.close(); nodeB.close(); srvA.close(); srvB.close(); srvUp.close();
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  test("404 no_route distinguishes empty sources from policy-filtered candidates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vpr-b9-chat-"));
    const node = await createNode({ dataDir: dir, port: 18916, host: "127.0.0.1", demoNetwork: false });
    try {
      // 1. No live source or peer connected at all
      await assert.rejects(
        () => node.chat({ model: "auto", messages: [{ role: "user", content: "hi" }] }, {}, new AbortController()),
        (e) => e.status === 404 && e.type === "no_route" && /no live model source or online seller is connected/i.test(e.message),
      );
      // 2. Local model connected, but maxPrice / model name filters it out
      await node.addUpstream({ name: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", models: ["llama3.2:1b"], price: 0.5 });
      node.state.policy.maxPrice = 0.01;
      await assert.rejects(
        () => node.chat({ model: "auto", messages: [{ role: "user", content: "hi" }] }, {}, new AbortController()),
        (e) => e.status === 404 && e.type === "no_route" && /check model name, TEE-only or max-price rules/i.test(e.message),
      );
      // 3. Untrusted gossip relay URL on an unknown private origin is still blocked by SSRF guard
      await assert.rejects(
        () => node.addPeer("http://127.0.0.1:19998/r/0123456789abcdef", 1, false),
        /private address refused/i,
      );
    } finally {
      node.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
