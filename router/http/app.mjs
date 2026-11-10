// The HTTP request handler: classify the surface, count it (metadata only: never bodies, prompts or keys), apply the
// right access policy and dispatch. Surfaces: /v1 + /api + /metrics (loopback only), /p2p (open), /healthz, static.
import { PROTOCOL } from "../core/limits.mjs";
import { inc, log, normalisePath } from "../obs.mjs";
import { createApi } from "./api.mjs";
import { HttpError } from "../lib/errors.mjs";
import { assertJsonContent, assertLocalRequest, cors } from "./guard.mjs";
import { send, sendErr } from "./io.mjs";
import { createOps } from "./ops.mjs";
import { createP2p } from "./p2p.mjs";
import { createPublicTry } from "./public.mjs";
import { createRemote } from "./remote.mjs";
import { NETWORKS } from "../chain.mjs";
import { createStatic } from "./static.mjs";
import { createRelay } from "./relay.mjs";
import { createV1 } from "./v1.mjs";

export function createApp(node, { panelDir, siteDir }) {
  const api = createApi(node), v1 = createV1(node), p2p = createP2p(node), ops = createOps(node);
  const staticFile = createStatic({ panelDir, siteDir });
  const remote = createRemote(process.env, { panelDir, accounts: node.accounts, chainId: () => node.state.chain?.chainId || NETWORKS[node.state.chain?.network]?.chainId || 46630 }); // opt-in; { enabled: false } unless ELYRA_ADMIN_HOST + (ELYRA_ADMIN_TOKEN and/or ELYRA_ADMIN_ADDRESSES) are set
  const relay = createRelay(); // opt-in (ELYRA_RELAY=1): carries sealed peer traffic for sellers that cannot accept inbound connections
  const pub = remote.enabled ? createPublicTry(node, { staticFile, identify: remote.session }) : { enabled: false }; // opt-in (ELYRA_PUBLIC_TRY=1): the signed-out try page on the admin host

  return async function handle(req, res) {
    let url;
    try {
      const raw = req.url ?? "/";
      if (!/^\/(?![/\\])/.test(raw)) return res.writeHead(400).end();
      url = new URL(raw, "http://localhost");
      if (decodeURIComponent(url.pathname).includes("\0")) return res.writeHead(400).end();
    } catch { return res.writeHead(400).end(); }
    const path = url.pathname;
    const isLocalOnly = path.startsWith("/api/") || path.startsWith("/v1/") || path === "/metrics";
    const surface = path.startsWith("/v1/") ? "v1" : path.startsWith("/api/") ? "api" : path.startsWith("/p2p/") ? "p2p" : path.startsWith("/pub/") ? "pub" : path.startsWith("/auth/") ? "auth" : path.startsWith("/relay/") || path.startsWith("/r/") ? "relay" : path === "/metrics" || path === "/healthz" ? "ops" : "static";
    const t0 = Date.now();
    res.setHeader("x-elyra-protocol", String(PROTOCOL));
    res.on("finish", () => { // metadata only: never bodies, prompts or keys
      if (surface === "static") return;
      const ms = Date.now() - t0;
      inc("elyra_http_requests_total", { surface, method: req.method, status: Math.floor(res.statusCode / 100) + "xx" });
      inc("elyra_http_request_ms_total", { surface }, ms);
      if (surface !== "ops") log(res.statusCode >= 500 ? "error" : "info", "http", { surface, method: req.method, path: normalisePath(path), status: res.statusCode, ms });
    });
    try {
      if (path === "/healthz") return ops.healthz(res);
      if (relay.enabled && relay.owns(path)) return await relay.handle(req, res, path, url); // self-authenticated (signed), reachable before any login gate
      let viaAdmin = false;
      if (remote.enabled) {
        if (remote.isAdminHost(req)) {
          if (path === "/admin/login") return await remote.login(req, res);
          if (path === "/admin/logout") return remote.logout(req, res);
          if (remote.isAsset(path)) return remote.asset(req, res, path); // the login page's own scripts
          if (path.startsWith("/auth/")) return await remote.auth(req, res, path, url); // wallet sign-in (SIWE); same-origin only, rate limited
          if (pub.enabled && (pub.owns(path) || (path === "/" && !remote.authed(req)))) return await pub.handle(req, res, path); // signed-out visitors: the try page only
          if (!path.startsWith("/p2p/")) { // everything except the open peer protocol needs a session
            if (path === "/metrics") throw new HttpError(403, "local access only", "forbidden");
            if (!remote.authed(req)) {
              if (isLocalOnly) throw remote.session(req) ? new HttpError(403, "this account cannot use the control surface", "forbidden") : new HttpError(401, "sign in required", "unauthorized"); // a wallet visitor (role user) is known but not allowed
              if (pub.enabled && (req.method === "GET" || req.method === "HEAD") && !path.startsWith("/app") && !path.startsWith("/admin")) return pub.missing(req, res); // not a panel page: a plain 404, not a login form
              return res.writeHead(302, { location: "/admin/login", "cache-control": "no-store" }).end();
            }
            viaAdmin = true;
            if (path === "/") return res.writeHead(302, { location: "/app/", "cache-control": "no-store" }).end();
            if (isLocalOnly) remote.assertOrigin(req);
          }
        } else if (path.startsWith("/auth/")) throw new HttpError(404, "Not Found"); // wallet sign-in exists on the admin host only (the SIWE domain)
        else if (isLocalOnly && remote.isProxied(req)) throw new HttpError(403, "local access only", "forbidden"); // proxied traffic never gets the localhost path
      }
      if (isLocalOnly) {
        if (viaAdmin) res.setHeader("cache-control", "no-store");
        else { assertLocalRequest(req); cors(req, res); }
        if (req.method === "OPTIONS") return res.writeHead(204).end();
        if (path === "/metrics") return ops.metrics(res);
        assertJsonContent(req);
        return await (path.startsWith("/v1/") ? v1(req, res, path) : api(req, res, path, url.searchParams));
      }
      if (path.startsWith("/p2p/")) return await p2p(req, res, path);
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: { message: "method not allowed" } });
      return await staticFile(req, res, path);
    } catch (e) { sendErr(res, e); }
  };
}
