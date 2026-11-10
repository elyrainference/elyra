import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocs, NAV } from "../../tools/pages/docs.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = "https://github.com/elyrainference/elyra";

const slugifyHeading = (s) =>
  s.replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";

describe("end-user documentation and built docs bundle (B8)", () => {
  it("builds dist/ with 0 broken internal links, anchors, or mangled external URLs", () => {
    const tmpDist = mkdtempSync(join(tmpdir(), "elyra-docs-test-"));
    try {
      cpSync(join(ROOT, "site"), tmpDist, { recursive: true });
      const { pages, notFound, searchEntries } = buildDocs({ root: ROOT, dist: tmpDist, REPO });
      writeFileSync(join(tmpDist, "404.html"), notFound);

      assert.ok(pages.length >= 19, `expected >= 19 doc pages, got ${pages.length}`);
      assert.ok(searchEntries >= 140, `expected >= 140 search entries, got ${searchEntries}`);

      const htmlFiles = [];
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith(".html")) htmlFiles.push(p);
        }
      };
      walk(tmpDist);

      const idsByFile = new Map();
      for (const f of htmlFiles) {
        const h = readFileSync(f, "utf8");
        const ids = new Set();
        for (const m of h.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
        idsByFile.set(f, ids);
      }

      let totalInternal = 0;
      let totalExternal = 0;
      const broken = [];

      for (const f of htmlFiles) {
        const h = readFileSync(f, "utf8");
        for (const m of h.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
          const raw = m[1];
          if (/\/blob\/main\/.*https?:/i.test(raw)) {
            broken.push({ from: f.replace(tmpDist, ""), raw, reason: "mangled external URL into GitHub blob link" });
            continue;
          }
          const ghMatch = raw.match(/^https:\/\/github\.com\/elyrainference\/elyra\/(?:blob|edit)\/main\/([^#?]+)(#.*)?$/);
          if (ghMatch) {
            const repoRel = ghMatch[1];
            if (!existsSync(join(ROOT, repoRel))) {
              broken.push({ from: f.replace(tmpDist, ""), raw, reason: `missing repo file ${repoRel}` });
            }
            continue;
          }
          if (/^(https?:|mailto:|tel:|data:|javascript:)/i.test(raw)) {
            totalExternal++;
            continue;
          }
          totalInternal++;
          const [pathPart, hashPart] = raw.split("#");
          let targetFile = f;
          if (pathPart) {
            const clean = pathPart.split("?")[0];
            if (clean === "/app" || clean.startsWith("/app/")) continue;
            const rel = clean.startsWith("/") ? join(tmpDist, clean) : resolve(dirname(f), clean);
            if (existsSync(rel) && statSync(rel).isFile()) targetFile = rel;
            else if (existsSync(join(rel, "index.html"))) targetFile = join(rel, "index.html");
            else if (existsSync(rel + ".html")) targetFile = rel + ".html";
            else {
              broken.push({ from: f.replace(tmpDist, ""), raw, reason: "missing target file" });
              continue;
            }
          }
          if (hashPart && targetFile.endsWith(".html")) {
            const ids = idsByFile.get(targetFile);
            if (ids && !ids.has(hashPart)) {
              broken.push({
                from: f.replace(tmpDist, ""),
                raw,
                reason: `missing anchor #${hashPart} in ${targetFile.replace(tmpDist, "")}`,
              });
            }
          }
        }
      }

      assert.ok(totalInternal >= 1000, `expected >= 1000 internal links, got ${totalInternal}`);
      assert.ok(totalExternal >= 10, `expected >= 10 preserved external links, got ${totalExternal}`);
      assert.deepEqual(broken, []);
    } finally {
      rmSync(tmpDist, { recursive: true, force: true });
    }
  });

  it("verifies every relative Markdown link and #heading anchor across repo Markdown files", () => {
    const mdFiles = [
      "README.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "ROADMAP.md",
      "CHANGELOG.md",
      "AGENTS.md",
      "PRD.md",
      ...readdirSync(join(ROOT, "docs"))
        .filter((f) => f.endsWith(".md"))
        .map((f) => `docs/${f}`),
    ];
    const navBySlug = new Map(NAV.flatMap((g) => g.items.map((it) => [it.slug, it.src])));
    const headingsCache = new Map();
    const headingsOf = (absFile) => {
      if (headingsCache.has(absFile)) return headingsCache.get(absFile);
      const md = readFileSync(absFile, "utf8");
      const ids = new Set();
      const used = new Map();
      for (const line of md.split("\n")) {
        const m = line.match(/^(#{1,4})\s+(.+?)\s*$/);
        if (!m) continue;
        let id = slugifyHeading(m[2]);
        const n = used.get(id) ?? 0;
        used.set(id, n + 1);
        if (n) id += "-" + n;
        ids.add(id);
      }
      headingsCache.set(absFile, ids);
      return ids;
    };

    const broken = [];
    for (const relFile of mdFiles) {
      const absFrom = join(ROOT, relFile);
      const md = readFileSync(absFrom, "utf8").replace(/```[\s\S]*?```/g, "");
      for (const m of md.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) {
        const raw = m[1];
        if (/^(https?:|mailto:)/i.test(raw)) continue;
        const [p, h] = raw.split("#");
        let absTarget = absFrom;
        if (p) {
          if (p.startsWith("/docs/")) {
            const slug = p.replace(/^\/docs\/|\/$/g, "");
            const src = slug ? navBySlug.get(slug) : "docs/README.md";
            if (!src) {
              broken.push({ from: relFile, raw, reason: `unknown /docs/ slug ${slug}` });
              continue;
            }
            absTarget = join(ROOT, src);
          } else {
            absTarget = resolve(dirname(absFrom), p);
            if (!existsSync(absTarget)) {
              broken.push({ from: relFile, raw, reason: `missing file ${p}` });
              continue;
            }
          }
        }
        if (h && absTarget.endsWith(".md")) {
          const ids = headingsOf(absTarget);
          if (!ids.has(h)) {
            broken.push({ from: relFile, raw, reason: `missing heading #${h} in ${absTarget.replace(ROOT + "/", "")}` });
          }
        }
      }
    }
    assert.deepEqual(broken, []);
  });

  it("keeps README, QUICKSTART, PROVIDER, WALLET, FAQ and STATUS consistent with built features and free of stale facts", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const quickstart = readFileSync(join(ROOT, "docs/QUICKSTART.md"), "utf8");
    const provider = readFileSync(join(ROOT, "docs/PROVIDER.md"), "utf8");
    const wallet = readFileSync(join(ROOT, "docs/WALLET.md"), "utf8");
    const faq = readFileSync(join(ROOT, "docs/FAQ.md"), "utf8");
    const status = readFileSync(join(ROOT, "docs/STATUS.md"), "utf8");
    const usage = readFileSync(join(ROOT, "docs/USAGE.md"), "utf8");

    for (const [name, doc] of [
      ["README.md", readme],
      ["QUICKSTART.md", quickstart],
      ["PROVIDER.md", provider],
      ["WALLET.md", wallet],
      ["FAQ.md", faq],
    ]) {
      assert.match(doc, /ELYRA_PUBLIC_PAY|session key|Pay-per-use/i, `${name} must document browser pay-per-use`);
      assert.match(doc, /HOSTED\s*·\s*CLEAR|Hosted.*peer-to-peer/is, `${name} must distinguish hosted vs P2P`);
      assert.match(doc, /TEE|Confidential Space/i, `${name} must document TEE limits`);
      assert.match(doc, /\$20|maxDepositUsd/i, `${name} must document the $20 per-wallet deposit cap`);
    }

    assert.match(wallet, /deposit\s*-\s*owed|withdrawable/i, "WALLET.md must document safe withdrawal leaving owed vouchers covered");
    assert.match(provider, /upstreamId:\s*"\*"|All healthy local sources/i, "PROVIDER.md must document multi-source selling");
    assert.match(faq, /339 unique canonical models from 57 vendors/i, "FAQ.md must include measured deduplicated catalog stats");
    assert.match(usage, /"version":"0\.1\.0"/, "USAGE.md healthz example must show version 0.1.0");

    assert.match(status, /SDD\.md/, "STATUS.md must point to SDD.md");
    for (const stale of [
      "17 tests",
      "19 contract tests",
      "# 22 tests",
      "42/42 pass",
      "62/62 on Node",
      "Tested only against a stub server",
      "Attestation verification needs TEE hardware and is not implemented",
      "this folder is not a git repo yet",
      "The repo folder is still called `solais`",
      "no custom domain yet; repository is private",
    ]) {
      assert.ok(!status.includes(stale), `STATUS.md still contains stale text: ${stale}`);
    }
  });
});
