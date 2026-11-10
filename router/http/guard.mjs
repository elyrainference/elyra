// Access policy for the loopback-only surfaces (/api, /v1, /metrics): the peer address must be loopback, the Host
// header a localhost name (DNS-rebinding guard) and any Origin a localhost origin. CORS is granted to localhost origins only.
// Do not loosen: /p2p/* is the only network-facing surface.
import { HttpError } from "../lib/errors.mjs";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const hostname = (h) => { try { return new URL("http://" + h).hostname; } catch { return ""; } };
const isLoopback = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
const localOrigin = (o) => { try { return LOCAL_HOSTS.has(new URL(o).hostname); } catch { return false; } };

/** Throws 403 unless the request is local; 415 for non-JSON bodies on writes. */
export function assertLocalRequest(req) {
  // control + OpenAI surface is loopback-only and refuses DNS-rebinding / cross-site browser writes
  if (!isLoopback(req) || !LOCAL_HOSTS.has(hostname(req.headers.host ?? ""))) throw new HttpError(403, "local access only", "forbidden");
  if (req.headers.origin && !localOrigin(req.headers.origin)) throw new HttpError(403, "cross-site request refused", "forbidden");
}

export function assertJsonContent(req) {
  if (req.method !== "GET" && !String(req.headers["content-type"] ?? "").includes("application/json") && Number(req.headers["content-length"] ?? 0) > 0) throw new HttpError(415, "content-type must be application/json");
}

export function cors(req, res) {
  const o = req.headers.origin;
  if (o && localOrigin(o)) {
    res.setHeader("access-control-allow-origin", o);
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("access-control-expose-headers", "x-elyra-route, x-elyra-model, x-elyra-price, x-elyra-tee, x-elyra-simulated");
  }
}
