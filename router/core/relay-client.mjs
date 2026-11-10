// Seller side of the relay: keeps one outbound long poll to a relay, runs each job it receives against this node's OWN /p2p handler
// (only the three peer endpoints, nothing else, whatever the relay asks) and streams the answer back. See router/http/relay.mjs.
import crypto from "node:crypto";
import { RELAY_PATHS } from "../http/relay.mjs";

const PASS = ["content-type", "cache-control", "x-elyra-protocol"];
const rnd = () => crypto.randomBytes(8).toString("hex");

export function startRelayClient({ relayUrl, identity, port, log = () => {}, maxJobs = 8, fetchImpl = fetch }) {
  const base = relayUrl.replace(/\/$/, "");
  const st = { relay: base, connected: false, lastOkAt: 0, jobs: 0, error: "" };
  let running = true, inflight = 0, ctl = new AbortController(), resolveReady;
  const ready = new Promise((r) => { const t = setTimeout(r, 3000); t.unref?.(); resolveReady = () => { clearTimeout(t); r(); }; });
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); ctl.signal.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });

  async function reply(jobId, status, headers, bodyIter) {
    const ts = Date.now(), nonce = rnd();
    const head = Buffer.from(JSON.stringify({ status, headers }) + "\n");
    async function* body() { yield head; if (bodyIter) for await (const c of bodyIter) yield c; }
    return fetchImpl(`${base}/relay/reply?job=${encodeURIComponent(jobId)}`, {
      method: "POST", duplex: "half", body: ReadableStream.from(body()),
      headers: { "x-relay-pub": identity.pub, "x-relay-ts": String(ts), "x-relay-nonce": nonce, "x-relay-sig": identity.sign({ t: "relay-reply", job: jobId, ts, nonce }), "content-type": "application/octet-stream" },
      signal: AbortSignal.timeout(300_000),
    });
  }

  async function run(job) {
    inflight++; st.jobs++;
    const abort = new AbortController();
    try {
      const spec = RELAY_PATHS[job.path];
      if (typeof job.path !== "string" || !spec || !spec.methods.includes(job.method)) { await reply(job.job, 404, { "content-type": "application/json" }, [Buffer.from('{"error":{"message":"no such p2p endpoint"}}')]); return; }
      let local;
      try {
        local = await fetch(`http://127.0.0.1:${port}${job.path}`, { method: job.method, headers: { "content-type": String(job.ctype || "application/json") }, body: job.method === "GET" ? undefined : Buffer.from(String(job.body ?? ""), "base64"), signal: abort.signal });
      } catch { await reply(job.job, 502, { "content-type": "application/json" }, [Buffer.from('{"error":{"message":"seller node unavailable"}}')]); return; }
      const headers = {}; for (const k of PASS) { const v = local.headers.get(k); if (v) headers[k] = v; }
      const r = await reply(job.job, local.status, headers, local.body);
      if (r.status === 410) abort.abort(); // the buyer left: stop the local work too
    } catch (e) { abort.abort(); log("warn", "relay job failed", { reason: e.message }); }
    finally { inflight--; }
  }

  (async function loop() {
    let fails = 0, first = true;
    while (running) {
      if (inflight >= maxJobs) { await sleep(200); continue; }
      try {
        const ts = Date.now(), nonce = rnd(), id = identity.id;
        const r = await fetchImpl(`${base}/relay/wait`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pub: identity.pub, ts, nonce, quick: first, sig: identity.sign({ t: "relay-wait", id, ts, nonce }) }), signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(40_000)]) });
        first = false;
        if (r.status === 204) { st.connected = true; st.lastOkAt = Date.now(); st.error = ""; fails = 0; resolveReady(); continue; }
        if (r.status === 200) { st.connected = true; st.lastOkAt = Date.now(); st.error = ""; fails = 0; resolveReady(); run(await r.json()).catch(() => {}); continue; }
        throw new Error(r.status === 404 ? "that address does not run a relay (ELYRA_RELAY=1)" : `relay answered ${r.status}`);
      } catch (e) {
        resolveReady();
        if (!running) break;
        if (st.connected || !st.error) log("warn", "relay unreachable", { relay: base, reason: e.message });
        st.connected = false; st.error = e.message; fails++; first = true;
        await sleep(Math.min(30_000, 1000 * 2 ** Math.min(fails, 5)));
      }
    }
  })();

  return { status: () => ({ ...st }), ready, stop: () => { running = false; ctl.abort(); resolveReady(); } };
}
