// Boot-time environment (ELYRA_UPSTREAM_URL, ELYRA_PROVIDE_PRICE, ELYRA_PROVIDE, ELYRA_PAYOUT) seeds a fresh node; it must not overwrite
// what the owner configured afterwards (found live: a restart reset a seller's GPU models to the first local source).
// Run: node --test router/test/boot-config.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
const J = { "content-type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkStub = (models) => createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: models.map((id) => ({ id })) })); });

describe("environment seeds, it does not overwrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "vpr-boot-")); const restoreDir = mkdtempSync(join(tmpdir(), "vpr-restore-"));
  const A = mkStub(["small"]), B = mkStub(["big-1", "big-2"]);
  const PA = 18760, PB = 18761, P = 18762, PR = 18763;
  after(() => { A.close(); B.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); rmSync(restoreDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const boot = async (env, port = P, dataDir = dir) => {
    const p = spawn(process.execPath, [server, "--port", String(port), "--data", dataDir, "--no-demo"], { env: { ...process.env, ...env }, stdio: "pipe" });
    for (let i = 0; i < 300; i++) { try { if ((await fetch(`http://localhost:${port}/p2p/hello`)).ok) break; } catch { /* booting */ } await sleep(100); }
    await sleep(600); return p;
  };
  const api = async (path, method = "GET", body, port = P) => (await fetch(`http://localhost:${port}${path}`, { method, headers: J, body: body && JSON.stringify(body) })).json();
  const stop = async (p) => { const d = new Promise((r) => p.once("exit", r)); p.kill(); await d; };

  test("first boot applies the env; after the owner changes source and price, the next boot keeps the owner's choice", async () => {
    await new Promise((r) => A.listen(PA, r)); await new Promise((r) => B.listen(PB, r));
    const env = { ELYRA_PASSPHRASE: "test-backup-passphrase", ELYRA_UPSTREAM_URL: `http://localhost:${PA}/v1`, ELYRA_UPSTREAM_NAME: "seed", ELYRA_PROVIDE: "1", ELYRA_PROVIDE_PRICE: "0.5", ELYRA_MAX_DEPOSIT_USD: "25", ELYRA_PAYOUT: "0x" + "ab".repeat(20) };
    let p = await boot(env);
    let pr = await api("/api/provide"); const seed = (await api("/api/upstreams")).upstreams.find((u) => u.name === "seed");
    assert.equal(pr.enabled, true); assert.equal(pr.price, 0.5); assert.equal(pr.maxDepositUsd, 25); assert.equal(pr.upstreamId, seed.id, "fresh node: env applies");
    const big = await api("/api/upstreams", "POST", { name: "big", baseUrl: `http://localhost:${PB}/v1` });
    await api("/api/provide", "PUT", { enabled: true, upstreamId: big.id, models: ["big-1", "big-2"], price: 0.2, prices: { "big-2": 0.4 }, maxDepositUsd: 15 });
    await stop(p);
    p = await boot(env);
    try {
      pr = await api("/api/provide");
      assert.equal(pr.upstreamId, big.id, "the owner's source survives a restart");
      assert.equal(pr.price, 0.2, "and the owner's price"); assert.equal(pr.maxDepositUsd, 15, "and the owner's deposit cap"); assert.deepEqual(pr.prices, { "big-2": 0.4 });
      assert.deepEqual(pr.offered.map((m) => [m.id, m.price]).sort(), [["big-1", 0.2], ["big-2", 0.4]]);
      await api("/api/provide", "PUT", { upstreamId: "*" });
      await stop(p);
      p = await boot(env);
      pr = await api("/api/provide");
      assert.equal(pr.upstreamId, "*", "all-healthy-local-sources '*' survives a restart");
      assert.deepEqual(pr.offered.map((m) => [m.id, m.price]).sort(), [["big-1", 0.2], ["big-2", 0.4], ["small", 0.2]]);

      // Restore drill: copy identity.json, wallet.json, state.json to a spare directory and boot on a spare port with only ELYRA_PASSPHRASE.
      const origHello = await api("/p2p/hello");
      for (const f of ["identity.json", "wallet.json", "state.json"]) cpSync(join(dir, f), join(restoreDir, f));
      for (const f of ["identity.json", "wallet.json"]) {
        const raw = JSON.parse(readFileSync(join(restoreDir, f), "utf8"));
        assert.equal(raw.enc, 1, `${f} must be encrypted at rest when ELYRA_PASSPHRASE is set`);
        assert.equal(raw.priv, undefined); assert.equal(raw.privateKey, undefined);
      }
      const bad = spawnSync(process.execPath, [server, "--port", String(PR), "--data", restoreDir, "--no-demo"], { env: { ...process.env, ELYRA_PASSPHRASE: "wrong-passphrase" }, timeout: 8000 });
      assert.notEqual(bad.status, 0, "encrypted backup must refuse to boot with a wrong passphrase");
      const prProc = await boot({ ELYRA_PASSPHRASE: "test-backup-passphrase" }, PR, restoreDir);
      try {
        const restHello = await api("/p2p/hello", "GET", undefined, PR);
        const restPr = await api("/api/provide", "GET", undefined, PR);
        assert.equal(restHello.id, origHello.id, "restored backup preserves node identity");
        assert.equal(restHello.pub, origHello.pub, "restored backup preserves signing key");
        assert.deepEqual(restHello.box, origHello.box, "restored backup preserves box key");
        assert.deepEqual(restHello.wallet, origHello.wallet, "restored backup preserves wallet address and signature");
        assert.equal(restPr.enabled, true);
        assert.equal(restPr.upstreamId, "*");
        assert.equal(restPr.price, 0.2);
        assert.deepEqual(restPr.prices, { "big-2": 0.4 });
        assert.equal(restPr.payout, "0x" + "ab".repeat(20));
      } finally { await stop(prProc); }
    } finally { await stop(p); }
  });
});
