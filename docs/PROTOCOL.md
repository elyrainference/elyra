# Peer protocol v3 (HTTP + JSON)

Experimental; breaking changes allowed until 1.0 (record them in `CHANGELOG.md`). v2 = sealed inference + wallet binding + vouchers.

**Versioning.** `PROTOCOL` (currently 3; 2 → 3 was the rename Solais → Elyra: wire strings, EIP-712 domain and TEE audience changed) is the `v` field of hello. A node refuses peers whose `v` differs ("peer speaks protocol v1, this node speaks v2: upgrade the older node"); every HTTP response carries `x-elyra-protocol`. Bump it on any wire-breaking change and record it in `CHANGELOG.md`.

## Identity and keys
- **Node key**: ed25519. `pub` = base64 SPKI DER. `id` = first 16 hex of SHA-256(pub DER). Signs hello bindings and receipts. Signatures are over canonical JSON (keys sorted recursively), base64.
- **Box key**: X25519, published in hello, signed by the node key: `box = { pub, sig: sign({id, box: pub}) }`.
- **Wallet**: secp256k1 (`.elyra/wallet.json`), bound to the node: `wallet = { address, sig: sign({id, wallet: address}) }`.

## `GET /p2p/hello`
```json
{ "v":3, "id":"…", "pub":"…", "name":"provider-b", "url":"http://host:8546", "providing":true,
  "models":[{"id":"llama3.2","price":0.07,"tee":"claimed","tps":95,"demo":true}],
  "box":{"pub":"…","sig":"…"}, "wallet":{"address":"0x…","sig":"…"},
  "chain":{"network":"robinhood-testnet","escrow":"0x…"} , "version":"0.2.0", "ts":0, "peers":["http://other:8545"] }
```
`chain` is `null` when the node settles in simulation. Consumers route only to providers with the **same** `chain.escrow` (both empty = sim). Receivers verify id/pub, box and wallet signatures. `price` = $/MTok for input+output tokens. `peers` ≤ 50 online URLs. Optional `attestation: {type:"gcp-confidential-space", token}` (Google OIDC JWT, ≤ 20 kB): the buyer verifies it against *its own* trust list with nonce = `sha256(canon({id,pub,box:box.pub,wallet:wallet.address|null}))`; the seller's `models[].tee` is only a claim and becomes `verified` on the buyer side only if the attestation passes.

## `POST /p2p/hello`
Body: sender hello. Receiver re-fetches `GET <url>/p2p/hello` itself. A URL learned this way (or by gossip) must resolve to a public address, else it is dropped (`--allow-private-peers` to relax). Operator-added peers (API/CLI) may be private.

## `POST /p2p/infer` (sealed only, authenticated)
Wire: `{ "from": "<consumerId>", "sealed": { "v":1, "epk":"<x25519 spki b64>", "ct":"<b64 iv‖ciphertext‖tag>" } }`.
Key = HKDF-SHA256(ECDH(ephemeral, provider box key), info `elyra-box-v1|epk`); AES-256-GCM, AAD `elyra-req` (request) / `elyra-res` (response), fresh 12-byte IV per message.
Requests are **authenticated**: `auth = {ts, nonce, sig}` where `sig = ed25519(consumer key)` over `{provider, ts, nonce, model, bodyHash=sha256(canon(body))}`; the provider rejects |now−ts| > 60 s and any reused nonce (401/409). Output is capped: the consumer sends `max_tokens ≤ 8192` and the provider clamps. Chain mode: `consumer.wallet` + `consumer.walletProof` (EIP-191 over `elyra-wallet-binding:<consumerId>:<wallet>`). Plaintext payload:
```json
{ "consumer":{"id","pub","wallet?","walletSig?"}, "model":"…", "maxPrice":0.0735,
  "body":{ "messages":[…], "stream":false }, "voucher":{"cumulative":"units","sig":"0x…"} | null }
```
Errors are plain JSON `{error:{type,message}}`: `400 unsealed|bad_envelope`, `402 payment_required`, `403 not_providing|denied`, `404 no_model`, `409 price_mismatch`, `429 busy|rate_limited`, `502 upstream_error`.
Success:
- Non-stream → `{ "enc": <seal({completion, receipt})> }`
- Stream → SSE, each event `event: enc\ndata: <seal({k:"frame",v:"<whole SSE event>"})>`, then `{k:"receipt",v:<Receipt>}`. `[DONE]` is never sent by the provider; the consumer emits it after verifying.

