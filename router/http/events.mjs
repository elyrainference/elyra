// GET /api/events (Server-Sent Events) and GET /api/events/recent: the owner's private live feed (core/events.mjs).
// Access is decided before this runs, in app.mjs: loopback, or the admin host with a session. It lives under /api, so a
// signed-in visitor (role "user") and every unauthenticated request never get here. Streams are streamed, not
// JSON-dispatched, so api.mjs hands the raw response to `stream`.
import { HttpError } from "../lib/errors.mjs";

const MAX_STREAMS = 8;          // concurrent feed connections per node (a browser tab or two, a curl)
const HEARTBEAT_MS = 15_000;    // comment line: keeps tunnels and proxies from closing an idle stream
const MAX_AGE_MS = 30 * 60_000; // end the stream so the client reconnects and the session is checked again (admin sessions last 12 h)
const MAX_BUFFERED = 1 << 20;   // a client that stops reading is dropped, never buffered without bound

export function createEventsRoutes(node, { heartbeatMs = HEARTBEAT_MS, maxAgeMs = MAX_AGE_MS, maxStreams = MAX_STREAMS } = {}) {
  const { events } = node;
  let open = 0;

  /** the id to resume after: Last-Event-ID (native EventSource reconnect) or ?since= (first connect after /recent); none = live only */
  const resumeFrom = (req, q) => {
    const raw = req.headers["last-event-id"] ?? q.get("since");
    return raw != null && /^\d{1,15}$/.test(String(raw).trim()) ? Number(raw) : events.lastId();
  };

  const recent = () => ({ events: events.recent(), lastId: events.lastId() });

  function stream(req, res, q) {
    if (open >= maxStreams) throw new HttpError(429, "too many live connections", "rate_limited");
    open++;
    let done = false, hb, age, unsub = () => {};
    const end = () => { // idempotent: close, abort and error can all arrive
      if (done) return;
      done = true; open--;
      unsub(); clearInterval(hb); clearTimeout(age);
      if (!res.writableEnded) res.end();
    };
    const write = (chunk) => {
      if (done) return;
      if (res.writableLength > MAX_BUFFERED) { res.destroy(); return end(); }
      res.write(chunk);
    };
    const send = (e) => write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);

    res.on("close", end);
    res.on("error", end);
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    write("retry: 3000\n\n");
    for (const e of events.since(resumeFrom(req, q))) send(e);
    unsub = events.subscribe(send); // same tick as the replay: no event falls between the two
    hb = setInterval(() => write(": ping\n\n"), heartbeatMs); hb.unref();
    age = setTimeout(end, maxAgeMs); age.unref();
  }

  return { recent, stream, openStreams: () => open };
}
