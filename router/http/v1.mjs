// OpenAI-compatible surface (/v1/*, loopback only): GET /v1/models and POST /v1/chat/completions.
import { HttpError } from "../lib/errors.mjs";
import { abortOnClose, readJson, send, sink } from "./io.mjs";

export function createV1(node) {
  return async function v1(req, res, path) {
    if (path === "/v1/models" && req.method === "GET") {
      const seen = new Map();
      for (const c of node.cands()) if (!seen.has(c.model) || c.kind === "self") seen.set(c.model, c);
      const data = [...["auto", "auto:cheapest", "auto:fastest", "auto:best", "auto:private"].map((id) => ({ id, object: "model", created: 0, owned_by: "elyra-router" })),
        ...[...seen.values()].map((c) => ({ id: c.model, object: "model", created: 0, owned_by: c.peerName }))];
      return send(res, 200, { object: "list", data });
    }
    if (path === "/v1/chat/completions" && req.method === "POST") {
      const body = await readJson(req, 8_000_000);
      if (!Array.isArray(body.messages)) throw new HttpError(400, "messages array required", "invalid_request_error");
      return node.chat(body, sink(res), abortOnClose(res));
    }
    throw new HttpError(404, "unsupported endpoint — Elyra VPR implements GET /v1/models and POST /v1/chat/completions");
  };
}
