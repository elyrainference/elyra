# AGENTS.md — read this first

Elyra is a **peer-to-peer network for AI inference**. A self-hosted Virtual Private Router (VPR) runs on the user's machine, exposes an OpenAI-compatible endpoint on localhost, and routes each request to a peer chosen by price, speed, reputation or privacy. Providers are paid directly: signed receipts record usage, EIP-712 vouchers move **USDG** (ERC-20 dollar stablecoin, 6 decimals) through an escrow contract on **Robinhood Chain** (Arbitrum Orbit L2, ETH gas); no oracle. Prompts travel sealed (X25519 + AES-GCM); TEE-backed peers are the privacy option. Anyone can provide capacity.

If you are an agent starting work: read this file, then `docs/STATUS.md` (what is true right now), then `PRD.md` only if you need intent. Do not re-derive context from the code if these answer it.

## Map

| Path | What it is |
|---|---|
| `router/server.mjs` | Boot only: CLI args, `ELYRA_*` env (TEE image), graceful shutdown. |
| `router/http/` | HTTP layer. `app.mjs` dispatch, `guard.mjs` (loopback/Host/Origin), `remote.mjs` (opt-in login for one admin host: roles admin/user), `siwe.mjs` (the ONE wallet sign-in, `/auth/*`: SIWE nonce/verify/session/logout, plus the username profile when `ELYRA_GATEWAY=1`), `public.mjs` (signed-out public surface `/pub/*`), `relay.mjs` (opt-in `ELYRA_RELAY=1`), `events.mjs` (`/api/events`), `io.mjs`, `static.mjs` (`/app/*` → `panel/`, else `site/`), route tables `v1.mjs` (OpenAI), `api.mjs` + `api-chain.mjs` (control, loopback only), `p2p.mjs` (peer protocol, open), `ops.mjs` (`/healthz`, `/metrics`). |
| `router/core/` | Node logic, no HTTP. `node.mjs` = `createNode()` entry + shared context. `identity`, `store`, `upstreams` (multi-source, health probes + failover), `candidates` (plan), `hello` (sanitised, size-capped), `peers` (gossip, bounded, eviction), `relay-client`, `registry` (on-chain discovery), `accounts` (username profiles), `ledger`, `stats`, `reputation`, `attestation`, `events` (private live feed: whitelist sanitizer + in-memory ring buffer behind `GET /api/events`; metadata only, add a field there only if it can never hold a prompt, key or IP); `consumer/` (chat, peer-exec, receipts verify, wallet/vouchers, `session-pay` browser pay-per-use); `provider/` (serve, guard, credit, vouchers, redeem, receipt, models). Dependency direction: `lib` → leaf adapters → `core` → `http` → `server.mjs`; `core` never imports `http`. |
| `router/lib/` | Pure helpers: canonical JSON, SSE parsing, URL/SSRF checks, `HttpError`, fetch-json. |
| `router/chain.mjs` | Robinhood Chain adapter (ethers): wallet, EIP-712 vouchers, approve/deposit/withdraw/redeem in USDG units. Null-safe when unconfigured. |
| `router/tee.mjs` | TEE attestation (Google Confidential Space JWT): `verifyGcpToken` (buyer), `fetchGcpToken` (seller), `bindingNonce`. |
| `tools/brand/` | Logo pipeline: `elyra-logo-source.png` → SVG marks, landing inline logos, and the 3D models `elyra.glb` / `elyra_button.glb` (Curve.1..5 = five extruded groups; `site.js` uses the node names for labels). Two orientations: the hero model stands in the Y/Z plane (hero rotates it), the token model `elyra_button.glb` lies flat in X/Z because that scene looks down on it from above (`map` in `make-logo.mjs`). Always re-check both scenes in a browser after changing the logo. Dev-only deps (pngjs, potrace, three). Re-run after changing the logo. |
| `deploy/tee/` | Dockerfile, gcloud launch script, runbook and model-server notes for the Confidential Space image. |
| `router/net.mjs` | DNS-over-HTTPS resolver + HTTP helpers. **All Robinhood RPC/explorer/docs traffic must go through it** (ISP DNS hijack). |
| `router/seal.mjs` | Sealed envelopes for `/p2p/infer` (prompt and completion encryption). |
| `contracts/` | `ElyraEscrow.sol`, `ElyraRegistry.sol` (provider discovery, deployed on both networks), hardhat tests, committed artifact `artifacts/ElyraEscrow.json`, `deploy.mjs`. Own `package.json`. |
| `router/policy.mjs` | Pure ranking: filter + weighted score, `cost()`. No I/O. |
| `router/catalog.mjs` | Simulated market (`simulated: true` everywhere). Also `guessLogo()`. |
| `router/demo.mjs` | Stub model used by simulated peers and the built-in demo engine. |
| `router/test/*.test.mjs` | Behaviour tests: ranking rules, two real nodes over HTTP, and on-chain settlement against a local hardhat node (skipped without `contracts/node_modules`). `npm test`. |
| `panel/` | Control panel: native ES modules, no build. `main.js` boot, `router.js` hash nav, `lib/` (api, store, dom `esc`, format, nav), `components/`, `views/` (one file per view), `css/`, `assets/`. Imports point downward only: main → router/actions → views → components → lib. |
| `site/` | Minimal landing placeholder served by the router at `/`. |
| `tools/pages/` | Cloudflare Pages bundle (dev-only, dep: `marked`): `build.mjs` = landing + rendered docs; `/app/*` redirects to the live node. No static demo. Never proxy a real `/api`. |
| `tools/wallet/` | Dev-only: bundles Reown AppKit + ethers into `panel/vendor/wallet.js` (loaded on click). The node has no dependency on it. |
| `panel/try/` | Public app served to signed-out visitors when `ELYRA_PUBLIC_TRY=1` (`router/http/public.mjs`): hash-routed Market / Playground / Sell, wallet connect + sign-in menu, optional pay-per-use (`pay.js`, `ELYRA_PUBLIC_PAY=1`); ES modules (`try.js` entry), strict CSP, no inline script or style. See `docs/PANEL.md#live-app-and-the-try-page`. |
| `docs/MAINNET.md` | Capped-beta runbook for Robinhood mainnet (escrow + registry deployed 2026-11-07, addresses in `docs/STATUS.md`). |
| `docs/VPS.md` | Runbook: seller node + Ollama + Caddy on a Linux VPS. |
| `docs/REGISTRY.md` | On-chain discovery (`ElyraRegistry` + `router/core/registry.mjs`, `ELYRA_REGISTRY*`, `/api/registry`); Morpheus gap analysis. |
| `docs/LANDSCAPE.md` | Competitors (Morpheus, Chutes, Phala, NEAR AI, OpenRouter) and repos worth reusing. |
| `docs/` | `STATUS.md` (live state), `ARCHITECTURE.md`, `PROTOCOL.md`, `DECISIONS.md`. |
| `PRD.md`, `ROADMAP.md`, `CHANGELOG.md` | Product intent, plan, history. |

