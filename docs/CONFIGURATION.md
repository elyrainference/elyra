# Configuration

Source of truth: `router/server.mjs`. If this page and the code disagree, the code wins; please fix the page.

## CLI flags

```
node router/server.mjs [--port 8545] [--host 127.0.0.1] [--data .elyra] [--name NAME]
                       [--public-url URL] [--seed URL]... [--no-demo]
                       [--allow-mainnet] [--allow-private-peers]
```

| Flag | Default | Meaning |
|---|---|---|
| `--port` | `8545` | Listen port |
| `--host` | `127.0.0.1` | Bind address. Keep loopback; expose only `/p2p/*` through a reverse proxy |
| `--data` | `<repo>/.elyra` | Identity, wallet (private key), state. Never commit, never serve |
| `--name` | generated | Node display name |
| `--public-url` | none | URL peers use to reach `/p2p/*` (also `ELYRA_PUBLIC_URL`) |
| `--relay` | none | Relay to dial out to when this node has no public URL; peers then reach it at `<relay>/r/<id>` (also `ELYRA_RELAY_URL`). Ignored when a public URL is set |
| `--seed URL` | none | Peer to add at boot; repeatable |
| `--no-demo` | demo on | Remove the simulated market. Use on any real node |
| `--allow-mainnet` | off | Permit Robinhood **mainnet** (real funds) |
| `--allow-private-peers` | off | Let gossip add private/LAN peer URLs (SSRF guard otherwise) |

## Environment variables

Read at boot. Useful for immutable deployments (systemd, containers, Confidential Space). In a TEE image each one is visible to buyers in the attestation token.

