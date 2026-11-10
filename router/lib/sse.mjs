// Server-sent-event stream helpers (parsing and re-framing only; no keys, no node state).

/** Split an SSE byte stream into complete events: {event, data}. */
export async function* sseEvents(body) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = "message";
      const data = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      yield { event, data: data.join("\n"), raw };
    }
  }
}

/** Regroup an async stream of arbitrary string/Buffer chunks into whole SSE events ("…\n\n"); drops the [DONE] sentinel. */
export async function* wholeEvents(frames) {
  let buf = "";
  for await (const f of frames) {
    buf += typeof f === "string" ? f : Buffer.from(f).toString("utf8");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const ev = buf.slice(0, i + 2);
      buf = buf.slice(i + 2);
      if (!ev.includes("[DONE]")) yield ev;
    }
  }
  if (buf.trim() && !buf.includes("[DONE]")) yield buf;
}

/** The completion text carried by one raw OpenAI-style SSE event. */
export const textOfFrame = (raw) => {
  let t = "";
  for (const ln of raw.split("\n")) {
    if (!ln.startsWith("data:") || ln.includes("[DONE]")) continue;
    try { t += JSON.parse(ln.slice(5)).choices?.[0]?.delta?.content ?? ""; } catch { /* partial */ }
  }
  return t;
};
