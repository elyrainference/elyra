// Upstream registry: the built-in demo engine plus operator-added OpenAI-compatible backends (Ollama, vLLM, hosted APIs).
// Owns add/detect/refresh and model discovery. Must not execute inference (see exec-local.mjs).
import { fetchJson } from "../lib/fetch-json.mjs";
import { HttpError } from "../lib/errors.mjs";
import { rid } from "../lib/canon.mjs";
import { isLocalUrl, normUrl } from "../lib/url.mjs";
import { DEMO_UPSTREAM } from "./limits.mjs";
import { nullEvents } from "./events.mjs";

/** Blended list price in USD per million tokens (input and output averaged) from a source's `pricing` object, or null when it does not give a usable one.
 *  A negative or non-numeric entry (OpenRouter marks variable-priced routers with -1) is "unknown", never a price; zero is valid (free models). */
export function listPrice(pricing) {
  const a = pricing?.prompt, b = pricing?.completion;
  if (a == null || b == null || a === "" || b === "") return null;
  const p = Number(a), c = Number(b);
  if (!Number.isFinite(p) || !Number.isFinite(c) || p < 0 || c < 0) return null;
  return +(((p + c) / 2) * 1e6).toFixed(6);
}

export function createUpstreams({ state, save, teeMode, every, events = nullEvents }) {
  const upstreams = () => [DEMO_UPSTREAM, ...state.upstreams];
  const upstreamById = (id) => upstreams().find((u) => u.id === id);

  // Health is in memory only (never saved): an upstream that stops answering (a dropped SSH tunnel, a stopped Ollama, a
  // rented GPU that was shut down) must stop being offered, otherwise visitors see "live" and then fail. Two failed probes in a
  // row mark it down, one success brings it back. Only "no answer" and 5xx count: a 401/404 on /models still proves a server is there.
  const health = new Map(); // id -> { ok, fails, at, ms, error }
  async function probe(up) {
    if (!up || up.kind === "demo") return;
    const t0 = Date.now(), prev = health.get(up.id);
    let error = null;
    try {
      const r = await fetch(up.baseUrl.replace(/\/$/, "") + "/models", { headers: up.apiKey ? { authorization: `Bearer ${up.apiKey}` } : {}, signal: AbortSignal.timeout(4000) });
      await r.body?.cancel().catch(() => {});
      if (r.status >= 500) error = `HTTP ${r.status}`;
    } catch (e) { error = e?.name === "TimeoutError" ? "no answer within 4 s" : String(e?.cause?.code ?? e?.message ?? e).slice(0, 80); }
    const fails = error ? (prev?.fails ?? 0) + 1 : 0;
    // a source never seen alive is down on its first failed probe (there is no earlier good state to protect from flapping)
    const ok = error ? (prev ? fails < 2 : false) : true;
    health.set(up.id, { ok, fails, at: Date.now(), ms: Date.now() - t0, error });
    if (!ok && prev?.ok !== false) events.alert({ code: "upstream_down", subject: up.name }); // on the transition only
  }
  const probeAll = () => Promise.all(state.upstreams.map(probe));
  /** unknown counts as up: a fresh node must not hide a source before its first probe */
  const upstreamUp = (id) => health.get(id)?.ok !== false;
  const upstreamHealth = (id) => { const h = health.get(id); return h ? { status: h.ok ? "up" : "down", checkedAt: h.at, ms: h.ms, error: h.ok ? null : h.error } : { status: "unknown" }; };
  if (every) { every(15_000, probeAll); setTimeout(probeAll, 500).unref(); }

  /** model ids, plus per-model list prices when the source publishes them (OpenRouter style: pricing.prompt / pricing.completion, USD per token) */
  async function discover(baseUrl, apiKey) {
    const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const j = await fetchJson(baseUrl.replace(/\/$/, "") + "/models", { headers }, 4000, 8_000_000);
    const rows = j.data ?? j.models ?? [], ids = [], prices = {};
    for (const m of rows) {
      const id = m.id ?? m.name; if (!id) continue; ids.push(id);
      const p = listPrice(m.pricing); if (p != null) prices[id] = p;
    }
    return { ids, prices };
  }
  const discoverModels = async (baseUrl, apiKey) => (await discover(baseUrl, apiKey)).ids;

  async function addUpstream({ name, baseUrl, apiKey = "", models, price = 0, remote = false }) {
    if (!name || !baseUrl) throw new HttpError(400, "name and baseUrl required");
    normUrl(baseUrl);
    if (teeMode && (remote || !isLocalUrl(baseUrl))) throw new HttpError(400, "TEE mode: only local upstreams are allowed — the model has to run inside the attested workload, otherwise the privacy claim would be false");
    let list = Array.isArray(models) && models.length ? models : null, modelPrices = {};
    if (!list) {
      try { ({ ids: list, prices: modelPrices } = await discover(baseUrl, apiKey)); }
      catch (e) { throw new HttpError(400, `could not list models at ${baseUrl}/models (${e.message}); pass models manually`); }
    }
    if (!list.length) throw new HttpError(400, "upstream reported no models");
    const up = { id: rid("up"), name, kind: "openai", baseUrl: baseUrl.replace(/\/$/, ""), apiKey, price: Math.max(0, Number(price) || 0), models: list, ...(Object.keys(modelPrices).length ? { modelPrices } : {}), remote: remote === true }; // remote: a loopback/LAN URL that is really another machine (SSH tunnel, VPN): prompts leave this box, so it is never labelled private
    state.upstreams.push(up);
    if (state.provide?.upstreamId === "demo-engine" && !(state.provide?.upstreamIds?.length > 0) && isLocalUrl(up.baseUrl)) state.provide.upstreamId = up.id;
    save();
    probe(up);
    return up;
  }

  async function detectLocal() {
    const probes = [["Ollama", "http://localhost:11434/v1"], ["LM Studio", "http://localhost:1234/v1"], ["llama.cpp / vLLM", "http://localhost:8000/v1"], ["llama-server", "http://localhost:8080/v1"]];
    const found = await Promise.all(probes.map(async ([name, baseUrl]) => {
      try {
        const models = await discoverModels(baseUrl, "");
        return { name, baseUrl, models, added: state.upstreams.some((u) => u.baseUrl === baseUrl) };
      } catch { return null; }
    }));
    return found.filter(Boolean);
  }

  async function refreshUpstream(id) {
    const up = state.upstreams.find((u) => u.id === id);
    if (!up) throw new HttpError(404, "no such upstream");
    const found = await discover(up.baseUrl, up.apiKey);
    up.models = found.ids; if (Object.keys(found.prices).length) up.modelPrices = found.prices; else delete up.modelPrices;
    save();
    await probe(up);
    return up;
  }

  return { upstreams, upstreamById, addUpstream, detectLocal, refreshUpstream, upstreamUp, upstreamHealth, probeAll };
}