Run: `npm start` (or `start.bat`) → `http://localhost:8545/` landing, `/app/` panel, `/v1` endpoint. Second node: `npm run node2`. Tests: `npm test`.

## Hard rules

1. **Never present simulated things as real.** Anything from `catalog.mjs`, the demo engine, or TEE claims must stay labelled (`SIM`, `DEMO`, `CLAIMED`). Simulated peers are never settled. TEE: a seller's own claim is `CLAIMED` and never counts for `teeOnly`; only a Google-signed Confidential Space attestation that passes the buyer's pinned trust list is `VERIFIED` (`router/tee.mjs`, `docs/TEE.md`) and it has not run against real Google yet, so keep saying so until milestone M1 is recorded in `docs/STATUS.md`. Settlement is simulated until an escrow address is configured (`mode: sim` vs `chain`); chain ids are verified live (46630 / 4663); testnet escrow + MockUSDG are deployed and a paid trade settled (addresses and tx hashes in `docs/STATUS.md`). Mainnet (4663) escrow + registry are deployed and the first $1 trade is recorded (`docs/STATUS.md`); never claim further mainnet settlement without a recorded tx. The testnet token is our labelled `MockUSDG`; only mainnet has real USDG (`0x5fc5…d168`). Mainnet needs `--allow-mainnet` (real funds).
2. **Local surface stays local.** `/api/*` and `/v1/*` require loopback peer address, a localhost `Host`, and (if present) a localhost `Origin`. Do not loosen. Only exception: opt-in remote admin (`router/http/remote.mjs`, needs `ELYRA_ADMIN_HOST` + `ELYRA_ADMIN_TOKEN` and/or `ELYRA_ADMIN_ADDRESSES` for wallet sign-in, `siwe.mjs`, `docs/AUTH.md`): one named host behind a login; only an **admin** session opens it (a wallet *user* session never reaches `/api`, `/v1`, `/metrics` or `/api/events`: 403); proxied traffic can never use the localhost path; `/metrics` never. Wallet sign-in is ONE system (SIWE on `/auth/*`, cookie `elyra_admin` v2, per-boot key, 12 h, logout revokes server-side); admin = address in `ELYRA_ADMIN_ADDRESSES`, else user. There are no `/gw/*` routes and no second cookie; `ELYRA_GATEWAY=1` only adds the username profile and gates `/pub/chat`. Keep `router/test/remote.test.mjs` and `siwe.test.mjs` green. `/p2p/*` is the only network-facing surface that needs no login; it must never expose keys, upstream API keys, or control actions.
3. **Prompts are never logged.** `state.routes` and `state.ledger` hold metadata only (model, peer, token counts, amounts). Keep it that way.
4. **Never serve dot-directories.** `.elyra*/` holds `identity.json` (private key). `router/http/static.mjs` serves only `panel/` (`/app/*`) and `site/`, and blocks dot segments; keep that.
5. **Receipts record usage, vouchers move money; never trust a field a peer sends.** Money amounts are derived locally and compared exactly; every numeric field is type-checked (NaN/missing must fail closed); provider credit is per *wallet*, verified on-chain (fresh read, 503 if unreachable) before any state is created. A consumer can self-redeem its deposit, so providers bound unredeemed risk (`creditUsd`) and auto-redeem. Original rule: **Receipts record usage, vouchers move money.** Consumer verifies receipt signature, parties, price ≤ quote×1.05, amount = price×tokens, token count not inflated vs received text, and (chain mode) wei amount vs own rate, *before* signing a cumulative voucher. Providers serve only inside their credit limit. Both sides must settle the same way (same escrow) or no route. Don't bypass.
6. **Landing is a mirror.** Keep structure, classes, ids, scripts. Change visible text, meta and 3D labels (`site.js`, search for `// Virtual private router`). Check layout in a browser after copy changes (counter font was resized inline for `600+`).
7. Logs/metrics go through `router/obs.mjs` (`log`, `inc`); they must never include prompt/completion text, API keys or private keys. Bump `PROTOCOL` in `router/core/limits.mjs` on wire-breaking changes.
8. No build step. Runtime dependency is only `ethers` (chain adapter; loaded dynamically, router works without it). Plain ESM on Node ≥ 20. `/p2p/infer` is sealed-only (protocol v3): never add a plaintext path.
9. Secrets go through `router/vault.mjs` (`readSecretJson`/`writeSecretJson`/`sealField`); never write key material with plain `writeFileSync`.
10. Gossip-learned peer URLs must pass the public-host check (`assertPublicUrl`); only operator-typed URLs may be private.
11. No API or panel view ever returns a private key or the passphrase. `/api/status` exposes only `node.dataDir` (a path) and `node.encrypted` (a boolean); the backup card exports public facts only. The daily spend cap (`state.settings.spendCapUsdDay`, enforced in `core/consumer/chat.mjs`) applies to paid non-self routes only.
12. **One deposit cap.** `depositCapOf(state.provide)` (`provide.maxDepositUsd`, default $20) is enforced everywhere a deposit can happen: credit gate, hello, session pay, `/api/chain`, `/api/provide`, `/pub/chain` and the node deposit path (cumulative with what the escrow already holds). On a real network the stricter of it and `ELYRA_MAINNET_DEPOSIT_CAP_USD` (default 20; invalid never disables, 0 blocks) wins, so raising it on mainnet needs both.
13. **Peer input is hostile.** Hello is sanitised and size-capped, gossip is bounded, peers are evicted; the relay (`ELYRA_RELAY=1`) only carries sealed traffic and never sees plaintext.

