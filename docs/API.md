# Control API reference

The panel's API. **Loopback only**: the request must come from a loopback address with a `localhost` or `127.0.0.1` Host header and (if present) a localhost Origin; anything else gets 403. Never proxy `/api/*` to a network. JSON in, JSON out; errors are `{"error":{"message":"..."}}` with a 4xx/5xx status.

Source of truth: `router/http/api.mjs` and `router/http/api-chain.mjs`. If this page and the code disagree, the code wins.

The OpenAI-compatible endpoint (`/v1/*`) is documented in [USAGE](USAGE.md); the peer protocol (`/p2p/*`) in [PROTOCOL](PROTOCOL.md).

Public wallet setup is separate from this control API. With the public app enabled, `GET /pub/info` includes `walletConnect: null` (not configured), or `{projectId, chainId, name, rpcUrl, explorer, real, iconUrl}` from the node's configured network preset and validated public Reown project ID. This does not expose node-wallet balances, secrets or custom authenticated RPC credentials and does not require an escrow. `GET /try/appkit.js` serves the same checksummed AppKit bundle as the owner funding view, without granting access to `/app/*` or `/api/*`.


```bash
API=http://localhost:8545
curl -s $API/api/status
```

## Node and market

| Method and path | Body | Returns |
|---|---|---|
| `GET /api/status` | | `node` (id, address, name, version, protocol, publicUrl, port, `dataDir` path, `encrypted` boolean: identity and wallet are encrypted at rest because `ELYRA_PASSPHRASE` is set; never the passphrase or any key), `endpoint`, `balance`, `spendCap` (`{usdDay, spentUsd}`: the daily spend cap or `null`, and what the ledger shows spent in the last 24 h), `stats` (24 h counters and 14-day series), `network` (peersLive, peersKnown, simPeers, models, listings, teeListings, liveListings, demoNetwork), `providing`, `tee`, `policy` |
| `GET /api/models?q=text` | | `{models:[...]}` every listing with score; `q` filters by model, peer or vendor |
| `POST /api/route/preview` | `{model}` (default `auto`) | `{model, options: top 6 ranked, total}` |
| `GET /api/routes` | | `{routes:[...]}` last 60 routes, newest first. Metadata only: model, peer, token counts, amounts. **Never prompt text** |
| `PUT /api/settings` | `{demoNetwork?: bool, name?: string, spendCapUsdDay?: number\|null, registryDiscover?: bool, registryAnnounce?: bool}` | `{settings, name}` (`spendCapUsdDay`: dollars per rolling 24 h that paid outgoing requests may cost, `null` or `""` = no cap, `0` = block every paid route; a negative, non-finite or non-numeric value is `400` and nothing else in the request is applied. `registryDiscover`: read the on-chain registry for peers; `registryAnnounce`: list this seller on-chain, costs gas) |

## Policy

| | |
|---|---|
| `GET /api/policy` | `{weights:{price,speed,reputation,privacy}, teeOnly, maxPrice}` |
| `PUT /api/policy` | any of `weights` (normalised), `teeOnly` (bool), `maxPrice` (number, or `null`/`""` for no limit). Returns the stored policy |

## Peers and trust

| | |
|---|---|
| `GET /api/peers` | `{peers:[...]}` |
| `POST /api/peers` | `{url}`: fetches the peer's signed hello and adds it. 400 `cannot add peer: ...` on failure (protocol mismatch, unreachable, private URL without `--allow-private-peers`) |
| `DELETE /api/peers/:id` | `{ok:true}` |
| `POST /api/peers/refresh` | re-fetch all peers |
| `GET /api/trust` | `{allowedImages, allowedHw, issuer, audience}` |
| `PUT /api/trust` | `allowedImages`: array of `sha256:<64 hex>`; `allowedHw`: subset of `GCP_AMD_SEV`, `GCP_INTEL_TDX`; `jwksInline` is test-only and needs `ELYRA_ALLOW_TEST_TRUST=1` |

## Model sources (upstreams)

| | |
|---|---|
| `GET /api/upstreams` | `{upstreams:[{id,name,kind,baseUrl,hasKey,price,models,builtin,remote,health}]}` (keys are never returned, only `hasKey`). `health` is `{status:"up"|"down"|"unknown",checkedAt,ms,error}` from a probe every 15 s; a source is `down` after two failed probes and is then left out of routing and `/v1/models` |
| `POST /api/upstreams` | `{name, baseUrl}` required; `apiKey?`, `price?` (your cost, USD/MTok, default 0), `models?`, `remote?` (`true` when the URL is loopback or LAN but really another machine, for example an SSH tunnel: it is then labelled REMOTE and never counted as private). Without `models` the node lists them from `<baseUrl>/models` (400 if it cannot, or if the source reports none). In TEE mode only local sources are accepted |
| `GET /api/upstreams/detect` | `{found:[...]}` probes localhost for Ollama (11434), LM Studio (1234), 8000, 8080 |
| `POST /api/upstreams/:id/refresh` | re-discover models from the source |
| `DELETE /api/upstreams/:id` | remove (the built-in demo engine cannot be removed) |

## Providing

`GET /api/provide` returns the provider config plus `offered` (models actually offered) and `publicUrl`. `PUT /api/provide` accepts any of:

