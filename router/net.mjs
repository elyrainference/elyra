// Some ISPs (e.g. Indonesian "Internet Positif") hijack DNS for blocked domains: every *.robinhood.com name
// resolves to a block-page IP and TLS/HTTP then times out. These helpers resolve public hostnames through
// DNS-over-HTTPS (Cloudflare, then Google) and fall back to the system resolver, so chain RPC and explorer
// calls work behind such networks. Localhost/LAN/IP-literal hosts always use the system resolver.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";

const cache = new Map(); // host → { ips, t }
const TTL = 300_000;
const DOH = ["https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"];

const isLocalHost = (h) => h === "localhost" || h.endsWith(".local") || net.isIP(h) !== 0;

async function viaDoh(host) {
  for (const base of DOH) {
    try {
      const r = await fetch(`${base}?name=${encodeURIComponent(host)}&type=A`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      const ips = (j.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
      if (ips.length) return ips;
    } catch { /* try next resolver */ }
  }
  return null;
}

export async function resolveHost(host) {
  if (isLocalHost(host)) return null;
  const hit = cache.get(host);
  if (hit && Date.now() - hit.t < TTL) return hit.ips;
  const ips = await viaDoh(host);
  if (ips) cache.set(host, { ips, t: Date.now() });
  return ips; // null → caller falls back to the system resolver
}

/** Low-level request with DoH-resolved address. Returns { status, statusText, headers, body: Buffer }. */
export async function request(url, { method = "GET", headers = {}, body = null, timeout = 15000 } = {}) {
  const u = new URL(url);
  const ips = await resolveHost(u.hostname);
  const mod = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const opts = {
      method, headers, timeout, hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search,
      ...(ips ? { lookup: (_h, _o, cb) => (_o?.all ? cb(null, ips.map((address) => ({ address, family: 4 }))) : cb(null, ips[Math.floor(Math.random() * ips.length)], 4)) } : {}),
    };
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          let body = Buffer.concat(chunks);
          const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
          const headers = { ...res.headers };
          if (enc) { // callers (ethers) advertise accept-encoding and expect a decoded body
            body = enc.includes("gzip") ? zlib.gunzipSync(body) : enc.includes("br") ? zlib.brotliDecompressSync(body) : enc.includes("deflate") ? zlib.inflateSync(body) : body;
            delete headers["content-encoding"]; headers["content-length"] = String(body.length);
          }
          resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? "", headers, body });
        } catch (e) { reject(e); }
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** fetch-compatible subset (ok/status/json/text) over `request`, for explorer APIs. */
export async function dohFetch(url, opts = {}) {
  const res = await request(url, { method: opts.method, headers: opts.headers, body: opts.body, timeout: opts.timeout });
  return { ok: res.status >= 200 && res.status < 300, status: res.status, text: async () => res.body.toString("utf8"), json: async () => JSON.parse(res.body.toString("utf8")) };
}

/** ethers v6 `FetchRequest.getUrlFunc` implementation: `const fr = new FetchRequest(url); fr.getUrlFunc = ethersGetUrl;` */
export async function ethersGetUrl(req) {
  const headers = { ...(req.headers ?? {}) };
  const body = req.body ? Buffer.from(req.body) : null;
  if (body) headers["content-length"] = String(body.length);
  const res = await request(req.url, { method: req.method, headers, body, timeout: req.timeout || 30000 });
  const h = {};
  for (const [k, v] of Object.entries(res.headers)) h[k] = Array.isArray(v) ? v.join(", ") : String(v);
  return { statusCode: res.status, statusMessage: res.statusText, headers: h, body: new Uint8Array(res.body) };
}
