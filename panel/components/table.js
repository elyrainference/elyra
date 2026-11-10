// Table shell. heads: "Label" or ["Label", "r"] (class r = right-aligned); rows: array of <tr> HTML strings.
export const table = (heads, rows) =>
  `<table><thead><tr>${heads.map((h) => (Array.isArray(h) ? `<th class="${h[1]}">${h[0]}</th>` : `<th>${h}</th>`)).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
