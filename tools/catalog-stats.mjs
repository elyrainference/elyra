#!/usr/bin/env node
// Catalog measurement tool: counts unique models, unique vendors, and hosted vs peer vs self-hosted capacity
// from a node's configured state (--data), a running node (--node), local JSON fixtures (--file), or live /models URLs (--url / --openrouter).
// Zero external dependencies; safe to import in tests or run from the CLI.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalUrl } from "../router/lib/url.mjs";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export const DEDUPE_RULES = Object.freeze([
  {
    id: "R1_NO_SIMULATED",
    title: "Exclude simulated demo listings and offline sources",
    summary: "Built-in demo peers (simulated: true / kind: demo) and unreachable/offline sources are excluded from live supply counts and reported separately.",
  },
  {
    id: "R2_NO_META_ROUTERS_OR_MOVING_ALIASES",
    title: "Exclude meta-routers and moving '~' aliases",
    summary: "Aggregator auto-routers (openrouter/*, router/auto, or entries with negative/variable pricing like typesafe/jev-router and nvidia/switchyard) and moving alias pointers (~vendor/*-latest) route to other models rather than being distinct weights.",
  },
  {
    id: "R3_COLLAPSE_BILLING_TIERS_KEEP_SIZES",
    title: "Collapse billing/throughput tiers (:free, :batch, :extended) but keep parameter sizes (:1b, :8b, :70b)",
    summary: "On vendor/model:tier IDs, suffixes like :free, :batch, :extended, :nitro, :floor, :online, :thinking and :latest are billing or routing tiers for the same weights and are collapsed. On Ollama/local family:sizeb IDs, the parameter size (1b vs 8b vs 70b) is kept while quantisation tags (-q4_K_M, -fp16, -bf16) are stripped.",
  },
  {
    id: "R4_CANONICAL_MODEL_KEY",
    title: "Canonicalize instruct/chat suffixes, cross-source open-weights names, and redundant date pins",
    summary: "Trailing -instruct, -chat and -it tags are stripped; plain open-weights names (e.g. Ollama llama3.2:1b-instruct-q4_K_M and OpenRouter meta-llama/llama-3.2-1b-instruct) map to the same canonical vendor/family-version-sizeb key while keeping distills (deepseek-r1:8b) and fine-tunes separate; date-pinned snapshots (e.g. gpt-4o-2024-11-20) collapse into their undated base model when that base model is also listed.",
  },
  {
    id: "R5_CANONICAL_VENDOR",
    title: "Normalize vendor prefixes and infer makers for unslashed local models",
    summary: "Leading '~' markers are stripped and multi-prefix organisations (meta + meta-llama, bytedance + bytedance-seed, mistralai + mistral, x-ai + xai, moonshotai + moonshot, z-ai + zhipu) are merged into one canonical vendor; unslashed local model names infer their maker from the family prefix.",
  },
  {
    id: "R6_HOSTED_VS_PEER_SEPARATION",
    title: "Separate P2P peers, own local/remote servers, and third-party hosted APIs",
    summary: "Models from a third-party hosted API (OpenRouter, OpenAI, etc.) are counted under 'hosted' and never merged into peer-to-peer supply.",
  },
]);

const TIER_TAGS = new Set(["free", "batch", "extended", "nitro", "floor", "online", "thinking", "exacto", "latest"]);
const CHAT_SUFFIX_RE = /-(instruct|chat|it)$/;
const QUANT_TOKEN_RE = /^(q\d.*|fp16|f16|fp8|bf16|int8|int4|awq|gptq|gguf|latest)$/;
const DATE_PIN_RE = /-(20\d\d-\d\d-\d\d|\d\d-20\d\d|20\d{6}|\d{4})$/;

const VENDOR_ALIASES = Object.freeze({
  "meta-llama": "meta",
  "bytedance-seed": "bytedance",
  "mistralai": "mistral",
  "x-ai": "xai",
  "moonshotai": "moonshot",
  "z-ai": "zhipu",
  "01-ai": "yi",
  "ibm-granite": "ibm",
});

const FAMILY_VENDOR = Object.freeze({
  llama: "meta",
  codellama: "meta",
  qwen: "qwen",
  qwq: "qwen",
  gemma: "google",
  gemini: "google",
  mistral: "mistral",
  ministral: "mistral",
  mixtral: "mistral",
  codestral: "mistral",
  devstral: "mistral",
  pixtral: "mistral",
  voxtral: "mistral",
  deepseek: "deepseek",
  gpt: "openai",
  o1: "openai",
  o3: "openai",
  o4: "openai",
  claude: "anthropic",
  grok: "xai",
  kimi: "moonshot",
  glm: "zhipu",
  yi: "yi",
  phi: "microsoft",
  nemotron: "nvidia",
  minimax: "minimax",
  command: "cohere",
  aya: "cohere",
  nova: "amazon",
  hermes: "nousresearch",
  lfm: "liquid",
  granite: "ibm",
});