## Conventions

- UI language: English, sentence case, system sans font (`--font`), monospace (`--mono`) only for addresses/URLs/hashes/code; tiny uppercase only for badges and eyebrows; no web fonts. Dark theme default, light via `[data-theme="light"]` + top-bar toggle (`localStorage["elyra-theme"]`); never hard-code a colour, use the tokens (`--bg --surface --raised --border --text --muted --accent --ok --warn --bad --sim`, see `docs/PANEL.md`). New views: add to `VIEWS` in `panel/lib/nav.js` (+ icon in `lib/icons.js`) and to `panel/views/index.js`, container in `panel/index.html`. Tokens live in `panel/css/base.css :root`. All remote-supplied text goes through `esc()` (`lib/dom.js`).
- Logos: mono SVGs from `@lobehub/icons-static-svg` (jsDelivr), rendered with CSS mask so they take `currentColor`. Add a logo = drop `panel/assets/logos/<name>.svg` and reference the name in `catalog.mjs` / `guessLogo()`.
- Money is USD per million tokens (`$/MTok`), amounts rounded to 1e-8. Helper `cost()` in `router/policy.mjs`.
- Tests assert behaviour (routing rules, billing = receipt, failure modes, local-only), never wording.

## Documentation protocol (keep context alive)

You MUST update docs in the same change as the code:

