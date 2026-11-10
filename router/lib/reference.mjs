// Reference prices: what a model of the SAME family, version and size lists for on OpenRouter, shown next to our sellers' prices for context.
// Pure helpers (no network): the public page fetches the public model list and passes it here. A match must be exact; when in doubt there is
// no reference, never a similar-looking model (a 7B coder is not the 32B coder, a distilled R1 is not R1).
const SUFFIX = /-(instruct|chat|it)$/;
const QUANT = /^(q\d.*|fp16|f16|fp8|bf16|latest)$/;

/** "qwen2.5-coder:7b" -> { family: "qwen", version: "2.5", variant: "coder", size: "7" }, or null when it is not a plain family/version/size name */
export function parseModel(name) {
  const [base, tag = ""] = String(name).toLowerCase().split(":");
  const m = /^([a-z]+)(\d+(?:\.\d+)?)?(?:-(coder))?$/.exec(base);
  const toks = tag.split("-"), size = /^(\d+(?:\.\d+)?)b$/.exec(toks[0] ?? "");
  if (!m || !size) return null;
  if (!toks.slice(1).every((t) => ["instruct", "chat", "it"].includes(t) || QUANT.test(t))) return null; // distill, vision, moe... are different models
  return { family: m[1], version: m[2] ?? "", variant: m[3] ?? "", size: size[1] };
}

/** Index OpenRouter's /models data by normalised name segment. Free/extended variants (":free") and unpriced entries are left out. */
export function buildIndex(data) {
  const idx = new Map();
  for (const m of Array.isArray(data) ? data : []) {
    const id = typeof m?.id === "string" ? m.id : ""; if (!id.includes("/") || id.includes(":")) continue;
    const inM = Number(m.pricing?.prompt) * 1e6, outM = Number(m.pricing?.completion) * 1e6;
    if (!Number.isFinite(inM) || !Number.isFinite(outM) || inM < 0 || outM < 0 || (inM === 0 && outM === 0)) continue;
    const key = id.split("/")[1].toLowerCase().replace(SUFFIX, "");
    (idx.get(key) ?? idx.set(key, []).get(key)).push({ id, inM, outM });
  }
  return idx;
}

/** { source, id, inPerM, outPerM } for an exact family/version/size match, else null. Several vendors with the same name: the cheapest is shown with its id. */
export function lookup(idx, model) {
  const p = parseModel(model); if (!p || !idx) return null;
  const mid = (p.variant ? "-" + p.variant : ""), v = p.version;
  const keys = new Set([`${p.family}-${v}${mid}-${p.size}b`, `${p.family}${v}${mid}-${p.size}b`, ...(v ? [] : [`${p.family}${mid}-${p.size}b`])]);
  const hits = [...keys].flatMap((k) => idx.get(k) ?? []);
  if (!hits.length) return null;
  const best = hits.slice().sort((a, b) => a.inM + a.outM - (b.inM + b.outM) || a.id.localeCompare(b.id))[0];
  return { source: "OpenRouter", id: best.id, inPerM: +best.inM.toFixed(4), outPerM: +best.outM.toFixed(4) };
}
