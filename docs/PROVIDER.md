# Sell capacity (provider guide)

A node becomes a **provider** when it offers one or more local model sources to the network, reachable at a public HTTPS URL or through a relay, and is paid in USDG through the escrow. Buyer and seller are two views of the same node.

> **Honest status:** the pieces below are real and tested on the Robinhood **testnet** with the test token `MockUSDG` (paid trades settled on-chain at `0xe9dA82E45D8CbF84A633a0B0e46e12D2A9288092`, both through a Cloudflare tunnel and through the `/relay` + `/r/<id>` NAT relay, with multi-source selling, per-model pricing, and the $20 per-wallet deposit cap). The live node at `app.elyrainference.com` serves a real local model and has offered four GPU models over an SSH tunnel; a second independent seller on another operator's network has **not** joined yet, and mainnet is disabled. Read [SDD](SDD.md) and [STATUS](STATUS.md) first.

## What you need

| Need | Notes |
|---|---|
| A model source | Ollama on the same machine is the simple path: [OLLAMA](OLLAMA.md) |
| A way to be reached | Either a public HTTPS URL for `/p2p/*` (Caddy or a Cloudflare tunnel in front of the node), **or** a relay: start with `ELYRA_RELAY_URL=https://app.elyrainference.com` and no port forwarding is needed (see Behind a home router below) |
| Testnet ETH in the node wallet | Gas for redeeming vouchers; you pay it. Faucets are listed in Payments (login required, a human step) |
| A payout address | `ELYRA_PAYOUT`: where swept USDG goes. Without it earnings stay in the node wallet |
| Backups | The data dir holds identity and wallet; set `ELYRA_PASSPHRASE` and back it up |

## Steps

1. Install and run the node as a service: [INSTALL](INSTALL.md). Use `--no-demo` so no simulated peers appear.
2. Attach the model source (Connect → Detect local, or `ELYRA_UPSTREAM_URL`).
3. Expose **only** `/p2p/*` and `/healthz` over HTTPS:
   ```
   seller.example.com {
     @p2p path /p2p/* /healthz
     handle @p2p { reverse_proxy 127.0.0.1:8545 }
     respond 404
   }
   ```
   The panel text mentions `--host 0.0.0.0`; prefer this loopback + proxy layout. The node's own guard blocks `/api` and `/v1` from non-loopback, but do not rely on one guard.
4. Configure: `ELYRA_PUBLIC_URL`, `ELYRA_PROVIDE=1`, `ELYRA_PROVIDE_PRICE`, `ELYRA_PAYOUT`, `ELYRA_NETWORK`, `ELYRA_ESCROW` ([CONFIGURATION](CONFIGURATION.md)); or use the Provide view.
5. Fund the wallet with testnet ETH (address on Payments).
6. Verify from outside: `curl https://seller.example.com/p2p/hello` returns signed JSON listing your model; `curl -i https://seller.example.com/api/status` must return **404** (not data, not 403).
7. From a buyer node: Network → add `https://seller.example.com`; it should appear `LIVE` with your model. Deposit mock USDG, send a request, and check the receipt and an on-chain redeem (explorer link under Payments).

## How you are paid

1. The buyer's node sends a sealed, signed request; you answer and return a **signed receipt** (model, tokens, price, amount).
2. The buyer verifies it (signature, parties, price within 5% of the quote, amount = price x tokens, token count not inflated) **before** signing a cumulative **voucher**.
3. You redeem the latest voucher on-chain; the escrow pays you exactly that amount of USDG.

Money is USD per million tokens, rounded to 1e-8, settled in 6-decimal USDG: no oracle, no exchange rate. Gas is ETH.

## Risk controls (provider side)

| Control | Default | Why |
|---|---|---|
| `creditUsd` | $0.50 | A consumer can drain its own deposit through a second address (documented limitation F3), so you never serve more unpaid usage per wallet than you can lose, including the next request's worst case |
| `maxDepositUsd` | $20.00 | App-side per-wallet escrow cap while the contract is unaudited: refuses (`402 deposit_cap_exceeded`) any buyer wallet whose on-chain escrow deposit exceeds this limit before creating state or spending compute |
| `autoRedeem` / `autoRedeemUsd` | on / $0.25, plus a 60 s sweeper | Keeps unredeemed exposure small |
| On-chain deposit check | always, fail-closed | Before creating any state your node reads the wallet's deposit; if the RPC is down it answers 503 |
| `maxConcurrent`, `ratePerMin`, `deny` | 4, 120, none | Capacity and abuse limits |

On SIGTERM the node redeems what it holds (bounded to 20 s) before exiting.

## Privacy: what you can and cannot claim (TEE limits)

Sealed transport (`X25519 + AES-256-GCM`) encrypts prompts and completions in transit across the internet and through relays, **not** inside your machine. Buyers see one of four privacy labels for your seller node:

- **`CLEAR` (`tee: "none"`, default):** your machine decrypts the prompt to run the model, so as the operator you could inspect prompts in memory. Keep `tee` set to `"none"` on any normal server, home PC, or VPS.
- **`REMOTE` (`remote: true` on the model source):** your node forwards requests to another machine over an SSH tunnel or VPN (for example, a rented GPU box). Even when you sell via `All healthy local sources` (`upstreamId: "*"`), a source marked `remote` is never advertised as `LOCAL` or `TEE`, because the host of that remote machine can read prompts.
- **`CLAIMED` (`tee: "claimed"`):** a self-declared flag. Buyers see `CLAIMED` in the UI, and `teeOnly` / `auto:private` routing **ignores** it. Do not set it unless you are testing the label.
- **`TEE · VERIFIED` (`ELYRA_TEE=1` inside Google Confidential Space):** buyers mark you `VERIFIED` only when a hardware-backed OIDC attestation token from Google Confidential Space (AMD SEV-SNP or Intel TDX) binds your `{id, pub, box, wallet}` keys and matches a container `image_digest` pinned in **the buyer's own trust list** (empty list = nothing verifies).

**Current TEE limits:**
1. The attestation verifier is built and tested against simulated Google tokens, but **has not yet been run inside a real Google Confidential Space VM** (milestone M1 in [TEE](TEE.md)).
2. An ordinary VPS (KVM without guest SEV-SNP/TDX attestation) **cannot** run in TEE mode.
3. In TEE mode the node refuses non-local upstreams, so the model weights must live inside the attested container.
4. Without Cloud KMS key sealing (planned M3), a TEE node generates a fresh identity and wallet on every reboot; enable `autoRedeem` and set `ELYRA_PAYOUT` so redeemed USDG is swept to a permanent wallet after every batch.

## Hosted vs. peer-to-peer: what a seller can offer

The recommended seller path is **model servers you run yourself**, locally or through an SSH tunnel (Ollama, LM Studio, vLLM, llama.cpp).

- **Automatic selection is local-only:** `upstreamId: "*"` offers healthy, non-demo sources whose URL is local. Hosted APIs connected for personal routing are excluded from this automatic selection.
- **Explicit selection differs:** a healthy hosted source selected by `upstreamId` or `upstreamIds` can currently be offered. It is not private: the provider announcement forces `tee: "none"` for a non-local source, but does not include a separate hosted-origin field. Do not describe this as your own GPU capacity or promise that every buyer can identify its upstream from the listing. Check the upstream's resale terms.
- **Simulated catalog peers are not your capacity:** the `SIM` market is separate from seller offerings and never settled. The built-in demo engine can be explicitly selected on a demo node and carries a demo marker; it is not a real model.

## Serving browser pay-per-use buyers

When a public gateway node enables browser session payments (`ELYRA_PUBLIC_PAY=1`), visitors without their own node can buy from your seller node using a throwaway session wallet in their browser:

1. The gateway forwards the sealed request to your `/p2p/infer` endpoint with an EIP-191 `payer` binding signed by the visitor's session wallet.
2. Your node checks that the session wallet's on-chain escrow deposit is within `maxDepositUsd` (default **$20 USDG**) and covers `unpaid + worstCase <= creditUsd` before running the model.
3. You return the signed receipt as usual; the visitor's browser verifies the price and signs a cumulative EIP-712 voucher from the session wallet, which your node redeems on-chain identically to a node-to-node trade.

## Behind a home router: use a relay

A node that cannot accept inbound connections (home router, CGNAT, a laptop) can still sell. Start it with a relay address instead of a public URL:

```
ELYRA_RELAY_URL=https://app.elyrainference.com npm start -- --seed https://app.elyrainference.com
```

The node dials out to the relay and keeps one connection open. Buyers reach it at `<relay>/r/<your node id>`, which is the address it advertises; the relay forwards each request down your connection and streams your answer back. Nothing else changes: same prices, same vouchers, same payment straight to you.

- **What the relay sees:** the peer protocol seals both request and response to the seller's key, so a relay sees sizes, timing and buyer IPs, never prompts or answers. It cannot read, alter or forge them.
- **What a relay can ask of you:** only the three peer endpoints (`/p2p/hello`, `/p2p/infer`, `/p2p/voucher`). Your control API and OpenAI endpoint are never reachable through it, even from a hostile relay (this is tested).
- **Limits:** a relay serves at most 100 sellers, 8 requests in flight and 16 queued per seller, and answers 502 when your node has not polled for 5 seconds. Latency is one extra hop. A relay is a middleman for reachability, not for money.
- **Trust:** the relay can refuse to carry your traffic or go down; then buyers get "seller offline" and fall back to other sellers. Use your own public URL when you can: it is faster and has no extra hop. If both are set, the public URL wins.
- **Running a relay:** set `ELYRA_RELAY=1` on a node that has a public HTTPS address. Anyone's seller may then register, so run it on a machine you are happy to spend bandwidth on. Metric: `elyra_relay_jobs_total{outcome}`.

