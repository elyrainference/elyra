// Built-in demo engine: answers without any model. Used by simulated peers and the
// always-present "demo-engine" upstream so the whole path (route → peer → receipt → ledger)
// works on a fresh install. It says plainly that it is a demo.
import { approxTokens } from "./policy.mjs";

const lastUser = (messages) => {
  const m = [...(messages ?? [])].reverse().find((x) => x.role === "user");
  if (!m) return "";
  return typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join(" ");
};

export function demoReply({ model, messages, via }) {
  const q = lastUser(messages).trim().replace(/\s+/g, " ");
  const quote = q.length > 160 ? q.slice(0, 157) + "…" : q;
  return (
    `[elyra demo engine · ${model}${via ? " via " + via : ""}] ` +
    `Your request travelled the full Elyra path: local VPR → policy ranking → peer → signed receipt → ledger. ` +
    `This peer has no real model attached, so it answers with a stub. ` +
    (quote ? `You asked: "${quote}". ` : "") +
    `To get real completions, add an OpenAI-compatible upstream (Ollama, LM Studio, any API) under Connect.`
  );
}

const tokenize = (text) => text.match(/\S+\s*/g) ?? [];

export function demoCompletion({ model, messages, via }) {
  const text = demoReply({ model, messages, via });
  const promptTokens = approxTokens((messages ?? []).map((m) => (typeof m.content === "string" ? m.content : "")).join(" "));
  const completionTokens = approxTokens(text);
  return {
    text,
    promptTokens,
    completionTokens,
    json: {
      id: "chatcmpl-" + Math.random().toString(36).slice(2, 12),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    },
  };
}

/** Async iterator of OpenAI SSE frames (strings). `tps` paces output; capped so demos stay snappy. */
export async function* demoStream({ model, messages, via, tps = 120 }) {
  const { text } = demoCompletion({ model, messages, via });
  const id = "chatcmpl-" + Math.random().toString(36).slice(2, 12);
  const created = Math.floor(Date.now() / 1000);
  const frame = (delta, finish = null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  yield frame({ role: "assistant", content: "" });
  const delay = Math.min(60, Math.max(6, 1000 / tps));
  for (const tok of tokenize(text)) {
    await new Promise((r) => setTimeout(r, delay));
    yield frame({ content: tok });
  }
  yield frame({}, "stop");
  yield "data: [DONE]\n\n";
}
