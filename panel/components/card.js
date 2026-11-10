// Static building blocks: page header, stat card, key/value row, empty state, skeletons. Return HTML strings.
// Arguments are trusted markup; callers esc() any dynamic/remote text before passing it in.

import { icon } from "../lib/icons.js";

// eyebrow = the sidebar group; actions = optional buttons on the right
export const pageHead = (eyebrow, title, lede, actions = "") =>
  `<div class="pagehead"><div class="ph"><div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${lede ? `<p class="lede">${lede}</p>` : ""}</div>${actions ? `<div class="act">${actions}</div>` : ""}</div>`;

// d (delta line) is optional; accent highlights the money-in card
export const statCard = (value, label, d, accent) =>
  `<div class="card stat${accent ? " accent" : ""}"><div class="metric"><span class="lbl">${label}</span><b class="val">${value}</b>${d === undefined ? "" : `<span class="delta">${d}</span>`}</div></div>`;

export const kv = (k, v) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`;

// action (optional) is one button/link shown under the text: friendly empty states offer one next step; ic picks the illustration icon
export const empty = (title, text, action = "", ic = "inbox") => `<div class="empty"><span class="ill">${icon(ic)}</span><b>${title}</b><p>${text}</p>${action}</div>`;

// placeholders while data loads (same size as the real thing, so nothing jumps)
export const skelStats = (n = 4) => Array.from({ length: n }, () => `<div class="card stat"><div class="skel l" style="width:50%"></div><div class="skel v"></div><div class="skel l" style="width:40%"></div></div>`).join("");
export const skelRows = (n = 4) => `<div class="skel-wrap">${Array.from({ length: n }, () => `<div class="skel" style="height:34px"></div>`).join("")}</div>`;
export const skelBlock = (h = 110) => `<div class="skel" style="height:${h}px"></div>`;
