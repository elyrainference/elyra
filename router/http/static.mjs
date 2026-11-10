// Static file serving. URL space: /app/* -> panel/ (control panel), everything else -> site/ (landing page, legal
// pages, theme assets). Only these two directories are ever served; router/, contracts/, data dirs etc. are not
// reachable. Dot segments (.elyra*/ holds identity.json) and node_modules are never served.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { send } from "./io.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".woff": "font/woff",
  ".woff2": "font/woff2", ".ttf": "font/ttf", ".ico": "image/x-icon", ".wasm": "application/wasm", ".glb": "model/gltf-binary",
  ".exr": "image/x-exr", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
};

async function fileAt(p) { try { const s = await stat(p); return s.isFile() ? { path: p, size: s.size } : undefined; } catch { return undefined; } }

export function createStatic({ panelDir, siteDir }) {
  return async function staticFile(req, res, pathname) {
    const notFound = () => send(res, 404, { error: { message: "Not Found" } });
    // the landing page links to /docs/, which lives on the public website (Cloudflare Pages), not in this node: send visitors there
    if (pathname === "/docs" || pathname.startsWith("/docs/")) {
      const env = process.env.ELYRA_DOCS_URL ?? "";
      const docs = /^https?:\/\//.test(env) ? env : "https://elyrainference.com/docs/"; // only http(s) targets are honoured
      res.writeHead(302, { location: docs, "cache-control": "no-store" });
      return res.end();
    }
    const rel0 = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
    if (rel0.split(/[\\/]/).some((s) => s.startsWith(".") || s === "node_modules")) return notFound();
    const isPanel = rel0 === "app" || rel0.startsWith("app/") || rel0.startsWith("app\\");
    const dir = isPanel ? panelDir : siteDir;
    const rel = isPanel ? rel0.slice(3).replace(/^([/\\])+/, "") : rel0;
    const base = join(dir, rel);
    if (base !== dir && !base.startsWith(dir + sep)) return notFound();
    const f = (await fileAt(base)) ?? (await fileAt(base + ".html")) ?? (await fileAt(join(base, "index.html")));
    if (!f) return notFound();
    res.writeHead(200, { "content-type": MIME[extname(f.path).toLowerCase()] ?? "application/octet-stream", "content-length": f.size, "cache-control": /\.(js|css|html|svg)$/.test(f.path) ? "no-store" : "no-cache" });
    if (req.method === "HEAD") return res.end();
    createReadStream(f.path).pipe(res);
  };
}