| Variable | Meaning |
|---|---|
| `ELYRA_PASSPHRASE` | Encrypt identity and wallet at rest (scrypt, AES-256-GCM). Missing or wrong passphrase on an encrypted dir: refuses to start |
| `ELYRA_NETWORK` | Chain network, e.g. `robinhood-testnet` (applied together with `ELYRA_ESCROW`) |
| `ELYRA_ESCROW` | Escrow contract address. Settlement is simulated until one is set; both sides must use the same escrow or there is no route |
| `ELYRA_UPSTREAM_URL` | OpenAI-compatible base URL of your model server, ending in `/v1` (Ollama: `http://127.0.0.1:11434/v1`) |
| `ELYRA_UPSTREAM_NAME` | Label for that upstream (default `local-model`) |
| `ELYRA_PROVIDE` | `1` to offer the upstream to the network |
| `ELYRA_PROVIDE_PRICE` | Your price in USD per million tokens |
| `ELYRA_MAX_DEPOSIT_USD` | Per-wallet escrow deposit cap in USDG (default `20`, `0 < x <= 10000`); seeds a fresh node and can be changed in **Provide** or via `PUT /api/provide` / `PUT /api/chain` |
| `ELYRA_PAYOUT` | Address that receives swept USDG. Without it earnings stay in the node wallet |
| `ELYRA_REOWN_PROJECT_ID` | Reown project id (32 hex characters, public). Enables the real AppKit picker on the public app and wallet funding on Payments. Add the deployed app origin to the project's allowed domains in Reown. Missing/invalid = unavailable, not a dummy connection; see [Wallet and USDG](WALLET.md) |
| `ELYRA_PUBLIC_URL` | Same as `--public-url` |
| `ELYRA_REFERENCE_PRICES` | `1` shows OpenRouter list prices next to the models of the public market page (one fetch of its public model list every 6 hours; off by default) |
| `ELYRA_RELAY_URL` | Same as `--relay`: sell from behind a home router, no port forwarding |
| `ELYRA_RELAY` | `1` makes this node a relay for other sellers (needs a public HTTPS address); serves `/relay/*` and `/r/<id>/p2p/*` |
| `ELYRA_REGISTRY` | Address of the `ElyraRegistry` contract (provider discovery, see [REGISTRY](REGISTRY.md); deployed addresses in [STATUS](STATUS.md)); with `ELYRA_NETWORK` selects the network when no escrow is set. Buyers then discover sellers on-chain unless discovery is off |
| `ELYRA_REGISTRY_BLOCK` | Block the registry was deployed at (printed by `deploy.mjs --registry` as `registryBlock`); where the first log read starts. Unset = block 0 (slow on a long-lived chain) |
| `ELYRA_REGISTRY_DISCOVER` | `0` turns registry discovery off (default on once a registry is set); `1` forces it on |
| `ELYRA_REGISTRY_ANNOUNCE` | `1` lists this seller on-chain (opt-in, costs gas from the node wallet; needs providing on, escrow + registry set and a public URL). Re-announced before the 7-day expiry |
| `ELYRA_REGISTRY_POLL_MS` | Registry read interval, 1000 to 600000 ms (default 30000). Mostly for tests |
| `ELYRA_MAINNET_DEPOSIT_CAP_USD` | Hard ceiling for the per-wallet deposit cap on a **real** network (default `20`). The effective cap there is the stricter of this and `ELYRA_MAX_DEPOSIT_USD` / `provide.maxDepositUsd`, so raising it on mainnet needs both. An invalid value never disables it; `0` blocks deposits |
| `ELYRA_SEEDS` | Comma-separated peer URLs to add at boot |
| `ELYRA_TEE`, `ELYRA_TEE_SOCKET` | TEE mode (Confidential Space); see [TEE](TEE.md). Verification is only proven against a simulated Google so far |
| `ELYRA_ADMIN_HOST` | Hostname (no scheme/port) that may reach the panel, `/api` and `/v1` **through a tunnel or proxy, behind a login**. Off unless set together with `ELYRA_ADMIN_TOKEN` and/or `ELYRA_ADMIN_ADDRESSES`. It is also the domain wallets sign for. See [REMOTE-ADMIN](REMOTE-ADMIN.md) and [AUTH](AUTH.md) |
| `ELYRA_ADMIN_TOKEN` | The login secret, at least 24 characters (generate 32+ random bytes). Never logged or returned by any endpoint. Optional when `ELYRA_ADMIN_ADDRESSES` is set (then there is no token login). A too-short token without any admin address, or a host with neither, disables remote admin and logs an error (fail closed) |
| `ELYRA_ADMIN_ADDRESSES` | Comma-separated `0x` wallet addresses (EOA) that get the **admin** role when they sign in with their wallet (Sign-In with Ethereum: no transaction, no gas). Compared case-insensitively; entries that are not addresses are ignored with a warning, so a typo locks that person out instead of letting anyone in. Any other address that signs in is a **user** (identity and a larger public quota, never the panel, `/api` or `/api/events`). See [AUTH](AUTH.md) |
| `ELYRA_GATEWAY` | `1` (needs the admin host) adds the username profile on top of the wallet sign-in: a signed-in wallet picks a name once (`GET/PUT /auth/username`) and `/pub/chat` then needs it (`401 signin_required`, `403 profile_required`; admin sessions are exempt). Profiles are stored in `accounts.json` in the data directory (encrypted with `ELYRA_PASSPHRASE` when set). Off by default. It is not a second sign-in and there are no `/gw/*` routes |
| `ELYRA_PUBLIC_PAY` | `1` (with `ELYRA_PUBLIC_TRY=1` and a settlement chain) lets visitors pay peer sellers per token from their own wallet, through a session key kept in their browser (`/pub/paid-chat`). The node relays and never holds funds or keys for them; deposits are held to the one deposit cap. Off by default |
| `ELYRA_PUBLIC_TRY` | `1` adds the public app for visitors who are not signed in, on the admin host only. See [Remote access](REMOTE-ADMIN.md#public-market-page-optional) |
| `ELYRA_TRY_MODEL` | Default model on the public page. If it is set and not available the page says offline; unset, the first local source is the default |
| `ELYRA_TEAM_PEERS` | Comma-separated peer ids or names you run yourself; the public market labels them "Elyra team", every other peer "Community" |
| `ELYRA_TRY_PER_IP_HOUR` | Requests per visitor (no wallet) per hour on the try page (default 20, 1 to 500) |
| `ELYRA_TRY_WALLET_PER_HOUR` | Requests per signed-in wallet address per hour (default 100, 1 to 2000). One IP address is also capped at 3 times this for wallet sign-ins, so minting wallets does not get around the limit. The daily cap still applies to everyone |
| `ELYRA_TRY_DAILY` | Requests per day for all visitors together (default 300) |
| `ELYRA_TRY_MAX_TOKENS` | Longest answer in tokens (default 256, 16 to 1024) |
| `ELYRA_TRY_CONCURRENCY` | Answers generated at the same time (default 2) |
| `ELYRA_ALLOW_TEST_TRUST` | Test only: `1` lets the control API accept an inline JWKS as the TEE trust list. Never set in production |

Settings that live in the panel or API rather than the environment: `spendCapUsdDay` (`PUT /api/settings`, Payments → Daily spend cap). It caps what paid outgoing requests may cost per rolling 24 hours (the sum of the ledger's spend entries). A paid route is skipped when today's spend, plus the worst-case cost of requests already in flight, plus this request's worst case (price × 1.05 × (estimated prompt tokens + `max_tokens`, at most 8192)) would pass the cap; if every route is skipped that way the answer is `402 spend_cap_reached` with how to raise it. Free and local routes are never limited. Default: no cap. Saved in `state.json`.

## Files and permissions

| Path | Content | Rule |
|---|---|---|
| `.elyra*/` or `--data` dir | `identity.json`, `wallet.json`, `state.json` | Back up; git-ignored; chmod to the service user only |
| `/etc/elyra/env` (server) | the variables above | `chmod 600`, owner root |

## Ports

| Port | Service | Exposure |
|---|---|---|
| 8545 | Elyra node | loopback; proxy only `/p2p/*` and `/healthz` |
| 11434 | Ollama | loopback only, never expose |
