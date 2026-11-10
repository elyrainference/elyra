# Usage

The node exposes three surfaces. Only the third is meant for the network.

| Surface | Paths | Who can reach it |
|---|---|---|
| OpenAI-compatible | `/v1/models`, `/v1/chat/completions` | loopback only |
| Control API and panel | `/api/*`, `/app/` | loopback only |
| Peer protocol | `/p2p/*`, `/healthz` | the network (sealed, authenticated) |

`/metrics` (Prometheus) is loopback only. Loopback means: loopback peer address, a `localhost`/`127.0.0.1` Host header and, if present, a localhost Origin.

## Point your tools at Elyra

```bash
export OPENAI_BASE_URL=http://localhost:8545/v1
export OPENAI_API_KEY=anything          # not checked; the endpoint is local only
```

Works with any client that speaks Chat Completions. Implemented: `GET /v1/models`, `POST /v1/chat/completions` (JSON and SSE streaming). Not implemented: embeddings, images, audio, the Responses API, tools passthrough guarantees. Anything else returns 404 with a message saying so.

## Choosing a model or a policy

| `model` value | Meaning |
|---|---|
| `llama3.2:1b` (any listed id) | That model, best candidate by your stored policy |
| `auto` | Any model, stored policy weights |
| `auto:cheapest` | Weights: price 100 |
| `auto:fastest` | Weights: speed 100 |
| `auto:best` | Weights: reputation 80, speed 15, price 5 |
| `auto:private` | Weights: privacy 60, reputation 20, price 10, speed 10, plus `teeOnly` (local/LAN or a **VERIFIED** TEE only) |

**Live beats simulated.** Within one request, if any real listing (your own source, or a live peer) can serve it, only real listings are ranked; the simulated market answers only when nothing real can. So once you connect Ollama, `auto` and every `auto:*` go to it, never to canned demo text. A model that exists only in the simulated market is still reachable by name and is labelled `simulated: true`.

Default weights: price 40, speed 30, reputation 20, privacy 10, adjustable in the panel (Routing) or via `/api/policy`. `teeOnly` drops everything that is not local or verified-TEE and may leave no route; `maxPrice` is a hard ceiling. Up to 3 candidates are tried before the first byte arrives; there is no failover after the first byte of a stream.

## Reading the route

Every response carries headers and an `elyra` object:

```
x-elyra-route: self:SELF - ollama     x-elyra-model: llama3.2:1b
x-elyra-price: 0                      x-elyra-tee: none
x-elyra-simulated: false              x-elyra-protocol: 3
```

```json
"elyra": {"route":"self:SELF - ollama","model":"llama3.2:1b","price_per_mtok":0,"tee":"none","simulated":false,"failover":[]}
```

`simulated: true` means the answer came from the built-in demo market. Never treat it as real inference or settlement.

## Paying and getting paid (testnet)

Money is **USD per million tokens**. A consumer deposits USDG into `ElyraEscrow` (capped at **$20 USDG per wallet** by default while the contract is unaudited), signs cumulative EIP-712 vouchers for each provider, and the provider redeems the latest one. On the testnet the token is our open-mint `MockUSDG` (worthless, labelled MOCK). Panel → Payments handles network, mint (mock only), approve and deposit (from the node wallet or connected browser wallet), withdraw (1-day delay, 7-day window) and shows explorer links. Providers serve only within a per-wallet credit limit (default $0.50 unredeemed) and auto-redeem at $0.25.

Mainnet requires `--allow-mainnet`, real USDG, and an informed decision: the escrow is unaudited and the real USDG token can burn from any address through its supply controller (`contracts/rehearsal-mainnet-fork.md`).

## Control panel

`/app/` views: Overview (I buy / I sell checklists), Models, Routing, Playground, Connect (client snippets), Network (peers, trust list), Provide (sources, price, earnings), Payments (escrow).

## Operations

```bash
curl -s 127.0.0.1:8545/healthz     # {"ok":true,"version":"0.1.0","protocol":3,...}
curl -s 127.0.0.1:8545/metrics     # Prometheus, no prompt text
```

Logs are JSON lines. Prompts, completions, API keys and private keys are never logged.
