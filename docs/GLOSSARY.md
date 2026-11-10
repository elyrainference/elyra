# Glossary

| Term | Meaning |
|---|---|
| **VPR** | Virtual Private Router: the node you run. Exposes an OpenAI-compatible endpoint on localhost and routes requests to peers |
| **Node** | One running VPR. Buyer and seller are two views of the same node |
| **Peer** | Another node you know by URL (added manually or learned by gossip) |
| **Upstream / model source** | An OpenAI-compatible server your node can call: Ollama, LM Studio, OpenAI, OpenRouter, ... |
| **Listing** | One model offered by one source at one price. `/api/models` lists them all |
| **Policy** | Weights (price, speed, reputation, privacy), `teeOnly` and `maxPrice` used to rank listings |
| **`auto`, `auto:*`** | Special model names. `auto` uses your stored policy; `auto:cheapest`, `:fastest`, `:best`, `:private` override the weights for one request |
| **Receipt** | A provider-signed record of one answer: model, tokens, price, amount. Records usage; moves no money |
| **Voucher** | A consumer-signed (EIP-712) promise of a cumulative amount to one provider. Moves money when redeemed |
| **Escrow** | `ElyraEscrow`: the contract holding consumers' USDG deposits and paying redeemed vouchers |
| **USDG** | A dollar stablecoin (ERC-20, 6 decimals). Real only on mainnet; the testnet uses our `MockUSDG` |
| **Robinhood Chain** | The Arbitrum Orbit L2 used for settlement. Testnet chain id 46630, mainnet 4663. Gas is ETH |
| **Sealed** | `/p2p/infer` bodies are encrypted to the provider's key (X25519 + AES-GCM); plaintext is refused |
| **Gossip** | Peers sharing the peers they know, after a signed hello |
| **TEE** | Trusted execution environment. Here: Google Confidential Space |
| **`CLAIMED`** | A seller says it is in a TEE. Unverified; ignored by private routing |
| **`VERIFIED`** | A Google-signed attestation passed your trust list. Proven only against a simulated Google so far |
| **Trust list** | Container image digests you accept as the official Elyra image |
| **`SIM` / `DEMO`** | Simulated catalog or demo engine data. Never settled, never real |
| **Loopback-only** | Reachable only from the same machine: `/api`, `/v1`, `/metrics` |
| **`creditUsd`** | Max unredeemed USD a provider will serve per consumer wallet |
| **MTok** | Million tokens. All prices are USD per MTok |
| **Protocol version** | `PROTOCOL` in `router/core/limits.mjs` (currently 3). Nodes on different versions refuse each other |
