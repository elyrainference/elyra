// Reown's public picker must be reachable without opening owner assets or broadening script execution.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { publicWalletConfig } from "../http/wallet-policy.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const projectId = "1234567890abcdef1234567890abcdef";

describe("public AppKit without owner access", () => {
  let proc, port; const dir = mkdtempSync(join(tmpdir(), "elyra-reown-test-"));
  const get = (path) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host: "wallet.elyra.test" } }, (res) => {
      let body = ""; res.setEncoding("utf8"); res.on("data", (c) => body += c); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }); req.on("error", reject); req.end();
  });
  before(async () => {
    const probe = createServer(); await new Promise((r) => probe.listen(0, "127.0.0.1", r)); port = probe.address().port; await new Promise((r) => probe.close(r));
    proc = spawn(process.execPath, [join(root, "router/server.mjs"), "--port", String(port), "--data", dir, "--no-demo"], {
      env: { ...process.env, ELYRA_PUBLIC_TRY: "1", ELYRA_ADMIN_HOST: "wallet.elyra.test", ELYRA_ADMIN_TOKEN: "isolated-test-admin-token-123456789", ELYRA_REOWN_PROJECT_ID: projectId }, stdio: "ignore",
    });
    for (let i = 0; i < 150; i++) { try { if ((await get("/pub/info")).status === 200) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    throw new Error("Public wallet test node did not boot");
  });
  after(async () => {
    if (proc?.exitCode === null) { const exit = new Promise((r) => proc.once("exit", r)); proc.kill(); await exit; }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  test("connecting is configurable independently of escrow funding, without leaking owner secrets", async () => {
    const info = JSON.parse((await get("/pub/info")).body);
    assert.equal(info.walletConnect.projectId, projectId);
    assert.equal(info.settlement.mode, "sim");
    assert.equal(JSON.parse((await get("/pub/chain")).body).enabled, false);
    const cfg = publicWalletConfig({ chain: { network: "robinhood-mainnet", rpcUrl: "https://user:secret@private.example" }, wallet: { privateKey: "secret" } }, { ELYRA_REOWN_PROJECT_ID: projectId });
    assert.equal(cfg.chainId, 4663);
    assert.doesNotMatch(JSON.stringify(cfg), /secret|private\.example|privateKey/);
    for (const bad of [undefined, "", "x".repeat(32), "https://evil.example"]) assert.equal(publicWalletConfig({ chain: {} }, { ELYRA_REOWN_PROJECT_ID: bad }), null);
  });
  test("SDK styles and exact service origins are allowed, but remote scripts, eval and framing the app remain blocked", async () => {
    const page = await get("/"); const policy = page.headers["content-security-policy"];
    assert.match(policy, /(?:^|; )script-src 'self';/);
    assert.doesNotMatch(policy, /unsafe-eval|script-src[^;]*unsafe-inline|connect-src[^;]*\*/);
    assert.match(policy, /style-src 'self' 'unsafe-inline'/);
    assert.match(policy, /wss:\/\/relay\.walletconnect\.org/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.equal(page.headers["x-frame-options"], "DENY");
  });
  test("the public picker bundle is served, while panel and owner APIs stay protected", async () => {
    const bundle = await get("/try/appkit.js");
    assert.equal(bundle.status, 200); assert.match(bundle.headers["content-type"], /javascript/);
    assert.equal((await get("/app/vendor/wallet.js")).status, 302);
    assert.equal((await get("/api/chain")).status, 401);
    assert.equal((await get("/try/%2e%2e%2fvendor/wallet.js")).status, 404);
  });
});