## Which models, and at what price

A node can offer models from **one source, several named sources, or all healthy local sources**. Ollama serves many models through a single address, and a node that has both a local CPU model and a remote GPU tunnel can offer both at once so the CPU model stays priced and on sale even while the GPU tunnel is offline.

In **Provide**, pick **All healthy local sources** (or a single source) under **Model source**, choose the models to offer (none selected means all across the chosen sources), and set a **default price**. Under **Price per model** you can give any model its own price; an empty field uses the default, and `0` is a valid price (free).

Over the API (`PUT /api/provide`):
- All healthy local and tunnel sources (never hosted API keys or the demo engine): `{"upstreamId": "*", "price": 0.1, "prices": {"llama3.2:1b": 0.02}}`
- Specific sources in priority order: `{"upstreamIds": ["up_gpu", "up_cpu"], "price": 0.5, "prices": {"llama3.2:1b": 0.02}}`
- A single source: `{"upstreamId": "up_gpu", "price": 0.5}`

Unhealthy sources (two failed health probes) are automatically left out of `/p2p/hello`, `/pub/market` and `/p2p/infer` until they answer again, while models from your remaining healthy sources stay on sale. Buyers see each model's own price in the market.

Buyers compare sellers by price, speed, reputation and privacy, so a bigger model can ask for more than a small one.

## Behind a home router: use a relay

A node that cannot accept inbound connections (home router, CGNAT, a laptop) can still sell. Start it with a relay address instead of a public URL:

```
ELYRA_RELAY_URL=https://app.elyrainference.com npm start -- --seed https://app.elyrainference.com
```

The node dials out to the relay and keeps one connection open. Buyers reach it at `<relay>/r/<your node id>`, which is the address it advertises; the relay forwards each request down your connection and streams your answer back. Nothing else changes: same prices, same vouchers, same payment straight to you.

- **What the relay sees:** the peer protocol seals both request and response to the seller's key, so a relay sees sizes, timing and buyer IPs, never prompts or answers. It cannot read, alter or forge them.
- **What a relay can ask of you:** only the three peer endpoints (`/p2p/hello`, `/p2p/infer`, `/p2p/voucher`). Your control API and OpenAI endpoint are never reachable through it, even from a hostile relay (this is tested).
- **Limits:** a relay serves at most 100 sellers, 8 requests in flight and 16 queued per seller, and answers 502 when your node has not polled for 5 seconds. Latency is one extra hop. A relay is a middleman for reachability, not for money.
- **Trust:** the relay can refuse to carry your traffic or go down; then buyers get "seller offline" and fall back to other sellers. Use your own public URL when you can: it is faster and has no extra hop. If both are set, the public URL wins.
- **Running a relay:** set `ELYRA_RELAY=1` on a node that has a public HTTPS address. Anyone's seller may then register, so run it on a machine you are happy to spend bandwidth on. Metric: `elyra_relay_jobs_total{outcome}`.

## Which models, and at what price

One node offers the models of **one model source**. Ollama serves many models through a single address, so pull as many as the machine can hold and offer them together. In **Provide**, pick the models to offer (none selected means all) and set a **default price**. Under **Price per model** you can give any model its own price; an empty field uses the default, and `0` is a valid price (free). Over the API: `PUT /api/provide` with `price` and `prices` (`{"model-id": usd_per_million_tokens}`). Buyers see each model's own price in the market.

Buyers compare sellers by price, speed, reputation and privacy, so a bigger model can ask for more than a small one.

## Pricing

Your price per MTok must exceed your cost per MTok actually served. Work it out before you set it: a rented GPU at $0.63 per hour that streams one answer at about 48 tokens/s produces roughly 0.17 million tokens an hour, which is about $3.6 per million tokens at full load for a single stream; several parallel requests lower that, but a price in cents per million tokens does not cover a rented GPU. On testnet the prices are only for trying the mechanism. Start on a machine you already own with a small model; rent a GPU only when a buyer exists. A 1B model on 8 CPU cores answered a short prompt in about 1 s warm but generates only about 1 token per second.

## Things that bite

- Gossip refuses private/LAN peer URLs unless `--allow-private-peers` (operator-typed peers are exempt).
- Both sides must use the **same escrow** or there is no route.
- Real USDG (mainnet) is unaudited territory: the escrow is unaudited and the USDG supply controller can burn from any address. Mainnet needs `--allow-mainnet` and your informed decision.
- Mock USDG is minted by anyone and has no value.
