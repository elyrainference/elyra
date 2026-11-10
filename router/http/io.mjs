// Request/response plumbing: JSON bodies in, JSON or error envelopes out, and the sink adapter that lets
// node.chat/serve write through a ServerResponse. No routing and no access policy here.
import { HttpError } from "../lib/errors.mjs";
import { log } from "../obs.mjs";

export async function readJson(req, limit = 1_000_000) {
  let size = 0;
  const chunks = [];
  try {
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new HttpError(413, "body too large");
      chunks.push(c);
    }
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "request aborted");
  }
  if (!size) return {};
  let v;
  try { v = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "invalid JSON"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "JSON body must be an object");
  return v;
}

export const send = (res, status, obj, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(obj));
};

export const sendErr = (res, e) => {
  const status = e.status ?? 500;
  if (status >= 500 && !(e instanceof HttpError)) log("error", "unhandled error", { message: e.message, stack: String(e.stack).split("\n").slice(0, 4).join(" | ") });
  if (res.headersSent) return res.end();
  send(res, status, { error: { message: e.message, type: e.type ?? "internal_error" } });
};

/** Adapter: node.chat/serve write through this to a ServerResponse. */
export const sink = (res) => ({
  head: (s, h) => res.writeHead(s, h),
  json: (o) => res.end(JSON.stringify(o)),
  write: (c) => res.write(c),
  end: () => res.end(),
});

/** AbortController that fires when the client hangs up before the response finished. */
export function abortOnClose(res) {
  const ctl = new AbortController();
  res.on("close", () => { if (!res.writableEnded) ctl.abort(); });
  return ctl;
}
