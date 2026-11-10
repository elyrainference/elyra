// The sign-in page of remote access. Same design language as the panel and the public market page (dark by default, rounded card, gradient
// primary button, system fonts). Self-contained (inline style is allowed by this page's own CSP, so the light variant follows the OS preference
// only). No inline script ever: the optional wallet sign-in loads /admin/login.js (same origin, allowed by `script-src 'self'` only when an admin
// address is configured). The logo mask comes from /try/mark.svg, which only exists when the public page is on; without it the brand is just text.
const CSS = `
:root{color-scheme:dark;--bg:#0b0d12;--surface:#12151c;--input:#0e1118;--border:rgba(255,255,255,.08);--border2:rgba(255,255,255,.15);--text:#e8eaf0;--muted:#8b93a7;--accent:#6d6bff;--accent-bg:rgba(109,107,255,.14);--accent-text:#a5a4ff;--grad:linear-gradient(135deg,#5b59f5,#8257f0);--bad:#ff7a8a;--bad-bg:rgba(255,122,138,.12);--bad-bd:rgba(255,122,138,.36);--shadow:0 10px 34px rgba(0,0,0,.5)}
@media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#f5f6fa;--surface:#fff;--input:#fff;--border:rgba(15,23,42,.1);--border2:rgba(15,23,42,.2);--text:#0f172a;--muted:#566074;--accent:#4f46e5;--accent-bg:rgba(79,70,229,.09);--accent-text:#4338ca;--grad:linear-gradient(135deg,#4f46e5,#7c3aed);--bad:#a91f33;--bad-bg:rgba(192,39,58,.08);--bad-bd:rgba(192,39,58,.32);--shadow:0 12px 36px rgba(15,23,42,.18)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;color:var(--text);font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;background:radial-gradient(60% 80% at 80% -10%,var(--accent-bg),transparent 70%),var(--bg)}
main{width:min(400px,92vw)}
.brand{display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:22px;font-size:19px;font-weight:650;letter-spacing:-.01em}.brand i{width:26px;height:23px;background:var(--grad);-webkit-mask:url(/try/mark.svg) center/contain no-repeat;mask:url(/try/mark.svg) center/contain no-repeat}
.card{padding:26px;background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow)}form{margin:0}
h1{font-size:22px;line-height:1.2;font-weight:650;letter-spacing:-.02em;margin:0 0 6px}p{color:var(--muted);margin:0 0 18px}
input,button{width:100%;height:40px;padding:0 12px;border-radius:8px;font:inherit}
input{border:1px solid var(--border2);background:var(--input);color:var(--text)}
input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-bg),0 0 0 1px var(--accent)}
button{margin-top:12px;background:var(--grad);color:#fff;border:0;cursor:pointer;font-weight:550;box-shadow:0 1px 2px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.18)}
button:hover{filter:brightness(1.08)}
.e{color:var(--bad);background:var(--bad-bg);border:1px solid var(--bad-bd);border-radius:8px;padding:8px 10px;margin-top:12px;font-size:13px}
.back{text-align:center;margin-top:16px}.back a{color:var(--accent-text);font-size:13px;text-decoration:none}.back a:hover{text-decoration:underline}
.alt{background:var(--accent-bg);color:var(--accent-text);border:1px solid var(--border2);box-shadow:none}.alt:disabled{opacity:.6;cursor:default}
.or{display:flex;align-items:center;gap:10px;margin:16px 0 4px;color:var(--muted);font-size:12px}.or:before,.or:after{content:"";flex:1;height:1px;background:var(--border)}
.hint{font-size:12.5px;margin:10px 0 0}[hidden]{display:none}
`;

/** `msg` is a short fixed string chosen by the server (never user input). `opts`: which sign-in methods this node offers. */
export const loginPage = (msg = "", { token = true, wallet = false } = {}) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Sign in · Elyra</title><style>${CSS}</style>
<main><div class=brand><i></i>Elyra</div>
<div class=card><h1>Sign in</h1><p>Control panel of this node.${token && wallet ? " Use your admin wallet or the admin token." : wallet ? " Use your admin wallet." : " Enter the admin token."}</p>${wallet ? `
<div id=wallet hidden><button type=button class=alt id=wbtn>Sign in with wallet</button><div id=wlist></div><p class=hint>Signing proves you own the address. It sends no transaction and moves no funds.</p></div><noscript><p class=hint>Wallet sign-in needs JavaScript.</p></noscript>${token ? `<div class=or>or</div>` : ""}` : ""}${token ? `
<form method=post action=/admin/login><input type=password name=token placeholder="Admin token" autocomplete=current-password ${wallet ? "" : "autofocus "}required><button>Sign in</button></form>` : ""}<div class=e id=err role=alert${msg ? "" : " hidden"}>${msg}</div></div>
<div class=back><a href="/">← Back to the market</a></div></main>${wallet ? "\n<script src=/admin/login.js defer></script>" : ""}`;
