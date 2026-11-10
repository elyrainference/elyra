// Operations surface: GET /healthz (public, metadata only) and GET /metrics (Prometheus text; loopback guard is applied by app.mjs).
import { PROTOCOL, VERSION } from "../core/limits.mjs";
import { metricsText } from "../obs.mjs";
import { send } from "./io.mjs";

export function createOps(node) {
  return {
    healthz: (res) => send(res, 200, { ok: true, version: VERSION, protocol: PROTOCOL, node: node.selfId, uptime: Math.round(process.uptime()), serving: node.upstreams().some((u) => u.kind !== "demo" && node.upstreamUp(u.id)), peersOnline: Object.values(node.state.peers).filter((p) => p.online).length }),
    metrics: (res) => { res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" }); res.end(metricsText()); },
  };
}
