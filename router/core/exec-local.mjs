// Execution of a candidate that does not leave this machine's trust boundary: simulated catalog peers and the demo
// engine (demo.mjs), or an OpenAI-compatible upstream via fetch passthrough with usage sniffing.
// Returns { json } | { frames: AsyncIterable<string|Uint8Array> } plus `usage: Promise<{p,c}>`. No peer protocol here.
import { approxTokens } from "../policy.mjs";
import { demoCompletion, demoStream } from "../demo.mjs";
import { promptEstimate } from "./limits.mjs";

export function createLocalExec({ upstreamById }) {
  async function execOpenAI(up, model, body, ctl) {
    if (!up) throw new Error("upstream removed");
    const headers = { "content-type": "application/json" };
    if (up.apiKey) headers.authorization = `Bearer ${up.apiKey}`;
    const r = await fetch(up.baseUrl.replace(/\/$/, "") + "/chat/completions", {
      method: "POST", headers, body: JSON.stringify({ ...body, model }), signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`upstream ${up.name}: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const promptEst = promptEstimate(body);
    if (!body.stream) {
      const j = await r.json();
      const text = j.choices?.[0]?.message?.content ?? "";
      return { json: j, usage: Promise.resolve({ p: j.usage?.prompt_tokens ?? promptEst, c: j.usage?.completion_tokens ?? approxTokens(text) }) };
    }
    let resolveUsage;
    const usage = new Promise((res) => (resolveUsage = res));
    async function* frames() {
      let text = "", u = null, tail = "";
      try {
        for await (const chunk of r.body) {
          yield chunk;
          tail += Buffer.from(chunk).toString("utf8");
          const lines = tail.split("\n");
          tail = lines.pop();
          for (const ln of lines) {
            if (!ln.startsWith("data:") || ln.includes("[DONE]")) continue;
            try {
              const j = JSON.parse(ln.slice(5));
              text += j.choices?.[0]?.delta?.content ?? "";
              if (j.usage) u = j.usage;
            } catch { /* partial or non-JSON line */ }
          }
        }
      } finally {
        resolveUsage({ p: u?.prompt_tokens ?? promptEst, c: u?.completion_tokens ?? approxTokens(text) });
      }
    }
    return { frames: frames(), usage };
  }

  /** `c` is a "sim" or "self" candidate. */
  return async function execLocal(c, body, ctl) {
    const stream = !!body.stream;
    if (c.kind === "sim" || upstreamById(c.sourceId)?.kind === "demo") {
      const via = c.kind === "sim" ? c.peerName : "demo-engine";
      const d = demoCompletion({ model: c.model, messages: body.messages, via });
      const usage = Promise.resolve({ p: d.promptTokens, c: d.completionTokens });
      if (!stream) return { json: d.json, usage };
      return { frames: demoStream({ model: c.model, messages: body.messages, via, tps: c.tps }), usage };
    }
    return execOpenAI(upstreamById(c.sourceId), c.model, body, ctl);
  };
}
