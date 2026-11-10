// Simulated ("demo") peer network. Gives the router a realistic market to route over
// before real peers exist. Every listing is flagged `simulated: true` end to end —
// UI and API never present it as live capacity. Replace by real peers via /p2p gossip.

// vendor key = logo file in panel/assets/logos/<logo>.svg
const VENDORS = {
  openai:    { logo: "openai",    name: "OpenAI",    kind: "bridge" },
  anthropic: { logo: "anthropic", name: "Anthropic", kind: "bridge" },
  google:    { logo: "gemini",    name: "Google",    kind: "bridge" },
  xai:       { logo: "xai",       name: "xAI",       kind: "bridge" },
  amazon:    { logo: "aws",       name: "Amazon",    kind: "bridge" },
  deepseek:  { logo: "deepseek",  name: "DeepSeek",  kind: "community" },
  qwen:      { logo: "qwen",      name: "Qwen",      kind: "community" },
  meta:      { logo: "meta",      name: "Meta",      kind: "community" },
  mistral:   { logo: "mistral",   name: "Mistral",   kind: "community" },
  gemma:     { logo: "gemma",     name: "Gemma",     kind: "community" },
  moonshot:  { logo: "kimi",      name: "Moonshot",  kind: "community" },
  zhipu:     { logo: "zhipu",     name: "Zhipu",     kind: "community" },
  yi:        { logo: "yi",        name: "01.AI",     kind: "community" },
  microsoft: { logo: "microsoft", name: "Microsoft", kind: "community" },
  nvidia:    { logo: "nvidia",    name: "NVIDIA",    kind: "community" },
  minimax:   { logo: "minimax",   name: "MiniMax",   kind: "community" },
  cohere:    { logo: "cohere",    name: "Cohere",    kind: "community" },
};

// [vendor, model, $/MTok base, tokens/s base, reputation base, ctx]
const MODELS = [
  ["openai", "gpt-5.2", 4.5, 120, 5.0, 400],
  ["openai", "gpt-5.2-mini", 0.6, 142, 5.0, 400],
  ["openai", "gpt-oss-120b", 0.2, 140, 4.6, 128],
  ["anthropic", "claude-opus-4.6", 12.5, 74, 5.0, 200],
  ["anthropic", "claude-sonnet-4.6", 3.0, 96, 5.0, 1000],
  ["anthropic", "claude-haiku-4.5", 0.8, 160, 4.9, 200],
  ["google", "gemini-3-pro", 3.5, 110, 4.9, 1000],
  ["google", "gemini-3-flash", 0.35, 190, 4.8, 1000],
  ["xai", "grok-4-fast", 0.55, 128, 4.5, 256],
  ["amazon", "nova-pro-2", 0.8, 95, 4.6, 300],
  ["deepseek", "deepseek-v3.2", 0.14, 96, 4.9, 128],
  ["deepseek", "deepseek-r2", 0.38, 70, 4.8, 128],
  ["qwen", "qwen3-coder-480b", 0.09, 120, 4.7, 256],
  ["qwen", "qwen3-235b-a22b", 0.12, 105, 4.7, 128],
  ["qwen", "qwen3-32b", 0.11, 130, 4.6, 128],
  ["meta", "llama-4-405b", 0.22, 88, 4.8, 128],
  ["meta", "llama-4-70b", 0.18, 110, 4.7, 128],
  ["meta", "llama-4-scout", 0.08, 160, 4.5, 1000],
  ["mistral", "mistral-large-3", 0.31, 85, 4.5, 128],
  ["mistral", "mistral-small-3.2", 0.06, 170, 4.4, 128],
  ["mistral", "codestral-2", 0.15, 150, 4.5, 256],
  ["gemma", "gemma-3-27b", 0.07, 150, 4.4, 128],
  ["moonshot", "kimi-k3", 0.19, 92, 4.6, 256],
  ["zhipu", "glm-4.6", 0.13, 100, 4.6, 200],
  ["yi", "yi-3-large", 0.16, 99, 4.4, 128],
  ["microsoft", "phi-5-mini", 0.05, 180, 4.3, 128],
  ["nvidia", "nemotron-ultra", 0.24, 90, 4.5, 128],
  ["minimax", "minimax-m2", 0.1, 118, 4.5, 256],
  ["cohere", "command-a", 0.28, 100, 4.4, 256],
];

// small deterministic PRNG so the catalog is stable across restarts
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export function buildCatalog() {
  const rand = rng(0x501a15);
  const peers = [];
  const listings = [];
  for (const [vendor, model, price, tps, rep, ctx] of MODELS) {
    const v = VENDORS[vendor];
    const n = v.kind === "bridge" ? 1 + Math.floor(rand() * 2) : 2 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      const num = 100 + Math.floor(rand() * 9800);
      const id = v.kind === "bridge" ? `sim-bridge-${vendor}-${i}` : `sim-${num}`;
      let peer = peers.find((p) => p.id === id);
      if (!peer) {
        peer = {
          id,
          simulated: true,
          kind: v.kind,
          name: v.kind === "bridge" ? `bridge · ${vendor}` : `community · #${num}`,
          region: ["eu-west", "us-east", "us-west", "ap-southeast", "ap-northeast", "sa-east"][Math.floor(rand() * 6)],
        };
        peers.push(peer);
      }
      const tee = v.kind === "bridge" ? rand() < 0.5 : rand() < 0.35;
      listings.push({
        peerId: id,
        model,
        vendor,
        logo: v.logo,
        vendorName: v.name,
        price: +(price * (0.85 + rand() * 0.4)).toFixed(3),
        tps: Math.round(tps * (0.75 + rand() * 0.5)),
        reputation: +Math.min(5, rep - 0.3 + rand() * 0.4).toFixed(1),
        ctx,
        tee: tee ? "demo" : "none",
      });
    }
  }
  return { peers, listings, vendors: VENDORS };
}

export const VENDOR_LOGOS = Object.fromEntries(Object.entries(VENDORS).map(([k, v]) => [k, v.logo]));

// vendor lookup for models served by real upstreams (Ollama etc.): match by name fragment
export function guessLogo(modelId) {
  const m = modelId.toLowerCase();
  const table = [
    ["gpt", "openai"], ["o1", "openai"], ["o3", "openai"], ["claude", "anthropic"], ["gemini", "gemini"], ["gemma", "gemma"],
    ["llama", "meta"], ["mistral", "mistral"], ["mixtral", "mistral"], ["codestral", "mistral"], ["qwen", "qwen"],
    ["deepseek", "deepseek"], ["grok", "xai"], ["kimi", "kimi"], ["glm", "zhipu"], ["yi-", "yi"], ["phi", "microsoft"],
    ["nemotron", "nvidia"], ["minimax", "minimax"], ["command", "cohere"], ["nova", "aws"], ["hermes", "nousresearch"],
  ];
  for (const [frag, logo] of table) if (m.includes(frag)) return logo;
  return null;
}
