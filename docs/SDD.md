# SDD: Elyra, software design document

Status refreshed 2026-11-08 for the public wallet flow and current UI. This is a feature-status table, not proof of production readiness; use `docs/STATUS.md` for exercised verification, deployment records and remaining gaps. Version is read from `package.json`.
Legend: **DONE** = built and covered by a test or a run against the real thing. **PARTIAL** = works, with a stated gap. **NOT DONE** = not built, or not proven.

## 1. Objective

A peer-to-peer network for AI inference without a middleman. You run a router on your own computer, point your AI tools at `localhost`, and each request goes to the best seller by price, speed, reputation or privacy. Payment settles on chain directly to the seller. Anyone can sell capacity without approval.

Users: **buyers** (developers with OpenAI-compatible tools), **sellers** (anyone with a model server), **visitors** (people deciding whether to try it).
Not a goal: presenting hosted model catalogues as peer supply or taking custody of users' funds. Optional wallet sign-in and username profiles identify users; they do not give users control over the hosted node.

## 2. Architecture

```
Your tool -> localhost:8545/v1 -> router (plan -> rank -> exec -> record)
                                     |-- own upstreams (Ollama, LM Studio, hosted API key)
                                     |-- peers: sealed POST /p2p/infer, signed receipt, voucher (EIP-712)
                                     `-- settlement: ElyraEscrow (USDG, ERC-20), seller redeems
