# Elyra — Product Requirements

Status: living document. Owner: product. Last reviewed: 2026-11-04. Implementation truth is in `docs/STATUS.md`; this file is intent.

## 1. Problem

AI access today runs through platforms: you hold an account, a balance and a key with an aggregator or a model vendor. The platform sees your prompts, sets the price, takes a margin, and can cut you off. People with idle GPUs or spare API quota cannot sell it without being absorbed into somebody's platform. "Private" AI today almost always means *local only* (one model, one machine) or a *trust-me* hosted service.

## 2. Product

Elyra is a peer-to-peer network for AI inference that removes the middleman between users and model providers.

- **Consumer side**: run a self-hosted **Virtual Private Router (VPR)**. Point existing OpenAI-compatible tools at `localhost`. The VPR routes every request to the best peer among 600+ models / 150+ providers by **price, speed, reputation or privacy**.
- **Payment**: usage settles **on-chain, directly to the provider**. No platform balance, no markup.
- **Privacy**: **TEE-verified** peers keep prompts private from the operator.
- **Supply side**: anyone can provide capacity and earn, **no approval, no lock-in**.

Positioning line: *Inference should be a market, not a platform.*

## 3. Users (two roles, one node)

Every node can be **buyer**, **seller**, or both. Buyer = points tools at localhost, funds an escrow, routes by policy (Playground, Models, Routing, Connect, Payments). Seller = connects a model source, sets a price, turns Provide on, stays reachable and keeps a little ETH for gas (Provide → Earnings). The Overview onboarding checklist has an **I BUY / I SELL** switch.


| User | Job | Success |
|---|---|---|
| Developer / power user | Use Cursor, aider, LangChain etc. without vendor accounts; cut cost | Change one base URL; `auto:cheapest` works; bill is per-token receipts |
| Provider (GPU or API owner) | Monetise idle capacity | Toggle on, set a price, see earnings; can leave any time |
| Privacy-sensitive team | Keep prompts away from platforms | `auto:private` never routes to a clear peer; local-first |
| Agent / autonomous software | Buy inference per request, cheapest healthy peer | Programmatic, key-less, failover |

## 4. Prior art (be honest about it)

See `docs/LANDSCAPE.md` (2026-11-06) for the fuller competitor table and reusable repos. Short version: **Morpheus** already ships almost this exact architecture (consumer/provider proxy-router, on-chain registry on Base, TEE tag); **Chutes, Phala, NEAR AI** lead on TEE; **OpenRouter** on catalogue/UX. An independent tracker (deai.org, 2026-11-02) found 0 of 17 decentralized inference providers verified for TEE claims.


Checked with web search on 2026-11-04: **Morpheus (Lumerin node)** runs a local proxy-router, providers register models on-chain, sessions on Arbitrum, consumers use a local app or API gateway. **Inferit** pitches "the peer-to-peer market for AI inference": anyone sells inference at their own price, agents buy per request from the cheapest healthy seller (testnet at time of reading). From memory, not re-verified this session: Bittensor (subnet incentive network), Akash (generic compute market), Atoma (TEE-verified inference), Petals (swarm inference), OpenRouter / Together (centralised aggregators, the "middleman" we replace), Ollama / LM Studio (local only).

So the *category* exists and is early. Elyra is not claiming to be first. Differentiation we commit to:

1. **Policy router as the product**: one local endpoint, four-weight policy plus `auto:*` shorthands, ranked explanation of every decision ("why this route").
2. **Bring any upstream, sell any upstream**: Ollama/LM Studio/any OpenAI-compatible API on both the consume and provide side, no token or chain required to start.
3. **Receipts first**: every answer carries a provider-signed receipt; the ledger is derived from receipts and verified before it is accepted.
4. **Honest labelling**: simulated, claimed, verified are different states and the UI never blurs them.

### Elyra vs OpenRouter (the usual question)

