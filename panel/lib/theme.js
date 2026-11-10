// Appearance: theme (dark / light) and density (comfortable / compact). theme-init.js has already applied both before first paint; the account menu,
// the command palette and the shortcuts call these. Both choices persist in localStorage; with storage blocked they last for this page only.
const THEME = "elyra-theme", DENSITY = "elyra-density";
const root = document.documentElement;
const save = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };

export const currentTheme = () => (root.getAttribute("data-theme") === "light" ? "light" : "dark");
export const currentDensity = () => (root.getAttribute("data-density") === "compact" ? "compact" : "comfortable");

export function toggleTheme() {
  const next = currentTheme() === "light" ? "dark" : "light";
  root.setAttribute("data-theme", next);
  save(THEME, next);
  return next;
}

export function toggleDensity() {
  const next = currentDensity() === "compact" ? "comfortable" : "compact";
  if (next === "compact") root.setAttribute("data-density", "compact"); else root.removeAttribute("data-density");
  save(DENSITY, next);
  return next;
}