const OPEN_WEIGHT_FAMILIES = new Set(["llama", "qwen", "gemma", "mistral", "mixtral", "codestral", "phi", "glm", "yi", "nemotron", "hermes"]);

/** True when an entry is a routing meta-endpoint (e.g. openrouter/auto, openrouter/free, or negative-priced routers) rather than a model. */
export function isMetaRouter(entry) {
  const raw = typeof entry === "string" ? entry : entry?.id ?? entry?.name ?? "";
  const id = String(raw).trim().toLowerCase();
  if (!id) return true;
  if (id.startsWith("openrouter/")) return true;
  const slug = id.includes("/") ? id.split("/").slice(1).join("/").split(":")[0] : id.split(":")[0];
  if (slug === "auto" || slug.startsWith("auto-")) return true;
  if (entry && typeof entry === "object" && entry.pricing && typeof entry.pricing === "object") {
    const p = entry.pricing.prompt, c = entry.pricing.completion;
    const pn = p != null && p !== "" ? Number(p) : 0;
    const cn = c != null && c !== "" ? Number(c) : 0;
    if ((Number.isFinite(pn) && pn < 0) || (Number.isFinite(cn) && cn < 0)) return true;
  }
  return false;
}

/** True when an entry is an OpenRouter-style '~vendor/*-latest' moving alias pointer. */
export function isMovingAlias(entry) {
  const raw = typeof entry === "string" ? entry : entry?.id ?? entry?.name ?? "";
  return String(raw).trim().startsWith("~");
}

/** Normalize a vendor prefix or infer the vendor from an unslashed model ID. */
export function normalizeVendor(rawVendorOrModelId) {
  const s = String(rawVendorOrModelId ?? "").trim().toLowerCase();
  if (!s) return "unknown";
  if (s.includes("/")) {
    const rawPrefix = s.split("/")[0].replace(/^~+/, "").trim();
    if (!rawPrefix) return "unknown";
    return VENDOR_ALIASES[rawPrefix] ?? rawPrefix;
  }
  const clean = s.replace(/^~+/, "");
  if (VENDOR_ALIASES[clean]) return VENDOR_ALIASES[clean];
  const base = clean.split(":")[0];
  for (const [prefix, vendor] of Object.entries(FAMILY_VENDOR)) {
    if (base === prefix || base.startsWith(prefix + "-") || base.startsWith(prefix + ".") || new RegExp(`^${prefix}\\d`).test(base)) {
      return vendor;
    }
  }
  return clean;
}

/**
 * Strip billing/routing tier tags (:free, :batch, :extended, :latest, ...) while preserving Ollama parameter-size tags (:1b, :8b, :70b)
 * and stripping quantisation/instruct suffixes from those size tags.
 */
export function stripTierSuffix(rawId) {
  const s = String(rawId ?? "").trim().toLowerCase().replace(/^~+/, "");
  if (!s.includes(":")) return { baseId: s, tier: null };
  const [left, ...rest] = s.split(":");
  const tag = rest.join(":");
  if (!tag) return { baseId: left, tier: null };
  if (TIER_TAGS.has(tag)) return { baseId: left, tier: tag };

  // Check if the tag starts with a parameter size like "8b", "1.5b", "70b-instruct-q4_K_M"
  const toks = tag.split("-");
  const sz = /^(\d+(?:\.\d+)?)b$/.exec(toks[0] ?? "");
  if (sz) {
    const extra = toks.slice(1).filter((t) => !["instruct", "chat", "it"].includes(t) && !QUANT_TOKEN_RE.test(t));
    const normTag = extra.length ? `${sz[1]}b-${extra.join("-")}` : `${sz[1]}b`;
    return { baseId: `${left}:${normTag}`, tier: normTag !== tag ? tag : null };
  }

  // On slashed vendor/model:tag IDs, any non-size suffix after ':' is a routing/billing variant
  if (left.includes("/")) return { baseId: left, tier: tag };
  return { baseId: s, tier: null };
}

