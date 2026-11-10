// Observability: structured logs, Prometheus metrics, health. No prompt/completion text ever passes through here.
const START = Date.now();
const counters = new Map(); // "name{label=…}" → number
const gauges = new Map();   // name → () => number
const HELP = new Map();

const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
const keyOf = (name, labels) => {
  const l = Object.entries(labels ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}="${esc(v)}"`).join(",");
  return l ? `${name}{${l}}` : name;
};

export function describe(name, help) { HELP.set(name, help); }
export function inc(name, labels, by = 1) { const k = keyOf(name, labels); counters.set(k, (counters.get(k) ?? 0) + by); }
export function gauge(name, fn, help) { gauges.set(name, fn); if (help) HELP.set(name, help); }

export function metricsText() {
  const lines = [];
  const seen = new Set();
  const emit = (name, type) => { if (seen.has(name)) return; seen.add(name); if (HELP.has(name)) lines.push(`# HELP ${name} ${HELP.get(name)}`); lines.push(`# TYPE ${name} ${type}`); };
  for (const [k, v] of [...counters].sort(([a], [b]) => a.localeCompare(b))) { emit(k.replace(/\{.*$/, ""), "counter"); lines.push(`${k} ${v}`); }
  for (const [name, fn] of gauges) { let v = 0; try { v = Number(fn()) || 0; } catch { /* gauge unavailable */ } emit(name, "gauge"); lines.push(`${name} ${v}`); }
  emit("elyra_uptime_seconds", "gauge"); lines.push(`elyra_uptime_seconds ${Math.round((Date.now() - START) / 1000)}`);
  return lines.join("\n") + "\n";
}

// ---- logs: one JSON object per line (LOG_FORMAT=json, default when stdout is not a TTY) or readable text ----
const asJson = process.env.LOG_FORMAT ? process.env.LOG_FORMAT === "json" : !process.stdout.isTTY;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[process.env.LOG_LEVEL ?? "info"] ?? 20;

export function log(level, msg, fields = {}) {
  if ((LEVELS[level] ?? 20) < min) return;
  const rec = { t: new Date().toISOString(), level, msg, ...fields };
  const line = asJson ? JSON.stringify(rec) : `${rec.t.slice(11, 23)} ${level.toUpperCase().padEnd(5)} ${msg}${Object.keys(fields).length ? " " + Object.entries(fields).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" ") : ""}`;
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export function normalisePath(p) {
  return p.replace(/\/peers\/[\w-]+/, "/peers/:id").replace(/\/upstreams\/[\w-]+/, "/upstreams/:id");
}

describe("elyra_http_requests_total", "HTTP requests by surface, method and status class");
describe("elyra_http_request_ms_total", "Cumulative handler time in ms by surface (divide by requests for the mean)");
describe("elyra_route_total", "Routed chat requests by result and kind (self|peer|sim)");
describe("elyra_tokens_total", "Tokens moved, by direction (out = consumed, in = served)");
describe("elyra_receipts_rejected_total", "Receipts a peer sent that failed verification, by reason");
describe("elyra_vouchers_issued_total", "Payment vouchers signed");
describe("elyra_redeem_total", "On-chain redeem transactions, by result");
describe("elyra_peer_events_total", "Gossip/peer events (added, dropped, refused)");
