// Ring topology as an SVG string: YOU in the centre, live peers / bridges / community GPUs on three ellipses, animated flow to recently routed peers.
// Pure: nodes + selection in, markup out. Every remote name goes through esc().
import { LOGO, MARK_WHITE } from "../lib/config.js";
import { esc } from "../lib/dom.js";

const W = 960, H = 540, CX = W / 2, CY = H / 2;
const RINGS = [["live", 150, 100, -1.1, "LIVE"], ["bridge", 280, 170, 0.35, "BRIDGES"], ["community", 410, 232, 0.12, "COMMUNITY"]];
const VISIBLE = { ALL: () => true, LIVE: (n) => n.kind === "live", BRIDGES: (n) => n.kind === "bridge", COMMUNITY: (n) => n.kind === "community" };

function place(nodes) {
  const placed = [];
  for (const [kind, rx, ry, off] of RINGS) {
    const arr = Object.values(nodes).filter((n) => n.kind === kind).sort((a, b) => a.id.localeCompare(b.id));
    arr.forEach((n, i) => { const a = (i / arr.length) * Math.PI * 2 + off; placed.push({ n, x: CX + Math.cos(a) * rx, y: CY + Math.sin(a) * ry }); });
  }
  return placed;
}

function nodeSvg(n, x, y, sel, op) {
  const cls = `nd ${n.kind}${n.tee ? " tee" : ""}${sel ? " sel" : ""}`, head = `<g class="${cls}" data-id="${esc(n.id)}" tabindex="0" role="button" aria-label="${esc(n.name + " (" + n.kind + ")")}" opacity="${op}">`;
  if (n.kind === "live") {
    return `${head}<circle class="pulse" cx="${x}" cy="${y}" r="14"/><circle class="nb" cx="${x}" cy="${y}" r="15"/><circle class="okdot" cx="${x}" cy="${y}" r="4.5"/><text x="${x}" y="${y + 32}" text-anchor="middle" class="nlbl">${esc(n.name)}</text></g>`;
  }
  if (n.kind === "bridge") {
    const img = n.logo && /^[\w-]+$/.test(n.logo) ? `<foreignObject x="${x - 8}" y="${y - 8}" width="16" height="16"><span class="gl" style="--l:url(${LOGO}${n.logo}.svg)"></span></foreignObject>` : "";
    return `${head}<circle class="nb" cx="${x}" cy="${y}" r="${sel ? 17 : 14}"/>${img}<text x="${x}" y="${y + 28}" text-anchor="middle" class="nlbl sm">${esc(n.name.replace("bridge · ", ""))}</text></g>`;
  }
  return `${head}<circle class="nb" cx="${x}" cy="${y}" r="${(sel ? 4 : 0) + 4.5 + Math.min(5, n.models.length * 0.9)}"/></g>`;
}

// hot: Map(peerId -> fresh?) of recently routed peers
export function graphSvg({ nodes, filter, sel, hot, youName }) {
  const show = VISIBLE[filter] ?? VISIBLE.ALL;
  const placed = place(nodes);
  let g = `<defs><radialGradient id="nwg" cx="50%" cy="50%" r="50%"><stop offset="0" style="stop-color:var(--accent);stop-opacity:.2"/><stop offset="1" style="stop-color:var(--accent);stop-opacity:0"/></radialGradient></defs><ellipse cx="${CX}" cy="${CY}" rx="450" ry="262" fill="url(#nwg)"/>`;
  for (const [, rx, ry, , lbl] of RINGS) g += `<ellipse class="ringline" cx="${CX}" cy="${CY}" rx="${rx}" ry="${ry}"/><text x="${CX + rx * 0.707 + 6}" y="${CY - ry * 0.707 - 6}" class="ringlbl">${lbl}</text>`;
  for (const { n, x, y } of placed) g += `<line class="lk ${n.kind}" style="opacity:${!show(n) ? 0.03 : n.kind === "live" ? 0.7 : 0.13}" x1="${CX}" y1="${CY}" x2="${x}" y2="${y}"/>`;
  for (const { n, x, y } of placed) {
    if (!hot.has(n.id) || !show(n)) continue;
    const d = `M${CX},${CY} L${x},${y}`, fresh = hot.get(n.id);
    g += `<path d="${d}" class="flow" stroke-width="${fresh ? 3 : 1.5}" opacity="${fresh ? 1 : 0.5}"/>` +
      [0, 0.6, 1.2].map((dl) => `<circle class="flowdot" r="${fresh ? 4 : 3}"><animateMotion dur="1.8s" begin="${dl}s" repeatCount="indefinite" path="${d}"/></circle>`).join("");
  }
  for (const { n, x, y } of placed) g += nodeSvg(n, x, y, sel === n.id, show(n) ? 1 : 0.12);
  g += `<circle class="orbit" cx="${CX}" cy="${CY}" r="44"/><circle class="you-core" cx="${CX}" cy="${CY}" r="30"/><image href="${MARK_WHITE}" x="${CX - 15}" y="${CY - 15}" width="30" height="30"/><text x="${CX}" y="${CY + 64}" text-anchor="middle" class="nlbl you">You · ${esc(youName)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${g}</svg>`;
}
