// Outgoing JSON GET/POST with a hard timeout and a hard size cap. Used for peer hellos and upstream model discovery.
// The cap matters: a peer chooses what it sends back, and r.json() would buffer all of it.
export async function fetchJson(url, opts = {}, timeout = 4000, maxBytes = 1_000_000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const declared = Number(r.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) { ctl.abort(); throw new Error(`response too large (${declared} bytes, limit ${maxBytes})`); }
    const chunks = []; let size = 0;
    for await (const c of r.body) {
      size += c.length;
      if (size > maxBytes) { ctl.abort(); throw new Error(`response too large (over ${maxBytes} bytes)`); }
      chunks.push(c);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { clearTimeout(timer); }
}
