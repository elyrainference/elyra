// The control panel is native ES modules with no build step, so a broken import path (a rename, a deleted file) only shows up as a blank page.
// This walks the import graph from index.html through a real node and requires every module, stylesheet and asset to be served.
// Second block: every module parses, every named import resolves to an export, the design tokens meet WCAG AA in both themes, and the keyboard/mobile guards hold.
// Run: node --test router/test/panel.test.mjs
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

const server = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
const panel = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "panel");
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(panel).filter((f) => f.endsWith(".js"));
const PORT = 18820, BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("panel serves a complete module graph", () => {
  let proc; const dir = mkdtempSync(join(tmpdir(), "vpr-panel-"));
  before(async () => {
    proc = spawn(process.execPath, [server, "--port", String(PORT), "--data", dir, "--no-demo"], { stdio: "pipe" });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* booting */ } await sleep(100); }
    throw new Error("node did not start");
  });
  after(async () => { const d = new Promise((r) => proc.once("exit", r)); proc.kill(); await d; rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  const get = async (path) => { const r = await fetch(BASE + path); return { status: r.status, type: r.headers.get("content-type") ?? "", text: r.ok ? await r.text() : "" }; };
  const specs = (src) => [...src.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)].map((m) => m[1]);

  test("every module reachable from index.html resolves and is served as JavaScript; every stylesheet is served", async () => {
    const html = await get("/app/");
    assert.equal(html.status, 200);
    const scripts = [...html.text.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
    const styles = [...html.text.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(scripts.some((s) => s.endsWith("main.js")), "index.html loads main.js");
    for (const css of styles) { const r = await get(css); assert.equal(r.status, 200, css); assert.match(r.type, /css/, css); }

    const seen = new Set(), queue = scripts.filter((s) => s.startsWith("/")), missing = [];
    while (queue.length) {
      const url = queue.shift();
      if (seen.has(url)) continue;
      seen.add(url);
      const r = await get(url);
      if (r.status !== 200 || !/javascript/.test(r.type)) { missing.push(`${url} -> ${r.status} ${r.type}`); continue; }
      for (const s of specs(r.text)) queue.push(new URL(s, BASE + url).pathname);
    }
    assert.deepEqual(missing, [], "modules that do not resolve");
    assert.ok(seen.size > 20, `walked ${seen.size} modules`);
  });

  test("the panel never serves the node's private data or source tree", async () => {
    for (const p of ["/router/server.mjs", "/app/../router/server.mjs", "/.elyra/identity.json", "/app/../.elyra/state.json", "/contracts/deploy.mjs"]) {
      const r = await fetch(BASE + p);
      assert.equal(r.status, 404, p);
    }
  });
});

describe("panel modules", () => {
  test("there are panel modules to check", () => assert.ok(files.length > 20));

  test("every module parses (catches duplicate imports, stray braces, bad syntax)", () => {
    for (const f of files) {
      const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
      assert.equal(r.status, 0, `${f.replace(panel, "panel")}\n${r.stderr}`);
    }
  });

  test("every relative import points at a file that exports the imported names", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.[^"]+)"/g)) {
        const target = resolve(dirname(f), m[2]);
        let body; try { body = readFileSync(target, "utf8"); } catch { assert.fail(`${f.replace(panel, "panel")} imports missing file ${m[2]}`); }
        for (const raw of m[1].split(",").map((s) => s.trim()).filter(Boolean)) {
          const name = raw.split(/\s+as\s+/)[0];
          const n = name.replace(/[$]/g, "\\$&"); // `$` is a valid identifier and a regex metacharacter
          const exported = new RegExp(`export\\s+(?:async\\s+)?(?:const|let|function\\*?|class)\\s+${n}(?![\\w$])|export\\s*\\{[^}]*(?<![\\w$])${n}(?![\\w$])[^}]*\\}`).test(body);
          assert.ok(exported, `${f.replace(panel, "panel")}: "${name}" is not exported by ${m[2]}`);
        }
      }
    }
  });

  test("index.html boots the panel and every view container exists", () => {
    const html = readFileSync(join(panel, "index.html"), "utf8");
    assert.ok(html.includes('src="/app/main.js"'));
    for (const v of ["overview", "playground", "models", "routing", "network", "payments", "provide", "connect"]) assert.ok(html.includes(`id="v-${v}"`), v);
  });

  test("VERSION and /api/status report the real package.json version (never a stale hardcoded string)", async () => {
    const pkg = JSON.parse(readFileSync(join(panel, "..", "package.json"), "utf8"));
    const { VERSION } = await import("../core/limits.mjs");
    assert.equal(VERSION, pkg.version);
    const { createNode } = await import("../core/node.mjs");
    const { createApi } = await import("../http/api.mjs");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "vpr-ver-"));
    const node = await createNode({ dataDir: dir, port: 18992, host: "127.0.0.1", demoNetwork: false });
    try {
      let out;
      await createApi(node)({ method: "GET", headers: {} }, { writeHead() {}, end(b) { out = JSON.parse(b); } }, "/api/status", new URLSearchParams());
      assert.equal(out.node.version, pkg.version);
    } finally {
      node.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("WCAG 2.1 AA contrast: text and semantic tokens meet >= 4.5:1 on the page, card and raised surfaces, in the dark and the light theme (panel and public page)", () => {
    const hexRgb = (h) => {
      const m = /^#([0-9a-f]{6})$/i.exec(h.trim());
      assert.ok(m, `expected 6-digit hex color, got ${h}`);
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    const lum = ([r, g, b]) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
    // The design has two themes: :root is dark (the default) and [data-theme="light"] overrides the colour tokens. Every theme of both stylesheets is checked.
    for (const rel of ["css/base.css", "try/try.css"]) {
      const css = readFileSync(join(panel, rel), "utf8");
      const root = /:root\{([^}]*)\}/.exec(css)?.[1];
      // try/try.css is single-theme (light); the panel keeps a dark :root plus a light override
      const themes = rel === "try/try.css" ? { light: root } : { dark: root, light: /\[data-theme="light"\]\{([^}]*)\}/.exec(css)?.[1] };
      for (const [name, block] of Object.entries(themes)) {
        assert.ok(block, `${rel} defines the ${name} theme tokens`);
        const tok = (n) => { const m = new RegExp(`--${n}:\\s*(#[0-9a-fA-F]{6})`).exec(block); assert.ok(m, `${rel} ${name}: --${n} is a 6-digit hex colour`); return hexRgb(m[1]); };
        for (const fg of ["text", "muted", "faint", "ok", "warn", "bad", "sim", "accent-text"]) {
          for (const bg of ["bg", "surface", "raised"]) {
            const r = ratio(tok(fg), tok(bg));
            assert.ok(r >= 4.5, `${rel} ${name}: --${fg} on --${bg} is ${r.toFixed(2)}:1 (< 4.5:1)`);
          }
        }
      }
    }
  });

  test("keyboard & mobile UX guards: focus is never clipped, starter chips wrap, labels and aria wired, the phone drawer makes the page behind it inert", () => {
    const css = (rel) => readFileSync(join(panel, rel), "utf8");
    const baseCss = css("css/base.css"), tryCss = css("try/try.css");
    assert.match(baseCss, /:focus-visible/, "panel base.css must define :focus-visible");
    assert.match(tryCss, /:focus-visible/, "try.css must define :focus-visible");
    // the earlier design cut the corners of .btn with clip-path, which hides a focus outline; this one must not bring that back
    for (const rel of ["css/base.css", "css/components.css", "css/responsive.css", "try/try.css"]) assert.equal(/\.btn[^{]*\{[^}]*clip-path/.test(css(rel)), false, `${rel}: a .btn rule uses clip-path (clips the focus ring)`);
    // starter prompts must wrap inside the 390px layout instead of overflowing it
    const starter = /(?:^|\n)\.starter\{([^}]*)\}/.exec(tryCss)?.[1] ?? "";
    assert.ok(starter, "try.css styles .starter");
    assert.equal(/white-space:\s*nowrap/.test(starter), false, ".starter must wrap");
    assert.match(tryCss, /@media\(max-width:\d+px\)\{[^]*?\.starters\{grid-template-columns:minmax\(0,1fr\)\}/, "starters stack in one column on phones");

    // Every <label class="f"> in panel/views/*.js must have a matching for="..." attribute
    const viewDir = join(panel, "views");
    for (const vf of readdirSync(viewDir).filter((f) => f.endsWith(".js"))) {
      const src = readFileSync(join(viewDir, vf), "utf8");
      for (const m of src.matchAll(/<label\s+class="f"(?![^>]*\bfor=)[^>]*>/g)) {
        assert.fail(`panel/views/${vf} has <label class="f"> without for="...": ${m[0]}`);
      }
    }

    const controlsSrc = readFileSync(join(panel, "components/controls.js"), "utf8");
    assert.match(controlsSrc, /role="switch"/, "switchRow must have role=switch");
    assert.match(controlsSrc, /aria-label="/, "switchRow must have aria-label");

    // phones: the sidebar becomes a drawer with visible labels (no icon-only mode), so the nav buttons are real buttons with a visible name
    const navSrc = readFileSync(join(panel, "lib/nav.js"), "utf8");
    assert.match(navSrc, /<button type="button" class="nav"[^`]*<span>\$\{label\}<\/span>/, "sidebar nav buttons are type=button with a visible label");

    const netGraph = readFileSync(join(panel, "views/network-graph.js"), "utf8");
    assert.match(netGraph, /tabindex="0"/, "network topology nodes must be keyboard focusable");

    // the phone drawer: sidebar inert while closed, page behind it inert while open (focus cannot wander under the scrim)
    const drawer = readFileSync(join(panel, "lib/drawer.js"), "utf8");
    assert.match(drawer, /\$\("\.side"\)\.inert\s*=\s*mq\.matches\s*&&\s*!open/, "closed drawer: sidebar inert");
    assert.match(drawer, /\$\("#scroll"\)\.inert\s*=\s*mq\.matches\s*&&\s*open/, "open drawer: page content inert");
  });
});
