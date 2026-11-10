// Documentation site generator: Markdown in docs/ -> grouped, searchable pages in the landing page's visual language.
// Dev-only (dependency: marked). Output: dist/docs/**, dist/docs/assets/{docs.css,docs.js,search-index.json}.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { marked } from "marked";

// Sidebar order = reading order. `src` is the Markdown source; `desc` is the one-line lede shown under the title and in search.
export const NAV = [
  { group: "Get started", items: [
    { slug: "quickstart", src: "docs/QUICKSTART.md", title: "Quickstart", desc: "From zero to a real answer from your own model in about five minutes." },
    { slug: "concepts", src: "docs/CONCEPTS.md", title: "How it works", desc: "Routing, peers, receipts and payments in plain words, and what is real today." },
    { slug: "install", src: "docs/INSTALL.md", title: "Install", desc: "Run a node on your computer or a Linux server." },
  ] },
  { group: "Guides", items: [
    { slug: "ollama", src: "docs/OLLAMA.md", title: "Use your own model", desc: "Attach Ollama so requests are answered by a model you run." },
    { slug: "usage", src: "docs/USAGE.md", title: "Use the API", desc: "Point any OpenAI-compatible tool at your node and choose how requests are routed." },
    { slug: "panel", src: "docs/PANEL.md", title: "Control panel", desc: "What each view of the panel does." },
    { slug: "wallet", src: "docs/WALLET.md", title: "Wallet and USDG", desc: "Fund the escrow, withdraw and get paid." },
    { slug: "token", src: "docs/TOKEN.md", title: "$ELYRA token", desc: "Contract address and what the token is and is not used for." },
    { slug: "provider", src: "docs/PROVIDER.md", title: "Sell capacity", desc: "Offer a model to the network and get paid per token." },
    { slug: "remote-admin", src: "docs/REMOTE-ADMIN.md", title: "Remote access", desc: "Put your node online behind a login, with an optional public try page." },
      { slug: "docker", src: "docs/DOCKER.md", title: "Run in Docker", desc: "Run the node in a container on Linux, next to your own Ollama." },
    { slug: "operations", src: "docs/OPERATIONS.md", title: "Run it in production", desc: "Hardening, monitoring, backups, upgrades and what to do when a model machine goes away." },
  ] },
  { group: "Reference", items: [
    { slug: "configuration", src: "docs/CONFIGURATION.md", title: "Configuration", desc: "Every command-line flag and environment variable." },
    { slug: "api", src: "docs/API.md", title: "Control API", desc: "The endpoints the panel uses." },
    { slug: "glossary", src: "docs/GLOSSARY.md", title: "Glossary", desc: "Terms used in the docs and the panel." },
  ] },
  { group: "Help", items: [
    { slug: "faq", src: "docs/FAQ.md", title: "FAQ", desc: "Common questions and fixes." },
    { slug: "security", src: "SECURITY.md", title: "Security", desc: "Reporting vulnerabilities and known limitations." },
    { slug: "tee", src: "docs/TEE.md", title: "Private inference (TEE)", desc: "What verified private inference means and how far it is built." },
    { slug: "roadmap", src: "ROADMAP.md", title: "Roadmap", desc: "What is planned next." },
    { slug: "changelog", src: "CHANGELOG.md", title: "Changelog", desc: "What changed." },
    { slug: "contributing", src: "CONTRIBUTING.md", title: "Contributing", desc: "Set up the code and send a pull request." },
  ] },
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const plain = (h) => h.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const slugify = (s) => plain(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";
const href = (slug) => (slug ? `/docs/${slug}/` : "/docs/");

export function buildDocs({ root, dist, REPO }) {
  const pages = NAV.flatMap((g, gi) => g.items.map((it) => ({ ...it, group: g.group, gi })));
  const bySrc = new Map(pages.map((p) => [p.src, p]));
  bySrc.set("docs/README.md", { slug: "" });

  // markdown links between pages -> /docs/<slug>/ ; any other repo path -> GitHub
  const fixLinks = (html, from) => html.replace(/href="([^"#]+)(#[^"]*)?"/g, (m, path, hash = "") => {
    if (path.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(path)) return m;
    const abs = join(dirname(from), path).split("\\").join("/");
    const hit = bySrc.get(abs);
    return hit ? `href="${href(hit.slug)}${hash}"` : `href="${REPO}/blob/main/${abs}${hash}"`;
  });

  function decorate(html) {
    const toc = [], used = new Map();
    html = html.replace(/<h([2-4])>([\s\S]*?)<\/h\1>/g, (m, d, inner) => {
      let id = slugify(inner); const n = used.get(id) ?? 0; used.set(id, n + 1); if (n) id += "-" + n;
      if (d !== "4") toc.push({ d: +d, id, text: plain(inner) });
      return `<h${d} id="${id}">${inner}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${d}>`;
    });
    // a table whose header cells are all empty is a key/value list: drop the blank header row
    html = html.replace(/<thead>\s*<tr>(?:\s*<th[^>]*>\s*<\/th>)+\s*<\/tr>\s*<\/thead>/g, "");
    html = html.replace(/<table>/g, '<div class="tablewrap"><table>').replace(/<\/table>/g, "</table></div>");
    html = html.replace(/<pre><code(?: class="language-([\w-]+)")?>([\s\S]*?)<\/code><\/pre>/g, (m, lang = "", body) =>
      `<div class="code"><div class="code-bar"><span>${esc(lang || "text")}</span><button class="copy" type="button" aria-label="Copy code">COPY</button></div><pre><code>${body}</code></pre></div>`);
    html = html.replace(/<blockquote>\s*<p>(<strong>[^<]*<\/strong>)?/g, (m, strong = "") => {
      const warn = /Status|Honest|Not |Warning|Important|Caution|Unaudited/i.test(plain(strong));
      return `<blockquote class="callout${warn ? " warn" : ""}"><p>${strong}`;
    });
    return { html, toc };
  }

  const sidebar = (cur) => NAV.map((g) => `<div class="grp">${esc(g.group)}</div>` + g.items.map((it) =>
    `<a class="nav${it.slug === cur ? " on" : ""}" href="${href(it.slug)}"${it.slug === cur ? ' aria-current="page"' : ""}>${esc(it.title)}</a>`).join("")).join("");

  const shell = ({ title, desc, body, cur, crumb, home = false }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Elyra docs</title><meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)} · Elyra docs"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="website">
<link rel="icon" type="image/svg+xml" href="/docs/assets/mark.svg"><link rel="stylesheet" href="/docs/assets/docs.css"></head>
<body${home ? ' class="home"' : ""}><a class="skip" href="#content">Skip to content</a>
<div class="shell"><aside class="side" id="side" aria-label="Documentation">
  <a class="brand" href="/" aria-label="Elyra home"><img class="mark" src="/docs/assets/mark-ink.svg" alt=""><span class="wm">ELYRA</span></a>
  <button class="searchbtn" type="button" id="open-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg><span>Search docs</span><kbd>Ctrl K</kbd></button>
  <nav>${sidebar(cur)}</nav>
  <div class="sidefoot"><a href="/">Home</a><a href="https://app.elyrainference.com/">Live app</a><a href="${REPO}">GitHub</a><a href="https://x.com/Elyrainference">X</a></div>
</aside>
<div class="main"><header class="top"><button class="menu" type="button" id="menu" aria-label="Open navigation" aria-controls="side" aria-expanded="false"><span></span><span></span><span></span></button>
  <div class="crumb">${crumb}</div><div class="r"><a class="chip" href="${REPO}">GitHub</a><a class="chip" href="https://x.com/Elyrainference">X</a><a class="btn sm" href="https://app.elyrainference.com/">Try it live</a></div></header>
${body}
<footer class="foot"><span>ELYRA · early build, testnet only · <a href="/docs/concepts/#real-versus-simulated-today">what is real today</a></span><span><a href="/legal/terms">Terms</a> · <a href="/legal/privacy">Privacy</a> · <a href="${REPO}/blob/main/LICENSE">MIT</a></span></footer>
</div></div>
<div class="scrim" id="scrim"></div>
<div class="sdlg" id="sdlg" role="dialog" aria-modal="true" aria-label="Search the docs" hidden><div class="box"><input id="sq" type="search" placeholder="Search the docs…" autocomplete="off" spellcheck="false" aria-label="Search"><ul id="sres" role="listbox"></ul><div class="hint"><span>↑↓ to move</span><span>ENTER to open</span><span>ESC to close</span></div></div></div>
<script src="/docs/assets/docs.js" defer></script></body></html>`;

  mkdirSync(join(dist, "docs", "assets"), { recursive: true });
  cpSync(new URL("./docs.css", import.meta.url), join(dist, "docs", "assets", "docs.css"));
  cpSync(new URL("./docs.js", import.meta.url), join(dist, "docs", "assets", "docs.js"));
  cpSync(join(root, "panel", "assets", "elyra-mark.svg"), join(dist, "docs", "assets", "mark.svg"));
  cpSync(join(root, "panel", "assets", "elyra-mark-ink.svg"), join(dist, "docs", "assets", "mark-ink.svg"));

  const index = [];
  const sectionsOf = (md, p) => {
    let cur = { h: p.title, id: "", text: "" };
    const flush = () => { if (cur.text.trim() || cur.h) index.push({ p: p.title, g: p.group, u: href(p.slug) + (cur.id ? "#" + cur.id : ""), h: cur.h, x: cur.text.replace(/\s+/g, " ").trim().slice(0, 2400) }); };
    const used = new Map();
    for (const t of marked.lexer(md)) {
      if (t.type === "heading" && t.depth >= 2 && t.depth <= 3) {
        flush(); let id = slugify(marked.parseInline(t.text)); const n = used.get(id) ?? 0; used.set(id, n + 1); if (n) id += "-" + n;
        cur = { h: plain(marked.parseInline(t.text)), id, text: "" };
      } else if (t.type !== "heading" && t.type !== "space") cur.text += " " + (t.raw || "").replace(/[`*_>#|\-]+/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    }
    flush();
  };

  pages.forEach((p, i) => {
    const md = readFileSync(join(root, p.src), "utf8");
    let html = marked.parse(md, { gfm: true }).replace(/^\s*<h1[^>]*>[\s\S]*?<\/h1>/, ""); // the title lives in the hero
    html = fixLinks(html, p.src);
    const { html: body, toc } = decorate(html);
    const prev = pages[i - 1], next = pages[i + 1];
    const words = plain(body).split(/\s+/).filter(Boolean).length;
    const tocHtml = toc.length > 1 ? `<aside class="toc" aria-label="On this page"><div class="k">On this page</div>${toc.map((t) => `<a class="d${t.d}" href="#${t.id}">${esc(t.text)}</a>`).join("")}</aside>` : "";
    const pn = `<nav class="pn" aria-label="Previous and next page">${prev ? `<a class="prev" href="${href(prev.slug)}"><small>Previous</small><b>${esc(prev.title)}</b></a>` : "<span></span>"}${next ? `<a class="next" href="${href(next.slug)}"><small>Next</small><b>${esc(next.title)}</b></a>` : "<span></span>"}</nav>`;
    const page = `<div class="body"><div class="pagehead"><div class="eyebrow">${esc(p.group)}</div><h1>${esc(p.title)}</h1><p class="lede">${esc(p.desc)}</p></div><article id="content" class="doc">${body}<div class="meta"><a href="${REPO}/edit/main/${p.src}">Edit this page on GitHub</a><span>${Math.max(1, Math.round(words / 200))} min read</span></div>${pn}</article>${tocHtml}</div>`;
    const dir = join(dist, "docs", p.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), shell({ title: p.title, desc: p.desc, body: page, cur: p.slug, crumb: `<a href="/docs/">Docs</a> / ${esc(p.group)} / <b>${esc(p.title)}</b>` }));
    sectionsOf(md, p);
  });

  // docs home
  const feature = (slug) => pages.find((p) => p.slug === slug);
  const card = (slug, label) => { const p = feature(slug); return `<a class="pcard" href="${href(p.slug)}"><small>${esc(label)}</small><b>${esc(p.title)}</b><p>${esc(p.desc)}</p></a>`; };
  const homeBody = `<section class="hero big"><h1>Elyra documentation</h1>
<p class="lede">Elyra is a self-hosted router for AI inference. Point any OpenAI-compatible tool at localhost; each request goes to your own model or to the peer that wins on price, speed, reputation or privacy. Providers are paid per token in USDG on Robinhood Chain.</p>
<div class="cta"><a class="btn light" href="/docs/quickstart/">Quickstart</a><a class="btn ghost" href="/docs/concepts/">How it works</a><button class="btn ghost" type="button" id="open-search-2">Search</button></div></section>
<div class="body wide" id="content"><div class="callout warn"><p><strong>Early build, testnet only.</strong> Real: the router, sealed peer transport, receipts, the control panel, and settlement on Robinhood testnet with a test token. Not real yet: mainnet, an independent audit, TEE verification against real Google hardware, peer discovery. The market in the demo is simulated and always labelled. <a href="/docs/concepts/#real-versus-simulated-today">What is real today</a>.</p></div>
<h2 class="hh">Get started</h2><div class="pgrid">${card("quickstart", "5 minutes")}${card("concepts", "Understand")}${card("install", "Set up")}</div>
<h2 class="hh">Guides</h2><div class="pgrid">${card("ollama", "Real model")}${card("usage", "API")}${card("panel", "Panel")}${card("wallet", "Payments")}${card("provider", "Earn")}${card("remote-admin", "Remote")}</div>
<h2 class="hh">Reference and help</h2><div class="pgrid">${card("configuration", "Reference")}${card("api", "Reference")}${card("faq", "Help")}${card("security", "Trust")}</div></div>`;
  mkdirSync(join(dist, "docs"), { recursive: true });
  writeFileSync(join(dist, "docs", "index.html"), shell({ title: "Documentation", desc: "Documentation for Elyra: a peer-to-peer network for AI inference.", body: homeBody, cur: "", crumb: "<b>Docs</b>", home: true }));

  writeFileSync(join(dist, "docs", "assets", "search-index.json"), JSON.stringify(index));
  const notFound = shell({ title: "Not found", desc: "Page not found", cur: "", crumb: "<b>404</b>", body: `<div class="body"><div class="pagehead"><div class="eyebrow">404</div><h1>Page not found</h1><p class="lede">That page does not exist. Try search, or start from the docs home.</p></div><article id="content" class="doc"><p><a class="btn sm" href="/docs/">DOCS HOME</a></p></article></div>` });
  return { pages, notFound, searchEntries: index.length };
}