| Field | Rule |
|---|---|
| `enabled` | bool |
| `upstreamId` | id from `/api/upstreams`, or `"*"` for all healthy local/tunnel sources (excludes hosted API keys and the demo engine); changing it clears `models` |
| `upstreamIds` | array of ids from `/api/upstreams` (or `["*"]`) to offer models from several sources in priority order; changing it clears `models` |
| `models` | array of model ids; empty means all |
| `price` | USD per million tokens, finite and >= 0 |
| `prices` | `{modelId: usdPerMillionTokens}` per-model price overrides (`0` is valid; invalid/negative/null entries are dropped) |
| `tee` | `"none"` or `"claimed"` only. `claimed` is self-declared and never counts as verified |
| `maxConcurrent` | 1 to 64 (default 4) |
| `creditUsd` | max unredeemed USD per consumer wallet (default 0.5) |
| `maxDepositUsd` | max on-chain escrow deposit in USDG accepted per buyer wallet while the contract is unaudited (`0 < x <= 10000`, default 20) |
| `autoRedeem`, `autoRedeemUsd` | auto-redeem on/off and threshold (default 0.25) |
| `payout` | address that receives swept USDG, or `""` |
| `ratePerMin` | 1 to 10000 (default 120) |
| `deny` | array of node ids to refuse (max 500) |

## Ledger and settlement

| | |
|---|---|
| `GET /api/ledger` | `{balance, funded, address, chain, mode: "sim"\|"chain", entries, batches, stats}`. Receipt signatures are truncated |
| `POST /api/ledger/fund` | `{amount?}` adds simulated funds (default 10); simulated ledger only |
| `POST /api/ledger/settle` | settle outstanding vouchers; returns `{batches, failed}` |

## Chain (escrow, USDG)

| | |
|---|---|
| `GET /api/chain` | overview: configured network, escrow, token, balances, `maxDepositUsd` cap, faucets, explorer links |
| `PUT /api/chain` | `{network?, rpcUrl?, chainId?, escrow?, registry?, registryBlock?, maxDepositUsd?}`; `network` must be a known one, `escrow`/`registry` an address (registry = ElyraRegistry, `registryBlock` its deploy block), `maxDepositUsd` in `(0, 10000]` (the same cap as `PUT /api/provide`). Mainnet additionally needs the `--allow-mainnet` flag at boot |
| `GET /api/registry` | registry state: configured address, discover/announce switches, block cursor, last scan, last errors, this node's listing, entries and the ones still pending verification (with the reason) |
| `POST /api/registry/revoke` | unlist this node on-chain now (gas) |
| `POST /api/chain/mint` | `{usd}` 0 < usd <= 10000; **only works for the mock test token** |
| `POST /api/chain/deposit` | `{usd}` 0 < usd <= `maxDepositUsd` (default 20, cumulative `currentDeposit + usd <= maxDepositUsd`); approve + deposit into the escrow |
| `POST /api/chain/withdraw` | `{action: "request"\|"cancel"\|"execute", usd?}`; `execute` needs `usd`. 1-day delay, 7-day window |

Chain failures return 502 with `type: "chain_error"`.

## Live feed (owner only)

| | |
|---|---|
| `GET /api/events` | Server-Sent Events. Each message is one JSON object on a `data:` line with `id:` set to the event id; heartbeat comments (`: ping`) every 15 s. Without a resume point you get only what happens next; `Last-Event-ID` (what a browser sends when it reconnects) or `?since=<id>` replays newer events from the ring buffer first (an id from before a node restart replays what the ring holds). At most 8 streams at once (`429` beyond), and a stream ends after 30 minutes so the client reconnects and its session is checked again |
| `GET /api/events/recent` | `{events, lastId}`: the ring buffer (at most 200 events, oldest first) for the first paint of a page |

Like all of `/api`, the feed is for loopback or a signed-in **admin** (token or allow-listed wallet) on the admin host; a wallet **user** session and everyone signed out never reach it. It is kept in memory only (nothing is written to disk, a restart empties it) and holds metadata only: an event is built from a whitelist (`router/core/events.mjs`), so there is no field that could carry a prompt, a completion, a key, an API key or an IP address. Wallets and tx hashes are shortened (`0x1234…abcd`).

Every event has `id` (rises by one per event), `ts` (ms) and `kind`:

| `kind` | Fields |
|---|---|
| `request` | `role` (`buyer` or `seller`), `status` (`ok`, `error`, `refused`), `peer` (name; a buyer's node id prefix as `peer abc123` when you are the seller), `model`, `promptTokens`, `completionTokens`, `costUsd`, `ttftMs`, `latencyMs`, `simulated` (true for the demo market: never real, never settled), `reason` (why it was refused or failed: `spend_cap`, `unfunded`, `no_route`, `rate_limited`, `busy`, `payment_required`, `denied`, `no_model`, `price_mismatch`, `upstream_error`, ...), `counterparty` (the paying buyer's short wallet, only when you are the seller and settle on-chain) |
| `peer` | `state` (`online`, `offline`, `discovered`), `name`, `viaRegistry`, `rttMs` |
| `voucher` | `action` (`issued`, `received`, `redeemed`), `amountUsd`, `tx` (short, redeemed only), `counterparty` (short wallet), `peer` |
| `alert` | `code` (`spend_cap`, `low_gas`, `upstream_down`), `subject`, `capUsd`, `spentUsd` |

Repeated alerts (same code and subject) are folded to one per minute, and refused or failed requests from the same seller-side peer and reason to one per 5 seconds, so a flapping source or a stranger cannot fill the buffer.

```bash
curl -N $API/api/events                      # live
curl -N "$API/api/events?since=0"            # everything in the buffer, then live
```

## Operations endpoints

`GET /healthz` returns `{"ok":true,"version","protocol","node","uptime","peersOnline"}` and is safe to expose. `GET /metrics` (Prometheus, loopback only) never contains prompt text.
