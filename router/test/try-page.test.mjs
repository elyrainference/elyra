// The public page (panel/try) is served under a strict CSP (script-src 'self', style-src 'self') and is native ES modules with no build step.
// A broken import path or an inline script/style only shows up in a browser, so this checks the contract on disk:
// every module reachable from index.html exists, nothing is inline, and the routes the nav links to have a page.
// Run: node --test router/test/try-page.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "panel", "try");
const html = readFileSync(join(dir, "index.html"), "utf8");
const onDisk = (urlPath) => join(dir, urlPath.replace(/^\/try\//, ""));

describe("public page", () => {
  test("no inline script, inline style, style attribute or event-handler attribute (CSP)", () => {
    assert.equal([...html.matchAll(/<script\b(?![^>]*\ssrc=)[^>]*>/gi)].length, 0, "every <script> has a src");
    assert.equal(/<style\b/i.test(html), false, "no <style> element");
    assert.equal(/\sstyle\s*=/i.test(html), false, "no style attribute");
    assert.equal(/\son[a-z]+\s*=/i.test(html), false, "no on* attribute");
    for (const f of ["lib.js", "try.js", "market.js", "chat.js", "wallet.js", "auth.js", "pay.js", "theme.js"]) {
      const src = readFileSync(join(dir, f), "utf8");
      assert.equal(/\.setAttribute\(\s*["']style["']/.test(src), false, f + " must not set a style attribute");
      assert.equal(/\.innerHTML\s*=|insertAdjacentHTML|document\.write/.test(src), false, f + " renders server text with textContent only");
    }
  });

  test("every script, stylesheet and module import reachable from index.html exists", () => {
    const entries = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(entries.includes("/try/try.js") && entries.includes("/try/theme.js"));
    for (const css of [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1])) assert.ok(existsSync(onDisk(css)), css);
    const seen = new Set(), queue = entries.filter((s) => s.startsWith("/try/"));
    while (queue.length) {
      const u = queue.pop(); if (seen.has(u)) continue; seen.add(u);
      assert.ok(existsSync(onDisk(u)), "missing " + u);
      const src = readFileSync(onDisk(u), "utf8");
      for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.[^"']+)["']/g)) queue.push(posix.join(posix.dirname(u), m[1]));
    }
    assert.ok(seen.has("/try/auth.js"), "the wallet sign-in helper is reachable from wallet.js");
    assert.ok(seen.has("/try/pay.js"), "the pay-per-use session is reachable from try.js");
    assert.ok(existsSync(join(dir, "session.js")), "pay.js loads /try/session.js on demand (a dynamic import with an absolute path, so it is checked here)");
  });

  test("the built bundles match their .sha256 (panel/vendor/wallet.js, panel/try/session.js): a rebuilt or hand-edited bundle must update its hash", () => {
    const panel = join(dir, "..");
    for (const rel of ["vendor/wallet.js", "try/session.js"]) {
      const want = readFileSync(join(panel, rel + ".sha256"), "utf8").trim().split(/\s+/)[0];
      assert.equal(createHash("sha256").update(readFileSync(join(panel, rel))).digest("hex"), want, rel);
    }
  });

  test("each nav route has a page and a heading to focus", () => {
    const routes = [...html.matchAll(/<a href="#\/([a-z]+)" data-route="([a-z]+)"/g)];
    assert.ok(routes.length >= 3);
    for (const [, hash, route] of routes) {
      assert.equal(hash, route);
      assert.match(html, new RegExp(`<section class="page[^"]*" data-page="${route}"[^>]*aria-labelledby="(h-[a-z]+)"`));
    }
    assert.match(html, /<template id="tpl-paid">/, "the 'paid models need your own node' card is a template");
    assert.equal(/Pay now|Buy tokens|Checkout/i.test(html), false, "no fake payment flow: paying is the visitor's own pay-per-use session, built by pay.js");
  });
});
