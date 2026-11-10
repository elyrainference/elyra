// Classic (non-module) script loaded in <head>: sets data-theme and data-density before first paint so there is no flash.
// Theme: stored choice wins, else the OS preference, else dark. Density: stored "compact" only. The toggles live in lib/theme.js (same keys).
(function () {
  var t = null, d = null;
  try { t = localStorage.getItem("elyra-theme"); d = localStorage.getItem("elyra-density"); } catch (e) { /* storage blocked: fall through */ }
  if (t !== "light" && t !== "dark") t = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", t);
  if (d === "compact") document.documentElement.setAttribute("data-density", "compact");
})();
