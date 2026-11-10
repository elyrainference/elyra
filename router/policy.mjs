// Routing policy: filter + score candidates, plus the money/token helpers every module shares (usd, cost, approxTokens).
// Pure functions: no I/O, no node state.

export const DEFAULT_POLICY = {
  weights: { price: 40, speed: 30, reputation: 20, privacy: 10 },
  teeOnly: false,
  maxPrice: null, // $/MTok ceiling, null = none
};

// "auto:*" shorthands override weights for a single request.
const ALIASES = {
  auto: {},
  "auto:cheapest": { weights: { price: 100, speed: 0, reputation: 0, privacy: 0 } },
  "auto:fastest": { weights: { price: 0, speed: 100, reputation: 0, privacy: 0 } },
  "auto:best": { weights: { price: 5, speed: 15, reputation: 80, privacy: 0 } },
  "auto:private": { weights: { price: 10, speed: 10, reputation: 20, privacy: 60 }, teeOnly: true },
};

export function isAuto(model) {
  return typeof model === "string" && model in ALIASES;
}

export function matchModel(candidate, model) {
  if (isAuto(model)) return true;
  const want = String(model).toLowerCase();
  const have = candidate.model.toLowerCase();
  return have === want || have === want.split("/").pop();
}

const span = (vals) => {
  let min = Infinity, max = -Infinity;
  for (const v of vals) { if (v < min) min = v; if (v > max) max = v; }
  return [min, max];
};
const scale = (v, min, max, invert) => (max === min ? 1 : invert ? (max - v) / (max - min) : (v - min) / (max - min));

/** Rank candidates for `model` under `policy`. Returns new array sorted best-first, each with `score` + `parts`. */
export function rank(cands, policy, model = "auto") {
  const alias = ALIASES[model] ?? {};
  const teeOnly = alias.teeOnly ?? policy.teeOnly;
  const w = alias.weights ?? policy.weights;
  const tot = w.price + w.speed + w.reputation + w.privacy || 1;

  const list = cands.filter(
    (c) => matchModel(c, model) && (!teeOnly || c.private) && (policy.maxPrice == null || c.price <= policy.maxPrice),
  );
  if (!list.length) return [];
  const [pMin, pMax] = span(list.map((c) => c.price));
  const [sMin, sMax] = span(list.map((c) => c.tps));
  return list
    .map((c) => {
      const parts = {
        price: scale(c.price, pMin, pMax, true),
        speed: scale(c.tps, sMin, sMax, false),
        reputation: c.reputation / 5,
        privacy: c.privacyScore,
      };
      const score = (w.price * parts.price + w.speed * parts.speed + w.reputation * parts.reputation + w.privacy * parts.privacy) / tot;
      return { ...c, score: +score.toFixed(4), parts };
    })
    .sort((a, b) => b.score - a.score || a.price - b.price);
}

export function normaliseWeights(w) {
  const out = {};
  for (const k of ["price", "speed", "reputation", "privacy"]) {
    const n = Number(w?.[k]);
    out[k] = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : DEFAULT_POLICY.weights[k];
  }
  return out;
}

export const approxTokens = (text) => Math.max(1, Math.ceil(String(text ?? "").length / 4));

export const usd = (n) => +n.toFixed(8);
export const cost = (price, promptTokens, completionTokens) => usd((price * (promptTokens + completionTokens)) / 1e6);