/**
 * Match plain open-weights family + version + optional coder + sizeb across both Ollama ('llama3.2:1b', 'qwen2.5-coder:7b-instruct-q4_K_M')
 * and vendor/slug ('meta-llama/llama-3.2-1b-instruct', 'vendor-a/qwen2.5-14b-instruct') formats.
 * Never matches distills ('deepseek-r1:8b') or fine-tunes ('aion-labs/aion-rp-llama-3.1-8b').
 */
function parsePlainOpenWeight(baseId) {
  if (!baseId.includes("/") && baseId.includes(":")) {
    const [base, tag = ""] = baseId.split(":");
    const m = /^([a-z]+)-?(\d+(?:\.\d+)?)?(?:-(coder))?$/.exec(base);
    const sz = /^(\d+(?:\.\d+)?)b$/.exec(tag);
    if (!m || !sz || !OPEN_WEIGHT_FAMILIES.has(m[1])) return null;
    const vendor = FAMILY_VENDOR[m[1]];
    return { vendor, key: `${vendor}/${m[1]}${m[2] ? "-" + m[2] : ""}${m[3] ? "-" + m[3] : ""}-${sz[1]}b` };
  }
  const slug = baseId.includes("/") ? baseId.split("/").slice(1).join("/") : baseId;
  const m = /^([a-z]+)-?(\d+(?:\.\d+)?)?(?:-(coder))?-(\d+(?:\.\d+)?)b(?:-(?:instruct|chat|it|q\d.*|fp16|f16|fp8|bf16))*$/.exec(slug);
  if (!m || !OPEN_WEIGHT_FAMILIES.has(m[1])) return null;
  const vendor = FAMILY_VENDOR[m[1]];
  return { vendor, key: `${vendor}/${m[1]}${m[2] ? "-" + m[2] : ""}${m[3] ? "-" + m[3] : ""}-${m[4]}b` };
}

/** Compute the canonical model key and canonical vendor for a model ID (before cross-catalog date-pin collapsing). */
export function canonicalModelKey(rawId) {
  const raw = String(rawId ?? "").trim();
  if (!raw) return null;
  const rawPrefix = raw.includes("/") ? raw.split("/")[0].toLowerCase().replace(/^~+/, "") : null;
  const { baseId, tier } = stripTierSuffix(raw);
  if (!baseId) return null;

  const plain = parsePlainOpenWeight(baseId);
  if (plain) {
    return { key: plain.key, vendor: plain.vendor, rawVendor: rawPrefix ?? plain.vendor, baseId, tier };
  }

  let vendor = rawPrefix ? (VENDOR_ALIASES[rawPrefix] ?? rawPrefix) : normalizeVendor(baseId);
  if (!rawPrefix && !Object.values(FAMILY_VENDOR).includes(vendor)) vendor = "unknown";
  const rawSlug = baseId.includes("/") ? baseId.split("/").slice(1).join("/") : baseId;
  const slug = rawSlug.replace(CHAT_SUFFIX_RE, "");
  return { key: `${vendor}/${slug}`, vendor, rawVendor: rawPrefix ?? vendor, baseId, tier };
}

/** Classify a source into 'simulated', 'peer', 'local', 'remote', or 'hosted'. */
export function classifySourceKind(src = {}) {
  if (src.simulated === true || src.kind === "demo" || src.kind === "sim" || src.kind === "simulated") return "simulated";
  if (src.kind === "peer") return "peer";
  if (src.remote === true || src.kind === "remote") return "remote";
  if (src.kind === "local") return "local";
  if (src.kind === "hosted") return "hosted";
  if (typeof src.baseUrl === "string" && src.baseUrl.trim()) {
    return isLocalUrl(src.baseUrl) ? "local" : "hosted";
  }
  return "hosted";
}

function emptyBucket() {
  return { sources: 0, rawEntries: 0, uniqueModels: 0, uniqueVendors: 0, models: [], vendors: [] };
}

/**
 * Measure a catalog from an array of source objects:
 *   [{ name, kind?, baseUrl?, remote?, simulated?, online?, models: [string | { id, name, pricing }] }]
 */