Control panel (/app, /api, loopback or login) | Public page (/pub/*, no login) | Relay (/relay, /r/<id>)
Website + docs: Cloudflare Pages (elyrainference.com). Live node: app.elyrainference.com.
```

- Runtime: Node 22, one runtime dependency (`ethers`), no build step for the router or panel. `contracts/` and `tools/` are dev-only.
- Surfaces are separate on purpose. `/api`, `/v1`, `/metrics` are loopback-only by default; a remote admin host needs a token login. `/pub/*` is the only thing visitors reach.
- Trust model: a buyer never gives a seller more than the escrow deposit; a seller never serves a wallet without a proven deposit; a node never signs for someone else's wallet.

## 3. Functional requirements and status

### 3.1 Router (buyer side)
| ID | Requirement | Status |
|---|---|---|
| R1 | OpenAI-compatible `/v1/models` and `/v1/chat/completions`, JSON and SSE | DONE. Chat completions only |
| R2 | Routing by price, speed, reputation, privacy; `auto`, `auto:cheapest/fastest/best/private`; `maxPrice`; `teeOnly` | DONE |
| R3 | Failover to the next 3 candidates before the first byte | DONE (none after the first byte) |
| R4 | Any OpenAI-compatible upstream; hosted ones labelled HOSTED / Clear, never counted as private | DONE |
| R5 | Hosted sources ranked by their published per-model prices (not as free) | DONE |
| R6 | Source health probes every 15 s, two misses = offline, auto recovery | DONE |
| R7 | Reputation from success, speed, time to first token, uptime (needs 20 probes) | DONE. Local to each node, can be gamed by fake peers |
| R8 | Reference price from OpenRouter only for an exact family, version and size match | DONE (opt-in) |

### 3.2 Seller side
| ID | Requirement | Status |
|---|---|---|
| S1 | Sell any model your server runs (one source, multiple `upstreamIds`, or `"*"` all healthy local sources), per-model price, credit limit, per-wallet deposit cap (`maxDepositUsd`, default $20), rate limit, concurrency cap | DONE |
| S2 | Sealed transport, signed receipts, token-inflation audit, SSRF guard, deny list | DONE |
| S3 | Sell from behind a home router through a relay (`ELYRA_RELAY_URL`) | DONE. Tested over the real internet and end-to-end from `#snip-sell` on a 3-node rig (`router/test/first-run.test.mjs`, `relay.ready` before `--seed`, `announcePeers` on `PUT /api/provide`); relay sees sizes and timing only |
| S4 | Auto-redeem vouchers on chain | Implemented; testnet runs and a manually triggered mainnet redeem are recorded in STATUS. Production automation still needs monitoring |
| S5 | Independent seller supply | PARTIAL. No new independent-seller census performed in this update; historical CPU/GPU offers are recorded in STATUS, not proof of current availability |

### 3.3 Payments and settlement
| ID | Requirement | Status |
|---|---|---|
| P1 | USDG escrow, vouchers, withdraw delay, no oracle (prices are dollars) | Implemented on testnet and mainnet; first $1 mainnet smoke trade used a stub model, not production inference. Unaudited |
| P2 | Wallet connection, balances, network switching and test mint | PARTIAL. Public app and owner funding use the genuine Reown AppKit bundle; project ID/domain allowlist required. Browser-tested with an injected test provider, not a real wallet extension or phone QR pairing |
| P3 | Visitor pay-per-use via browser session key (non-custodial; node only relays) | PARTIAL. Implemented and exercised on a local EVM with a test wallet. Deployment-dependent (`ELYRA_PUBLIC_PAY`), not newly exercised with real user funds |
| P4 | Mainnet | PARTIAL (capped beta). App-side per-wallet deposit cap (`maxDepositUsd`, default $20 USDG) is DONE and enforced by the seller credit gate, deposit API, session-pay gateway and wallet fund flow; the mainnet escrow and registry are deployed (2026-11-07, first $1 trade in `docs/STATUS.md`) but still need a professional audit; on real networks the stricter of the cap and `ELYRA_MAINNET_DEPOSIT_CAP_USD` applies |
| P5 | x402 (HTTP 402 payments, no account) | NOT DONE. Not started. USDG has no `transferWithAuthorization` (EIP-3009) per a bytecode scan, so the `exact` scheme cannot use it; `upto` needs our own Permit2 proxy contract; `exact` with USDC on Base is the shorter path but adds a second chain |
| P6 | Open contract findings | F3 (a consumer can drain a deposit through a second address) documented limitation; F11, F14-F17 low severity |

### 3.4 Privacy and TEE
| ID | Requirement | Status |
|---|---|---|
| T1 | Sealed transport (hides prompts from the network) | DONE |
| T2 | TEE-verified sellers (attestation checked against the buyer's pinned image list) | PARTIAL. Verifier written and tested against a simulated Google token (47 tests). **Never run with real TEE hardware.** A rented GPU box means its owner can read prompts |

### 3.5 Scale of the catalogue
| ID | Requirement | Status |
|---|---|---|
| C1 | 600+ models from 150+ providers | NOT DONE as peers. Today: 1 live provider on the live market (`llama3.2:1b`, 1 vendor; 5 unique models across 3 vendors configured when the remote GPU tunnel and remembered peer are online). Measured via `tools/catalog-stats.mjs` against OpenRouter's public `/api/v1/models` list (`460` raw entries across `69` raw prefixes): **339 unique canonical models from 57 vendors** (after excluding 9 meta-routers and 19 moving `~` aliases, and collapsing 82 `:batch`/`:free` tier variants, 1 `-chat` variant, 10 redundant date pins, and 2 duplicate vendor prefixes), all labelled `hosted` (`HOSTED · CLEAR`), not P2P |

### 3.6 Control panel and public page
| ID | Requirement | Status |
|---|---|---|
| U1 | Owner console: dashboard, Private Live, Playground, Models, Routing, Network, Payments, Provide, Sources | Implemented; SaaS shell, dark/light themes, mobile drawer, owner-only usage and controls. Remote wallet users remain excluded from owner APIs |
| U2 | Public Market / Playground / Sell with wallet and optional paid sessions | Implemented. Real reachable offers only; hosted free quota, own-node use and paid peer sessions have separate flows; review paid offers before funding |
| U3 | Shared product language and responsive styling | Implemented; current system fonts, rounded cards and dark/light tokens. Public CSS is separate because owner CSS is behind authentication |
| U5 | SIWE sign-in, username profile and account menu | Implemented through one `/auth/*` system with admin/user roles; optional username/chat gate. No invented hosted account balance or API-key management |
| U4 | Docs for users (quickstart, provider, wallet, concepts, FAQ) | DONE. End-user docs (`README`, `QUICKSTART`, `PROVIDER`, `WALLET`, `FAQ`, `CONCEPTS`, `OLLAMA`, `PANEL`, `USAGE`, `API`) updated with pay-per-use browser session keys, hosted-vs-P2P rules, TEE limits, `$20` deposit cap and catalog stats; stale numbers removed from `docs/STATUS.md`; `tools/pages/docs.mjs` link-rewriter bug fixed; `dist/` built with 0 broken links/anchors across 1,082 internal links and 148 Markdown links (`router/test/docs.test.mjs`) |

### 3.7 Operations
| ID | Requirement | Status |
|---|---|---|
| O1 | Live node as hardened systemd service, daily backup (restore-tested on spare port), `/healthz`, `/metrics` | DONE |
| O2 | Repository and license | Repository exists; Elyra code is MIT, third-party assets have separate terms (`THIRD_PARTY.md`). Current visibility was not rechecked in this UI update |
| O3 | Alerts, load test, admin 2FA, secret rotation | PARTIAL. Alerts and local abuse tests exist; independent security review, operator credential rotation and production monitoring remain necessary |
| O4 | CI | Workflow and local regression suite exist. No new hosted GitHub Actions result was checked in this update |

## 4. Non-functional requirements

- **Security**: no secret in repo or logs; loopback-only control API; every public input bounded (size, rate, concurrency); public routes closed to cross-site pages; a payment path that cannot sign more than the visitor accepted. Verified by mutation tests (a deliberately broken rule must fail a test).
- **Honesty of the UI**: no simulated data on the public page, no "first" claims, hosted never labelled P2P.
- **Footprint**: one runtime dependency; panel and public page need no build; wallet bundles are dev-only and checksummed.
- **Mobile**: no horizontal overflow at 390 px on the public page and panel.

## 5. UI specification: what is different between the panel and the public page

Both surfaces use system sans-serif fonts, dark/light themes, rounded cards and explicit connection/sign-in/funding steps. They do not share permissions.

| Area | Owner console | Public app |
|---|---|---|
| Navigation | Workspace sidebar, command palette, dashboard, source and payment settings | Market, Playground, Sell and an account menu |
| Data | This node's sources, usage, receipts and private Live activity; demo catalog labelled SIM | Reachable real offers; no fabricated sellers, balances or network totals |
| Chat | Full node Playground with routing preview | Full-page free-quota Playground; optional paid browser session |
| Wallet | Reown picker for owner funding; SIWE or token for remote owner access | Reown picker for connection; SIWE for identity; separate approval/deposit for payment |

Reown connection is unavailable until `ELYRA_REOWN_PROJECT_ID` and its domain allowlist are configured. The genuine SDK modal is not a locally drawn imitation. Controlled demo fixtures may be used for screenshots and QA, but are not presented as live supply or real financial state.

## 6. Commands

```
npm ci --omit=dev          # runtime
npm test                   # all router tests (local EVM cases need: npm run chain:install)
npm start                  # http://localhost:8545/  (panel /app/, API /v1)
node tools/wallet/build-session.mjs   # rebuild the session-key bundle (dev)
```
Deploy to the VPS and the website follow `docs/VPS.md` and `docs/DEPLOY-CLOUDFLARE.md`.

## 7. Open questions and next order

Remaining production work:
1. Rotate previously exposed operator credentials and verify backup recovery.
2. Configure the Reown project and domain, then exercise a real wallet extension and phone QR session over HTTPS.
3. Verify the rented GPU's model availability and an independently operated seller on a separate network.
4. Review browser-session funding, voucher signing, recovery and withdrawal with real wallets and bounded amounts.
5. Obtain an independent review of auth and escrow/registry contracts; mainnet is already a capped, unaudited beta, not a readiness certificate.
6. Run a real TEE attestation (M1) when hardware/cloud access is available. Normal GPU rental is not TEE.
7. Add x402, a global indexer, native staking/rewards, or desktop packaging only as separately implemented features, not copied reference UI.
