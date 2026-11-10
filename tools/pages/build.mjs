// Builds dist/ for Cloudflare Pages: the landing mirror (site/) + docs rendered from Markdown + the static app demo.
// Dev-only tool (dependency: marked). The runtime itself has no build step.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocs } from "./docs.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const here = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const REPO = (process.env.REPO_URL || "https://github.com/elyrainference/elyra").replace(/\/$/, "");

rmSync(dist, { recursive: true, force: true });
cpSync(join(root, "site"), dist, { recursive: true });

// docs: grouped, searchable pages in the landing page's visual language (see docs.mjs / docs.css / docs.js)
const { pages, notFound, searchEntries } = buildDocs({ root, dist, REPO });
// without a 404.html Cloudflare Pages answers unknown paths with 200 + the landing page
writeFileSync(join(dist, "404.html"), notFound);

// /app/ on the website is the live app: Cloudflare sends visitors to the real node (signed-out try page; the owner signs in there).
// There is no static demo any more: nothing on the public site pretends to be a node.
writeFileSync(join(dist, "_redirects"), "/app https://app.elyrainference.com/ 302\n/app/* https://app.elyrainference.com/ 302\n");
writeFileSync(join(dist, "_headers"), "/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: SAMEORIGIN\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n");
for (const secret of [".elyra", ".env"]) if (existsSync(join(dist, secret))) throw new Error(`refusing to publish ${secret}`);
console.log(`dist/: ${pages.length} doc pages (${searchEntries} search entries) + landing`);
