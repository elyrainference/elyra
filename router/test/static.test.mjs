// /docs on a node redirects to the public docs (the landing page links there); everything else in static serving is unchanged.
// Run: node --test router/test/static.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { createStatic } from "../http/static.mjs";

const dirs = [];
const setup = () => {
  const d = mkdtempSync(join(tmpdir(), "vpr-static-")); dirs.push(d);
  mkdirSync(join(d, "site")); mkdirSync(join(d, "panel"));
  writeFileSync(join(d, "site", "index.html"), "<h1>landing</h1>"); writeFileSync(join(d, "panel", "index.html"), "<h1>panel</h1>");
  return createStatic({ panelDir: join(d, "panel"), siteDir: join(d, "site") });
};
const call = async (handler, path) => {
  const out = { status: 0, headers: {}, body: "" };
  const res = { writeHead(s, h = {}) { out.status = s; out.headers = h; return this; }, end(b = "") { out.body += b; return this; }, write(b) { out.body += b; }, on() {}, once() {}, emit() {} };
  await handler({ method: "GET", headers: {} }, res, path);
  return out;
};
afterEach(() => { delete process.env.ELYRA_DOCS_URL; });

describe("/docs on a node", () => {
  test("redirects to the public docs by default and for any sub-path", async () => {
    const h = setup();
    for (const p of ["/docs", "/docs/", "/docs/install/"]) {
      const r = await call(h, p);
      assert.equal(r.status, 302, p);
      assert.equal(r.headers.location, "https://elyrainference.com/docs/");
    }
  });
  test("ELYRA_DOCS_URL overrides the target, but only http(s) URLs are honoured", async () => {
    const h = setup();
    process.env.ELYRA_DOCS_URL = "https://docs.example.com/";
    assert.equal((await call(h, "/docs/")).headers.location, "https://docs.example.com/");
    process.env.ELYRA_DOCS_URL = "javascript:alert(1)";
    assert.equal((await call(h, "/docs/")).headers.location, "https://elyrainference.com/docs/", "a non-http value falls back to the default");
  });
  test("other paths still serve the landing page and the panel, and a docs-like name is not swallowed", async () => {
    const h = setup();
    assert.equal((await call(h, "/")).status, 200);
    assert.equal((await call(h, "/app/")).status, 200);
    assert.equal((await call(h, "/documents")).status, 404, "/documents is not /docs");
  });
});
