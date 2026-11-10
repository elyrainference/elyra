# How it works

Elyra is a router you run yourself, plus a way for strangers to pay each other for inference without a middleman. This page explains the moving parts in plain words. Precise formats are in [Peer protocol](PROTOCOL.md) and [Architecture](ARCHITECTURE.md).

## The router

A **VPR** (virtual private router) is one Node.js process on your machine. It exposes an OpenAI-compatible endpoint on `localhost` and decides, for every request, *where it runs*: on a model you attached (Ollama, LM Studio, any OpenAI-compatible server) or on a peer. Your tools never need to know which.

## Choosing where a request goes

The router ranks every listing that can serve the model you asked for, using four weights you control: **price**, **speed**, **reputation** and **privacy**. You can also set a hard price ceiling or require private peers only.

- **What reputation is made of.** From your own requests: the share that succeeded (smoothed, so one lucky or unlucky request does not decide), tokens per second, and for streamed answers the time to the first token. From the periodic probes of each peer (every 15 seconds): its uptime over about the last hour, shown after roughly five minutes of data. A peer that is often away is scored lower (full uptime keeps the score, none halves it); a new peer is not punished for having no data. All of this is measured by your router, never claimed by the seller, and the market shows "Not measured yet" instead of guessing.
- `auto` uses your stored weights. `auto:cheapest`, `auto:fastest`, `auto:best` and `auto:private` override them for one request.
- **Live beats simulated.** If anything real (your own source or a live peer) can serve a request, only real listings are ranked. The simulated market answers only when nothing real can.
- **Hosted vs. peer-to-peer.** If you attach a hosted API key (OpenRouter, OpenAI, Groq, Together) to your router, its models are ranked by their published per-model prices (never treated as free) and labelled `HOSTED · CLEAR`. They are paid off-chain to that provider, never re-shared with peers or listed on the public market, and excluded when you require private routing (`teeOnly` / `auto:private`).
- Up to three candidates are tried before the first byte arrives. There is no failover after a stream has started.

## Peers

A peer is another Elyra node you know by URL. Nodes introduce themselves with a signed *hello* (identity, encryption key, wallet, models, price) and learn about more peers by gossip. Prompts travel **sealed**: encrypted to the provider's key, so the network only sees ciphertext. The provider operator can still read them. Only a verified TEE removes that, and that is not proven on real hardware yet ([TEE verification](/docs/tee/)).

## Paying: receipts and vouchers

Two different objects, on purpose:

- A **receipt** is the provider's signed record of one answer: model, tokens, price, amount. It records usage and moves no money.
- A **voucher** is the consumer's signed promise (EIP-712) of a *cumulative* amount to one provider. It moves money when redeemed.

The consumer deposits **USDG** (a dollar stablecoin) into the **escrow** contract on **Robinhood Chain**. For each answer the consumer's node checks the receipt (signature, parties, price within 5% of the quote, amount equals price times tokens, token count not inflated) and only then signs a higher cumulative voucher. The provider redeems the latest voucher and the escrow pays it. Prices are dollars per million tokens, so there is no oracle and no exchange rate; gas is ETH.

A consumer can always drain its own deposit through a second address (a documented limitation), so providers protect themselves: they serve only within a small credit limit per wallet (`creditUsd`, default $0.50), refuse wallets whose escrow balance exceeds the per-wallet deposit cap (`maxDepositUsd`, default $20 USDG while the contract is unaudited; on mainnet the stricter of that and `ELYRA_MAINNET_DEPOSIT_CAP_USD`), and redeem often ([Sell capacity](/docs/provider/)). Visitors on a public node with `ELYRA_PUBLIC_PAY=1` can also pay peer sellers per token directly from their browser using a local session key ([Wallet and USDG](/docs/wallet/#pay-per-use-on-the-public-page-browser-session-key)).

## What each label means

- `SIM` / `DEMO`: simulated. Never real inference, never settled.
- `LIVE`: a real peer or your own source.
- `CLEAR`: the operator can read your prompt.
- `LOCAL`: your own machine or LAN.
- `CLAIMED`: a seller says it runs in a TEE. Unverified and ignored by private routing.
- `VERIFIED`: a Google-signed Confidential Space attestation passed your trust list. Proven only against a simulated Google so far.
- `MOCK`: the testnet token is our open-mint `MockUSDG` and has no value.

## Real versus simulated, today

- **Real and tested:** the router, sealed transport, receipts and vouchers, NAT relay (`/r/<id>`) for sellers behind home routers, multi-source selling with per-model prices, on-chain provider discovery (`ElyraRegistry`), the control panel (with a private Live feed, alerts and a daily spend cap) and the public Market / Playground / Sell app, settlement on Robinhood **testnet** with the test token and a first **$1 trade on mainnet** with real USDG (details in the status log), the **$20 USDG** per-wallet deposit cap, browser wallet funding and session-key pay-per-use (on a local chain), and an Ollama-backed node on a Linux server.
- **Not yet:** an independent audit of the escrow (mainnet is a capped beta; keep only what you can lose), TEE verification against a real Google Confidential Space VM (milestone M1), a real MetaMask/Rabby browser test on testnet, and a second independent seller on another network.
- A fresh node starts with a simulated demo market (labelled `SIM`) so the panel has something to show. `--no-demo` removes it.
- The live node at app.elyrainference.com answers from a real local model.

The requirement-by-requirement specification is in [SDD.md](SDD.md) and the verification log is in [STATUS.md](STATUS.md).

## The three surfaces

- **Local:** `/v1`, `/api` and the panel at `/app/`. Loopback only, unless you opt in to [remote admin](/docs/remote-admin/) (one hostname behind a login).
- **Network:** `/p2p/*` and `/healthz`. The only part meant for other machines.
- **Public website:** the landing page and these docs on Cloudflare Pages, plus a live node at app.elyrainference.com (try page for visitors, full panel behind a login).
