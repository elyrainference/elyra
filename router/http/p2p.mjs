// Peer protocol (/p2p/*): the only network-facing surface. Hello (identity advert + gossip), sealed infer, sealed
// voucher push. Must never expose keys, upstream API keys or control actions.
import { HttpError } from "../lib/errors.mjs";
import { abortOnClose, readJson, send, sink } from "./io.mjs";

export function createP2p(node) {
  return async function p2p(req, res, path) {
    if (path === "/p2p/hello" && req.method === "GET") return send(res, 200, { ...node.helloInfo(), peers: node.peerUrls().slice(0, 50) });
    if (path === "/p2p/hello" && req.method === "POST") {
      const h = await readJson(req, 100_000);
      if (typeof h.url === "string") node.addPeer(h.url, 1, false).catch(() => {}); // learned from a stranger: public hosts only
      return send(res, 200, { ok: true });
    }
    if (path === "/p2p/infer" && req.method === "POST") {
      const payload = await readJson(req, 8_000_000);
      return node.serve(payload, sink(res), abortOnClose(res));
    }
    if (path === "/p2p/voucher" && req.method === "POST") return send(res, 200, node.receiveVoucher(await readJson(req, 20_000)));
    throw new HttpError(404, "no such p2p endpoint");
  };
}