| You changed… | Update |
|---|---|
| Any behaviour, endpoint, UI view, label honesty | `docs/STATUS.md` (what works / what is simulated / known gaps) and `CHANGELOG.md` |
| Wire format, receipt fields, gossip | `docs/PROTOCOL.md` |
| Module boundaries, data model, state shape | `docs/ARCHITECTURE.md` |
| A non-obvious choice or a rejected alternative | `docs/DECISIONS.md` (append: date, decision, why, alternatives) |
| Scope, priorities, finished roadmap items | `PRD.md` / `ROADMAP.md` |
| Anything a future agent would otherwise rediscover | this file |

At the end of a session append one dated line to `docs/STATUS.md → Session log`. Keep this file under ~120 lines; move detail into `docs/`.

## Known sharp edges

- The Windows shell tool kills `&`-backgrounded processes; run servers as named services.
- `site.js` is minified (~39k lines when formatted); grep for text, never re-format it.
- Landing: agency socials, GTM tracker and form action were removed; `/legal/terms|privacy` exist. The signup form is hidden, CTA links to `/app/`. Don't reintroduce third-party trackers.
- Hardhat dev chain for manual UI tests: `cd contracts && node node_modules/hardhat/internal/cli/cli.js node --port 8555`, then `node contracts/deploy.mjs --local --mock-token`, paste the printed escrow address under Payments → Network settings (network `local`), then Mint → Deposit. Testnet: `npm run chain:deploy:testnet` after funding the node wallet with ETH.
- `panel/lib/status.js` polls `/api/status` every 2s; views with forms must not re-render on poll (only `tick()` refreshes dynamic regions).
