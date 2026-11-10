// One entry of a route-preview ranking (playground + routing). detail is the caller's pre-escaped <small> line.
import { esc } from "../lib/dom.js";
import { logo } from "./badge.js";

export const rankItem = (c, i, detail) =>
  `<div class="rk ${i ? "" : "first"}"><div class="t"><span class="mn">${logo(c.logo, c.model)}<span><b>${esc(c.model)}</b><span class="sub">${esc(c.peerName)}</span></span></span><b>${(c.score * 100).toFixed(0)}</b></div><div class="sc"><i style="width:${c.score * 100}%"></i></div><small>${detail}</small></div>`;