Provider checks (chain mode): consumer wallet bound to consumer key; voucher (if newer) verifies for (consumer wallet → provider wallet); unvouchered exposure `owedUnits − voucher.cumulative ≤ creditUsd` in token units; on-chain `deposit ≥ cumulative − claimed + exposure` (best effort; if RPC is down only the credit limit guards).

## Receipt
```json
{ "v":1,"id":"rc_…","provider":"<id>","consumer":"<id>","model":"…","promptTokens":7,"completionTokens":11,
  "price":2,"amount":0.000036,"ts":0,"tee":"claimed","nonce":"…","amountUnits":"36","providerWallet":"0x…","sig":"…" }
```
`amount = price × (prompt+completion) / 1e6` (1e-8 rounding). `amountUnits`/`providerWallet` only in chain mode: `amountUnits = round(amount × 10^decimals)` of the escrow token (USDG: 6 decimals). No exchange rate involved.
Consumer accepts only if: signature verifies with the hello `pub`; ids match; `price ≤ maxPrice`; `amount` recomputes; `completionTokens ≤ 3 × estimate(received text) + 32`; chain mode: `providerWallet` equals the hello wallet and `amountUnits ≤ own conversion + 1`. Rejection = failed route, no ledger entry, no voucher, reputation penalty.

## `POST /p2p/voucher` (sealed)
Wire `{from, sealed}`; sealed payload `{ consumer:{id,wallet,walletProof}, cumulative:"units", sig:"0x…" }` → `{accepted}` (402 without a valid wallet proof, 404 for a wallet this provider never served). Provider stores it only if it is higher than the current one and verifies. Vouchers also ride on the next infer request.

## Voucher (EIP-712)
Domain `{name:"ElyraEscrow", version:"1", chainId, verifyingContract}`, type `Voucher(address consumer,address provider,uint256 cumulative)`. `cumulative` is monotonic per (consumer, provider); signing a higher one supersedes lower ones. The provider redeems the highest via `redeem(consumer, cumulative, sig)`; the contract pays `min(cumulative − claimed, deposit)`.

## Registry announcement commitments
An `ElyraRegistry` entry (`docs/REGISTRY.md`) is only a claim; a buyer accepts it after fetching `GET <url>/p2p/hello` and checking, in addition to the normal hello verification:
- `nodeId` = `0x` + full SHA-256 (64 hex) of the hello's `pub` (SPKI DER); the 16-hex hello `id` is its prefix.
- `boxKey` = `0x` + SHA-256 of the hello's `box.pub` (SPKI DER bytes).
- the hello's signed `wallet.address` equals the announcing wallet (case-insensitive).
- `metaHash` = `0x` + SHA-256 (hex) of the canonical JSON (keys sorted, as for signatures) of `{ "t": "elyra-registry-meta-v1", "pub": hello.pub, "box": hello.box.pub, "wallet": <lowercase wallet address>, "url": <announced url, normalised origin or origin/r/<id>> }`. It commits to what the node key signs (identity, box key, wallet) plus the URL; models and prices are deliberately not committed (they change too often).
A mismatch in any of these rejects the entry; the URL also passes the public-host check like gossip.

## Escrow contract (`contracts/contracts/ElyraEscrow.sol`)
constructor(token); `deposit(amount)` / `depositFor(consumer, amount)` (ERC-20 `transferFrom`, balance-delta checked), `redeem(consumer,cumulative,sig)`, `requestWithdraw()` → 1 day → `withdraw(amount)`, `cancelWithdraw()`, views `deposits`, `claimed`, `withdrawAt`, `voucherDigest`, `domainSeparator`. No owner, no upgrade path.

## Local control API (loopback only)
`GET /api/status|models|peers|upstreams|upstreams/detect|ledger|routes|chain`, `PUT /api/policy|settings|provide|chain`, `POST /api/peers|peers/refresh|route/preview|upstreams|upstreams/:id/refresh|ledger/fund|ledger/settle|chain/deposit|chain/withdraw`, `DELETE /api/peers/:id|upstreams/:id`. In chain mode `ledger/settle` redeems vouchers and returns batches with real tx hashes; `ledger/fund` is refused.

Not in the protocol yet: attestation quote in hello, consumer-signed receipts, batching many consumers per redeem, stablecoin pricing.