OpenRouter is a **centralised aggregator**: one company holds your account, balance and key, sees your prompts, sets the markup and routes to a list of upstream vendors it contracts with. Elyra removes that middle layer: the router runs on your machine, sellers are independent peers, and money moves buyer → escrow → seller by signed vouchers. **It does not replace OpenRouter today.** OpenRouter has vendor contracts, reliability and hundreds of frontier models; Elyra's open network has to earn supply first. Until then OpenRouter is just another *source* you can plug in under Connect (shown as `HOSTED · CLEAR`, not private, still a middleman). Where Elyra can win: cheaper open-weight models from independent GPUs, privacy (local or TEE-backed sellers), no account/lock-in, and sellers earning without approval. It only matters if enough sellers show up, which is a go-to-market problem more than a code problem.

## 5. Scope

### In scope for v0.1 (built)
- OpenAI-compatible `/v1/models`, `/v1/chat/completions` (JSON and SSE), failover to 2 more candidates before first byte.
- Policy engine: weights, TEE-only, max price, `auto`, `auto:cheapest|fastest|best|private`.
- Peer protocol over HTTP: hello/gossip, signed receipts, price-quote enforcement, concurrency cap.
- Control panel: Overview, Playground (with route preview), Models, Routing, Network (topology), Payments, Provide, Connect.
- Upstreams: add/detect OpenAI-compatible sources; provider offers a chosen subset at a chosen price.
- Simulated testnet ledger with batch settlement; simulated demo market (clearly labelled).
- Landing page rewritten to this narrative.

### Built in 0.2.0
- Settlement in **USDG on Robinhood Chain** via escrow + signed vouchers (verified on a local EVM; chain ids and live RPC reachability verified; escrow and registry deployed on testnet and, as a capped beta, on mainnet), sealed peer transport, token-inflation audit, gossip SSRF guard.

### Not built yet (do not imply otherwise)
- Contracts deployed and exercised on Robinhood testnet/mainnet, contract audit.
- TEE remote-attestation verification. Today: self-declared `claimed`.
- Internet-scale discovery (DHT / bootstrap nodes), NAT traversal, prompt encryption to *enclave-bound* keys (sealed transport to node keys exists).
- Reputation beyond local success/failure counts; sybil resistance; slashing.
- Non-chat endpoints (embeddings, images), tool-call–aware billing, per-input vs per-output pricing.
- Installer / packaged binary.

## 6. Requirements (acceptance)

R1. A tool configured only with `OPENAI_BASE_URL=http://localhost:8545/v1` completes a chat request, streaming or not.
R2. With two nodes, node A routes to node B; A's ledger debit equals B's credit equals `price × tokens`; receipt signature verifies. In chain mode the provider's redeem pays exactly the voucher amount on the escrow contract.
R3. A provider raising its price after being quoted cannot be charged the higher price.
R4. `teeOnly` / `auto:private` never routes to a clear (non-private) peer; it fails closed.
R5. The control API is unreachable from other origins, other hosts and other machines.
R6. No prompt or completion text is persisted by the router.
R7. Every simulated or unverified element is labelled in UI and API (`simulated`, `tee: demo|claimed`).
R8. A user with Ollama installed can route to it with zero configuration beyond "Detect local".

## 7. Principles

Local first. Receipts over trust. No account anywhere. Boring tech (Node stdlib, vanilla JS). Say what is simulated.

## 8. Metrics (once real network exists)

Time to first routed request < 5 min; share of requests served by live (non-simulated) peers; failover rate; median provider payout latency; number of independent providers online; p95 added routing latency < 50 ms over direct.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Provider can lie about tokens | Receipt includes counts; reputation + consumer-side estimate cross-check (planned); disputes need channel design |
| TEE claims are unverifiable today | Labelled `CLAIMED`; verification is a roadmap gate before any "verified" wording |
| Providers see prompts when not in TEE | UI marks `CLEAR`; local-first scoring; `auto:private` |
| Sybil / fake reputation | Out of scope v0.1; planned stake or paid-history weighting |
| Abuse of open `/p2p/infer` | Concurrency cap, body limit, price enforcement; rate limits and allow/deny lists planned |
| Legal/compliance of reselling API access | Provider's responsibility; surfaced as "bridge" kind; ToS note needed before public launch |