export function measureCatalog(sources = [], { includeOffline = false } = {}) {
  const excluded = {
    simulatedSources: 0,
    simulatedModels: 0,
    offlineSources: 0,
    offlineModels: 0,
    metaRouters: 0,
    movingAliases: 0,
  };
  const rawVendorPrefixes = new Set();
  const keptEntries = []; // { rawId, hostKind, sourceName, parsed }
  const activeSourcesByKind = { peer: 0, local: 0, remote: 0, hosted: 0 };

  for (const src of Array.isArray(sources) ? sources : []) {
    if (!src || typeof src !== "object") continue;
    const models = Array.isArray(src.models) ? src.models : [];
    const hostKind = classifySourceKind(src);
    if (hostKind === "simulated") {
      excluded.simulatedSources++;
      excluded.simulatedModels += models.length;
      continue;
    }
    if (src.online === false && !includeOffline) {
      excluded.offlineSources++;
      excluded.offlineModels += models.length;
      continue;
    }
    activeSourcesByKind[hostKind] = (activeSourcesByKind[hostKind] ?? 0) + 1;

    for (const item of models) {
      const rawId = typeof item === "string" ? item.trim() : String(item?.id ?? item?.name ?? "").trim();
      if (!rawId) continue;
      const lower = rawId.toLowerCase();
      if (lower.includes("/")) rawVendorPrefixes.add(lower.split("/")[0]);
      else rawVendorPrefixes.add(normalizeVendor(lower));

      if (isMetaRouter(item)) {
        excluded.metaRouters++;
        continue;
      }
      if (isMovingAlias(item)) {
        excluded.movingAliases++;
        continue;
      }
      const parsed = canonicalModelKey(rawId);
      if (!parsed) continue;
      keptEntries.push({ rawId, lowerId: lower, hostKind, sourceName: src.name || hostKind, parsed });
    }
  }

  // Step 1: exact cross-source duplicates and distinct baseIds (after stripping :free, :batch, etc.)
  const distinctRawIds = new Set(keptEntries.map((e) => e.lowerId));
  const exactDuplicatesCollapsed = Math.max(0, keptEntries.length - distinctRawIds.size);
  const distinctBaseIds = new Set(keptEntries.map((e) => e.parsed.baseId));
  const tierVariantsCollapsed = Math.max(0, distinctRawIds.size - distinctBaseIds.size);

  // Step 2: pre-date-collapse canonical keys (after stripping -instruct/-chat/-it and unifying plain open-weight names)
  const preDateKeys = new Set(keptEntries.map((e) => e.parsed.key));
  const chatAndFormatCollapsed = Math.max(0, distinctBaseIds.size - preDateKeys.size);

  // Step 3: collapse dated snapshots (-YYYY-MM-DD, -MMDD, etc.) only when the undated base key is also present
  const finalKeyOf = (key) => {
    const undated = key.replace(DATE_PIN_RE, "");
    return undated !== key && preDateKeys.has(undated) ? undated : key;
  };

  const allModels = new Set();
  const allVendors = new Set();
  const rawKeptVendorPrefixes = new Set();
  const bucketSets = {
    peer: { models: new Set(), vendors: new Set(), rawEntries: 0, sources: activeSourcesByKind.peer },
    local: { models: new Set(), vendors: new Set(), rawEntries: 0, sources: activeSourcesByKind.local },
    remote: { models: new Set(), vendors: new Set(), rawEntries: 0, sources: activeSourcesByKind.remote },
    hosted: { models: new Set(), vendors: new Set(), rawEntries: 0, sources: activeSourcesByKind.hosted },
    p2pAndSelf: { models: new Set(), vendors: new Set(), rawEntries: 0, sources: activeSourcesByKind.peer + activeSourcesByKind.local + activeSourcesByKind.remote },
  };

  for (const e of keptEntries) {
    const finalKey = finalKeyOf(e.parsed.key);
    const vendor = e.parsed.vendor;
    allModels.add(finalKey);
    allVendors.add(vendor);
    rawKeptVendorPrefixes.add(e.parsed.rawVendor);

    const b = bucketSets[e.hostKind];
    if (b) {
      b.rawEntries++;
      b.models.add(finalKey);
      b.vendors.add(vendor);
    }
    if (e.hostKind !== "hosted") {
      bucketSets.p2pAndSelf.rawEntries++;
      bucketSets.p2pAndSelf.models.add(finalKey);
      bucketSets.p2pAndSelf.vendors.add(vendor);
    }
  }

  const datedSnapshotsCollapsed = Math.max(0, preDateKeys.size - allModels.size);
  const vendorAliasesCollapsed = Math.max(0, rawKeptVendorPrefixes.size - allVendors.size);

  const finalizeBucket = (b) => ({
    sources: b.sources,
    rawEntries: b.rawEntries,
    uniqueModels: b.models.size,
    uniqueVendors: b.vendors.size,
    models: [...b.models].sort(),
    vendors: [...b.vendors].sort(),
  });

  const rawEntriesTotal = keptEntries.length + excluded.metaRouters + excluded.movingAliases;

  return {
    totals: {
      activeSources: activeSourcesByKind.peer + activeSourcesByKind.local + activeSourcesByKind.remote + activeSourcesByKind.hosted,
      rawEntries: rawEntriesTotal,
      rawVendorPrefixes: rawVendorPrefixes.size,
      keptEntries: keptEntries.length,
      uniqueBaseIds: distinctBaseIds.size,
      uniqueModels: allModels.size,
      uniqueVendors: allVendors.size,
    },
    excluded,
    deduped: {
      exactDuplicates: exactDuplicatesCollapsed,
      tierVariants: tierVariantsCollapsed,
      chatAndFormatVariants: chatAndFormatCollapsed,
      datedSnapshots: datedSnapshotsCollapsed,
      vendorAliases: vendorAliasesCollapsed,
    },
    byHosting: {
      peer: finalizeBucket(bucketSets.peer),
      local: finalizeBucket(bucketSets.local),
      remote: finalizeBucket(bucketSets.remote),
      hosted: finalizeBucket(bucketSets.hosted),
      p2pAndSelf: finalizeBucket(bucketSets.p2pAndSelf),
    },
    models: [...allModels].sort(),
    vendors: [...allVendors].sort(),
    rules: DEDUPE_RULES,
  };
}

