// Recent activity card on Home: the newest rows of the owner's Live feed (GET /api/events/recent, metadata only), drawn with the Live view's own
// row renderer. A node whose event log is empty (or that cannot answer) falls back to its persisted route log, shaped as the same request events.
import { api } from "../lib/api.js";
import { $, setHtml } from "../lib/dom.js";
import { empty } from "../components/card.js";
import { row } from "./live-row.js";

const SHOWN = 6;
const fromRoute = (r) => ({ id: r.id, ts: r.ts, kind: "request", role: r.dir === "in" ? "seller" : "buyer", status: r.ok ? "ok" : "error", model: r.model, peer: r.peer, simulated: r.simulated, promptTokens: r.p, completionTokens: r.c, costUsd: r.amount, latencyMs: r.ms });

/** Newest activity: the Live feed's events, topped up with the persisted route log for the time before the feed's first request event (the feed
 *  only remembers what happened since the node started; the route log is the same requests, so nothing is listed twice). */
export async function recentActivity(routes) {
  const rec = await api("/api/events/recent").catch(() => ({ events: [] }));
  const ev = rec.events ?? [], firstReq = ev.find((e) => e.kind === "request")?.ts ?? Infinity;
  return [...ev, ...routes.filter((r) => r.ts < firstReq).map(fromRoute)].sort((a, b) => b.ts - a.ts).slice(0, SHOWN);
}

export function renderActivity(events) {
  setHtml($("#ov-activity"), events.length
    ? `<ol class="lv-list ov-act" aria-label="Recent activity">${events.map((e) => row(e).outerHTML).join("")}</ol>`
    : empty("Nothing yet", "Send a request in the Playground and it shows up here.", '<button type="button" class="btn sm primary" data-go="playground">Send a test request</button>', "pulse"));
}
