// Docs behaviour: copy buttons, "on this page" scroll-spy, mobile drawer, and client-side search (Ctrl/Cmd+K or /).
(() => {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // copy buttons
  $$(".code .copy").forEach((b) => b.addEventListener("click", async () => {
    const text = b.closest(".code").querySelector("pre").innerText.replace(/\n$/, "");
    try { await navigator.clipboard.writeText(text); } catch { const t = document.createElement("textarea"); t.value = text; document.body.append(t); t.select(); document.execCommand("copy"); t.remove(); }
    b.textContent = "COPIED"; b.classList.add("ok"); setTimeout(() => { b.textContent = "COPY"; b.classList.remove("ok"); }, 1600);
  }));

  // mobile drawer
  const setNav = (o) => { document.body.classList.toggle("nav-open", o); $("#menu")?.setAttribute("aria-expanded", String(o)); };
  $("#menu")?.addEventListener("click", () => setNav(!document.body.classList.contains("nav-open")));
  $("#scrim")?.addEventListener("click", () => setNav(false));
  $$("#side a").forEach((a) => a.addEventListener("click", () => setNav(false)));

  // scroll-spy for the right-hand table of contents: the active entry is the last heading whose top has passed the sticky bar
  const links = new Map($$(".toc a").map((a) => [a.getAttribute("href").slice(1), a]));
  if (links.size) {
    const heads = [...links.keys()].map((id) => document.getElementById(id)).filter(Boolean);
    let queued = false;
    const spy = () => {
      queued = false;
      let cur = heads[0];
      for (const h of heads) { if (h.getBoundingClientRect().top <= 120) cur = h; else break; }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = heads[heads.length - 1]; // bottom of page
      links.forEach((a, id) => a.classList.toggle("on", cur && id === cur.id));
    };
    addEventListener("scroll", () => { if (!queued) { queued = true; requestAnimationFrame(spy); } }, { passive: true });
    addEventListener("hashchange", () => setTimeout(spy, 50));
    spy();
  }

  // search
  const dlg = $("#sdlg"), input = $("#sq"), list = $("#sres");
  let index = null, results = [], sel = 0;
  const load = () => (index ||= fetch("/docs/assets/search-index.json").then((r) => r.json()).catch(() => []));
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const mark = (s, terms) => { let out = esc(s); terms.forEach((t) => { out = out.replace(new RegExp("(" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi"), "<mark>$1</mark>"); }); return out; };
  const snippet = (x, terms) => { const i = Math.max(0, Math.min(...terms.map((t) => { const k = x.toLowerCase().indexOf(t); return k < 0 ? 1e9 : k; }).concat([1e9])) - 40); return (i > 0 ? "…" : "") + x.slice(i, i + 150) + (x.length > i + 150 ? "…" : ""); };
  async function run() {
    const terms = input.value.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    if (!terms.length) { list.innerHTML = '<li class="none">Type to search titles, headings and text.</li>'; results = []; return; }
    const all = await load();
    results = all.map((e) => {
      const h = e.h.toLowerCase(), p = e.p.toLowerCase(), x = e.x.toLowerCase(); let s = 0;
      for (const t of terms) { const a = (h.includes(t) ? 8 : 0) + (p.includes(t) ? 4 : 0) + (x.includes(t) ? 1 : 0); if (!a) return null; s += a; }
      return { e, s: s + (e.u.includes("#") ? 0 : 2) };
    }).filter(Boolean).sort((a, b) => b.s - a.s).slice(0, 9);
    sel = 0;
    list.innerHTML = results.length ? results.map((r, i) => `<li class="${i ? "" : "on"}" role="option"><a href="${r.e.u}"><small>${esc(r.e.g)} · ${esc(r.e.p)}</small><b>${mark(r.e.h, terms)}</b><span>${mark(snippet(r.e.x, terms), terms)}</span></a></li>`).join("") : '<li class="none">No results. Try fewer or different words.</li>';
  }
  const open = () => { if (!dlg) return; dlg.hidden = false; input.value = ""; list.innerHTML = '<li class="none">Type to search titles, headings and text.</li>'; load(); setTimeout(() => input.focus(), 0); };
  const close = () => { if (dlg) dlg.hidden = true; };
  $("#open-search")?.addEventListener("click", () => { setNav(false); open(); });
  $("#open-search-2")?.addEventListener("click", open);
  dlg?.addEventListener("click", (e) => { if (e.target === dlg) close(); });
  input?.addEventListener("input", run);
  const move = (d) => { const items = $$("li", list).filter((l) => !l.classList.contains("none")); if (!items.length) return; sel = (sel + d + items.length) % items.length; items.forEach((l, i) => l.classList.toggle("on", i === sel)); items[sel].scrollIntoView({ block: "nearest" }); };
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) { e.preventDefault(); open(); return; }
    if (!dlg || dlg.hidden) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") { const a = $$("li", list)[sel]?.querySelector("a"); if (a) location.href = a.getAttribute("href"); }
  });
})();