/** Build source descriptors from a node's state.json object (with optional live HTTP health probe of upstreams). */
export async function sourcesFromState(state, { probe = false, fetchFn = fetch, timeoutMs = 4000 } = {}) {
  const out = [];
  for (const up of state?.upstreams ?? []) {
    if (!up || typeof up !== "object") continue;
    let online = true;
    let models = Array.isArray(up.models) ? up.models : [];
    if (probe && up.kind !== "demo" && typeof up.baseUrl === "string" && up.baseUrl) {
      try {
        const r = await fetchFn(up.baseUrl.replace(/\/$/, "") + "/models", { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
        if (r.status >= 500) online = false;
        else if (r.ok) {
          const j = await r.json().catch(() => null);
          const rows = j?.data ?? j?.models;
          if (Array.isArray(rows) && rows.length) models = rows;
        }
      } catch {
        online = false;
      }
    }
    out.push({
      name: up.name || up.id || "upstream",
      kind: up.kind === "demo" ? "demo" : undefined,
      baseUrl: up.baseUrl,
      remote: up.remote === true,
      simulated: up.kind === "demo",
      online,
      models,
    });
  }
  for (const p of Object.values(state?.peers ?? {})) {
    if (!p || typeof p !== "object" || !p.providing) continue;
    out.push({
      name: p.name || p.id || "peer",
      kind: "peer",
      simulated: p.simulated === true,
      online: p.online !== false,
      models: Array.isArray(p.models) ? p.models : [],
    });
  }
  return out;
}

/** Fetch a /models (or /v1/models or /pub/market) URL and return source descriptors. */
export async function sourcesFromUrl(url, { kind, fetchFn = fetch, timeoutMs = 10_000 } = {}) {
  const u = String(url).trim();
  const r = await fetchFn(u, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${u}`);
  const j = await r.json();
  // Support /pub/market payload directly
  if (j && Array.isArray(j.models) && j.totals && j.node) {
    const peerModels = [];
    const localModels = [];
    const remoteModels = [];
    for (const m of j.models) {
      for (const o of m.offers ?? []) {
        if (o.where === "peer") peerModels.push(m.model);
        else if (o.privacy === "remote") remoteModels.push(m.model);
        else localModels.push(m.model);
      }
    }
    const sources = [];
    if (localModels.length) sources.push({ name: `${u}#local`, kind: "local", online: true, models: localModels });
    if (remoteModels.length) sources.push({ name: `${u}#remote`, kind: "remote", remote: true, online: true, models: remoteModels });
    if (peerModels.length) sources.push({ name: `${u}#peers`, kind: "peer", online: true, models: peerModels });
    return sources;
  }
  const rows = Array.isArray(j) ? j : (j?.data ?? j?.models ?? []);
  const inferredKind = kind ?? (isLocalUrl(u) ? "local" : "hosted");
  return [{ name: u, kind: inferredKind, baseUrl: u, online: true, models: rows }];
}

/** Format a human-readable summary report. */
export function formatReport(res, { label = "Catalog measurement" } = {}) {
  const t = res.totals, d = res.deduped, x = res.excluded, h = res.byHosting;
  const lines = [
    `=== ${label} ===`,
    `Active sources:        ${t.activeSources} (peer: ${h.peer.sources}, local: ${h.local.sources}, remote: ${h.remote.sources}, hosted: ${h.hosted.sources})`,
    `Raw model entries:     ${t.rawEntries} across ${t.rawVendorPrefixes} raw vendor prefixes`,
    `Excluded non-models:   ${x.metaRouters} meta-routers, ${x.movingAliases} moving '~' aliases, ${x.simulatedModels} simulated (${x.simulatedSources} sources), ${x.offlineModels} offline (${x.offlineSources} sources)`,
    `Deduplicated variants: ${d.exactDuplicates} exact cross-source, ${d.tierVariants} billing/tier (:free/:batch/...), ${d.chatAndFormatVariants} chat/format (-instruct/chat/it & Ollama/slug), ${d.datedSnapshots} dated snapshots, ${d.vendorAliases} vendor alias prefixes`,
    `Unique canonical:      ${t.uniqueModels} models from ${t.uniqueVendors} vendors`,
    `  - P2P peers:         ${h.peer.uniqueModels} models from ${h.peer.uniqueVendors} vendors (${h.peer.rawEntries} raw entries)`,
    `  - Own local:         ${h.local.uniqueModels} models from ${h.local.uniqueVendors} vendors (${h.local.rawEntries} raw entries)`,
    `  - Own remote:        ${h.remote.uniqueModels} models from ${h.remote.uniqueVendors} vendors (${h.remote.rawEntries} raw entries)`,
    `  - Non-hosted total:  ${h.p2pAndSelf.uniqueModels} models from ${h.p2pAndSelf.uniqueVendors} vendors (P2P + own local/remote)`,
    `  - Hosted APIs:       ${h.hosted.uniqueModels} models from ${h.hosted.uniqueVendors} vendors (${h.hosted.rawEntries} raw entries; NOT P2P, NOT private/TEE)`,
  ];
  return lines.join("\n");
}

async function runCli(argv) {
  const args = argv.slice(2);
  let dataDir = null, probe = true, includeOffline = false, json = false, showRules = false;
  const urls = [], files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--data" && args[i + 1]) dataDir = args[++i];
    else if (a === "--url" && args[i + 1]) urls.push(args[++i]);
    else if (a === "--file" && args[i + 1]) files.push(args[++i]);
    else if (a === "--openrouter") urls.push(OPENROUTER_MODELS_URL);
    else if (a === "--no-probe") probe = false;
    else if (a === "--probe") probe = true;
    else if (a === "--include-offline") includeOffline = true;
    else if (a === "--json") json = true;
    else if (a === "--rules") showRules = true;
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node tools/catalog-stats.mjs [--data <dir>] [--no-probe] [--include-offline] [--url <models-url>] [--openrouter] [--file <json>] [--json] [--rules]");
      return;
    } else if (/^https?:\/\//i.test(a)) urls.push(a);
  }

  if (!dataDir && !urls.length && !files.length) {
    if (existsSync("/var/lib/elyra/state.json")) dataDir = "/var/lib/elyra";
    else if (existsSync(".elyra/state.json")) dataDir = ".elyra";
  }

  const sources = [];
  const labels = [];
  if (dataDir) {
    const sf = dataDir.endsWith(".json") ? dataDir : join(dataDir, "state.json");
    if (!existsSync(sf)) throw new Error(`state file not found: ${sf}`);
    const state = JSON.parse(readFileSync(sf, "utf8"));
    sources.push(...(await sourcesFromState(state, { probe })));
    labels.push(`node state (${sf}${probe ? ", probed" : ", cached"})`);
  }
  for (const f of files) {
    const raw = JSON.parse(readFileSync(f, "utf8"));
    const rows = Array.isArray(raw) ? raw : (raw?.data ?? raw?.models ?? []);
    sources.push({ name: f, kind: "hosted", online: true, models: rows });
    labels.push(f);
  }
  for (const u of urls) {
    sources.push(...(await sourcesFromUrl(u)));
    labels.push(u);
  }

  const res = measureCatalog(sources, { includeOffline });
  if (json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log(formatReport(res, { label: labels.join(" + ") || "Catalog measurement" }));
  if (showRules) {
    console.log("\nDeduplication & classification rules:");
    for (const r of DEDUPE_RULES) console.log(`  [${r.id}] ${r.title}: ${r.summary}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli(process.argv).catch((e) => {
    console.error("catalog-stats error:", e.message);
    process.exit(1);
  });
}
