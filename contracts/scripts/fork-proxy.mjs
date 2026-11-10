#!/usr/bin/env node
// Tiny local JSON-RPC proxy for forking Robinhood Chain mainnet with hardhat.
// Hardhat's own fork HTTP client cannot resolve *.robinhood.com behind a DNS-hijacking ISP, so it points at
// this proxy instead, which forwards every POST body to the real RPC through ../../router/net.mjs (DoH-resolved).
// Strictly read-only toward mainnet: the fork only ever issues eth_getStorageAt/getCode/call/getBlock/... reads;
// as a belt-and-braces guard, eth_sendRawTransaction / eth_sendTransaction are refused here.
//   node scripts/fork-proxy.mjs [--port 8599] [--upstream https://rpc.mainnet.chain.robinhood.com]
import http from "node:http";
import { fileURLToPath } from "node:url";
import { request } from "../../router/net.mjs";

const WRITE_METHODS = new Set(["eth_sendRawTransaction", "eth_sendTransaction", "eth_sign", "personal_sign"]);

export function startProxy({ port = 8599, host = "127.0.0.1", upstream = "https://rpc.mainnet.chain.robinhood.com", log = () => {} } = {}) {
  let forwarded = 0;
  const stats = { get forwarded() { return forwarded; }, methods: {} };
  const bump = (m) => { stats.methods[m] = (stats.methods[m] ?? 0) + 1; };

  const forward = async (payload) => {
    const items = Array.isArray(payload) ? payload : [payload];
    for (const it of items) if (WRITE_METHODS.has(it?.method)) {
      const err = { jsonrpc: "2.0", id: it.id ?? null, error: { code: -32601, message: `fork proxy is read-only: ${it.method} refused` } };
      return Array.isArray(payload) ? items.map((x) => (x === it ? err : { jsonrpc: "2.0", id: x.id ?? null, error: err.error })) : err;
    }
    for (const it of items) bump(it?.method);
    const body = Buffer.from(JSON.stringify(payload));
    let last;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const res = await request(upstream, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "content-length": String(body.length) }, body, timeout: 30000 });
        forwarded++;
        if (res.status >= 200 && res.status < 300) {
          const out = JSON.parse(res.body.toString("utf8"));
          const rateLimited = (Array.isArray(out) ? out : [out]).some((x) => x?.error?.code === 429);
          if (!rateLimited) return out;
          last = new Error("upstream JSON-RPC 429 Too Many Requests");
        } else {
          last = new Error(`upstream HTTP ${res.status} ${res.statusText}: ${res.body.toString("utf8").slice(0, 200)}`);
          if (res.status < 500 && res.status !== 429) break;
        }
      } catch (e) { last = e; }
      await new Promise((r) => setTimeout(r, Math.min(4000, 400 * 2 ** attempt))); // backoff (the public RPC rate-limits)
    }
    throw last;
  };

  const server = http.createServer((req, res) => {
    if (req.method !== "POST") { res.writeHead(405, { allow: "POST" }).end(); return; }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
        return;
      }
      try {
        const out = await forward(payload);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
      } catch (e) {
        log(`upstream failure: ${e.message}`);
        res.writeHead(502, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: payload?.id ?? null, error: { code: -32000, message: `proxy upstream failure: ${e.message}` } }));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve({ server, stats, url: `http://${host}:${port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) }));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
  const p = await startProxy({ port: Number(opt("port", 8599)), upstream: opt("upstream", "https://rpc.mainnet.chain.robinhood.com"), log: (m) => console.error(m) });
  console.error(`fork-proxy listening on ${p.url} -> ${opt("upstream", "https://rpc.mainnet.chain.robinhood.com")}`);
}
