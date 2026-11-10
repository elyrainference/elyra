// Phone navigation drawer: the sidebar slides in from the top-bar menu button (<= 900px). On wide screens the sidebar is always visible.
// While closed on a phone the sidebar is `inert`, so keyboard focus never lands on off-screen links; while open, the page behind it is `inert`.
import { $ } from "./dom.js";
import { icon } from "./icons.js";

const mq = window.matchMedia("(max-width: 900px)");

function sync(open) {
  document.body.classList.toggle("drawer", open);
  $("#menu").setAttribute("aria-expanded", String(open));
  $(".side").inert = mq.matches && !open;
  $("#scroll").inert = mq.matches && open;
}

export function closeDrawer() { sync(false); }

export function initDrawer() {
  const menu = $("#menu");
  menu.innerHTML = icon("menu");
  menu.onclick = () => { sync(!document.body.classList.contains("drawer")); if (document.body.classList.contains("drawer")) $(".nav.on, .nav").focus(); };
  $(".scrim").onclick = () => { closeDrawer(); menu.focus(); };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("drawer")) { closeDrawer(); menu.focus(); } });
  $("#nav").addEventListener("click", (e) => { if (e.target.closest(".nav")) closeDrawer(); }); // a group header only folds its group
  mq.addEventListener("change", () => sync(false));
  sync(false);
}
