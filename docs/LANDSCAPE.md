# Landscape: who is closest to the Elyra narrative, and what to reuse

Researched 2026-11-06 with web search/read (updated the same day with a second sweep: the table "Contributed-compute networks" below; descriptions are each project's own claims, traction not verified); items marked *(memory)* come from background knowledge and were not re-checked this session.

## Narrative to match
Peer-to-peer AI inference without a middleman: self-hosted router on localhost, route by price/speed/reputation/privacy, on-chain payment straight to providers, TEE-verified privacy, anyone can sell, no approval/lock-in.

## Closest products (no single "top 1": each covers part)

| Product | What it is | Overlap with Elyra | Gap / difference |
|---|---|---|---|
| **Morpheus (Lumerin node)** — nodedocs.mor.org, repo `MorpheusAIs/Morpheus-Lumerin-Node` | Decentralized inference marketplace. Consumer *and* provider run the same `proxy-router` binary (TCP :3333 public for sessions, local HTTP API :8082, Electron UI + CLI). Provider/model/bid/session records on-chain (Diamond contract on Base), MOR staked into a **session** that is closed/claimed; prompts flow peer-to-peer, never through a Morpheus server. Rating config (uptime, TTFT, throughput, success rate, stake) biases routing; models can carry a `tee` tag; TEE-only SecretVM endpoint serves TDX attestation on :29343. Has a hosted API gateway and a resale-provider path (re-sell Venice/OpenAI access). | **Same architecture and narrative, already shipped.** This is the real incumbent to study. | MOR token/staking model, session-based (time) pricing, attestation checking is by the app/provider rather than a buyer-pinned image digest; heavier install. Elyra's bets: per-token USDG vouchers (no native token), receipts, buyer-pinned attestation policy. |
| **OpenRouter** *(memory + earlier discussion)* | Centralised aggregator: one account, balance, key, markup. | Best catalogue and UX for "one endpoint, many models". | The middleman Elyra removes; no P2P, no privacy beyond policy. Useful as a *hosted source*, not a peer. |
| **Chutes** (Bittensor SN64) — chutes.ai/tee | Permissionless serverless GPU "chutes"; models flagged `confidential_compute: true` run in TEEs; also feeds other gateways (e.g. SayGM). | TEE inference at real scale, permissionless suppliers. | Validator/subnet economics (TAO), account+API-key model, not a local router; consumers trust the platform's attestation flow. |
| **Phala Cloud / dstack** — phala.com, docs.phala.com, `Dstack-TEE/dstack` *(repo name from memory)* | Confidential VMs on Intel TDX + NVIDIA confidential-computing GPUs, Docker-compose deploy, OpenAI-compatible "private AI" API, attestation quote/report endpoints. | The most direct **supplier of TEE capacity** Elyra sellers could run on (or buy from); open-source TEE app framework. | A cloud, not a marketplace network; verification of its quotes needs a TDX/DCAP verifier (not built in Elyra yet, see roadmap M4). |
| **NEAR AI Cloud** — docs.near.ai/cloud/verification/gateway | Private inference with gateway **and** model attestation reports verifiable against Intel's attestation service. | A good reference for *what to verify and show users* (gateway + model attestation). | Single-operator cloud. |
| **OpenGradient tee-gateway** — `OpenGradient/tee-gateway` | LLM routing node inside an AWS Nitro Enclave with verifiable responses. | Nitro-based second platform reference (our M4). | Node software for their network, not a P2P router. |
| **Atoma, Oasis, SolRouter, Targon** *(Targon/Oasis/SolRouter listed by deai.org; Atoma from memory)* | Other TEE-flavoured inference networks. | Same space. | Not studied in depth. |

**Independent signal:** deai.org's *Decentralized Inference Provider Tracker* (sweep 2026-11-02) lists **17 providers, 7 claiming TEE, 0/17 verified or partially verified**. Nobody is yet credited with *client-verifiable* confidential inference. That is the open niche Elyra's buyer-pinned attestation targets, and also the proof burden: ship M1 (a real token verified end to end) before saying it.

## Contributed-compute networks (second sweep, 2026-11-06)

The assumption "everything out there is local or private LLMs, nobody does peer-to-peer contribution" is wrong: this category exists and is crowded. Self-descriptions from each site, not verified:

| Project | Model | Payment | Notes |
|---|---|---|---|
| **Morpheus** (above) | Same node binary for consumer and provider, on-chain marketplace on Base | MOR, per second of session | Closest architecture |
| **OpenMayhem** (Trac Systems) | P2P marketplace, requesters and providers, price/speed/protection limits, signed co-signed receipt per request, price locked at request start | Card or crypto; provider gets 85% on card | Very close feature set; shows an illustrative simulated market; T3 tier claims confidential computing |
| **Swan Inference** | One API over independent GPU providers | Pay per token; on-chain USDC settlement | Publishes 14 providers, 2.1M requests, 158 users |
| **Inference.net** | Distributed GPU network, operators run node software | Operators earn USDC | |
| **Atoma** | Permissionless execution nodes, TEEs, sampling-consensus verification | Sui | Marketplace by cost/performance/privacy |
| **Parallax** | BitTorrent-style pooling of consumer GPUs, pipeline sharding, commit-reveal verification | Credits (utility token) | Runs big models across peers |
| **Senda** | Mesh of volunteer machines, capability-aware router | Credits and "Peer USD", USDC withdrawal | Early access |
| **mycellm** | P2P over QUIC, Ed25519 receipts, private networks, federation | Credits, no blockchain | iOS app serves inference |
| **Gaia (GaiaNet)** | Nodes grouped under operator "domains", ETH-address node ids | Domain escrow contract, stablecoin | Agent/knowledge-base focus |
| **c0mpute**, **GGRID** | Contributor GPUs behind a thin orchestrator | Solana tokens | Orchestrator-coordinated |
| **uPeer** | Idle devices, sharded and encrypted jobs | Own token | |
| **Petals**, **exo** *(memory)* | Swarm / local-cluster inference | None | Earlier generation |

**What this means for Elyra.** The idea is not new and not empty. What the sweep does not show: a router that runs on the user's own machine and is **identical** for buying and selling, **per-token stablecoin vouchers (no token needed to pay)**, and **buyer-pinned attestation**. Several rivals have one of these; none was seen with all. That is a narrow wedge, and supply (providers and their uptime) decides the outcome, not features. Do not claim "first" anywhere on the site.

## Honest read of the competition
- If the question is "who already matches the narrative?": **Morpheus** (architecture + marketplace + on-chain settlement), other local-gateway marketplaces, and, for TEE depth, **Chutes/Phala/NEAR AI**. Stablecoin settlement and buyer-side verification are not sufficient evidence of uniqueness; compare implemented behaviour, not slogans.
- Being second to Morpheus means the product must win on something concrete: stablecoin-only payments, receipts and vouchers, buyer-controlled trust anchors, simpler install, honest labelling. Supply (sellers) decides the outcome far more than code.

## Repos worth reusing or studying

| Need | Repo | Why |
|---|---|---|
| Marketplace design reference (provider/model/bid/session, rating weights) | `MorpheusAIs/Morpheus-Lumerin-Node` (+ docs `nodedocs.mor.org/reference/rating-config`) | Mature version of our router + registry idea; copy the reputation signals (uptime, TTFT, throughput, success) |
| Intel TDX/SGX quote verification | `intel/confidential-computing.tee.dcap.qvl` (official quote verification library); Phala's `dcap-qvl` *(memory)* | Needed to verify raw TDX quotes so sellers are not tied to Google (M4) |
| Multi-TEE quote processing service | `proofofcloud/trust-server` (Node service validating Intel SGX/TDX and AMD SEV-SNP quotes, issuing signed JWTs) | Reference/possible dependency for a verifier service |
| Nitro Enclave inference gateway | `OpenGradient/tee-gateway` | Second platform (AWS Nitro) reference |
| TEE app framework / CVM deploy | dstack (`Dstack-TEE/dstack`, *memory*) | Seller packaging on TDX + GPU CC without hand-rolling Confidential Space |
| NVIDIA GPU attestation | `NVIDIA/nvtrust` *(memory)* | GPU confidential-computing claims (our `nvidia_gpu.*` TODO) |
| OpenAI-compatible gateway/router internals | LiteLLM (docs.litellm.ai), `agentstation/starport`, `ansonism/LLMAPIGateway` | Provider adapters, streaming/usage edge cases, key handling: useful to harden our `exec` paths |
| Model serving inside a TEE image | llama.cpp `llama-server`, vLLM *(memory)* | See `deploy/tee/model-server.md` |
| Payment channels prior art | Raiden / statechannels-style unidirectional channels *(memory)* | Validate the voucher design before audit |
| Swarm/P2P inference without chain | Petals, exo *(memory)* | Different trust model (no payments), but peer discovery/NAT ideas |

Nothing above is a dependency today; Elyra still has one runtime dependency (`ethers`).
