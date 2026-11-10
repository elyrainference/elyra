# FAQ and troubleshooting

## General

**What is Elyra?** A self-hosted router that sends your OpenAI-compatible requests to the best peer by price, speed, reputation or privacy, and pays providers per token on-chain. See the [README](../README.md).

**Is this production ready?** No. It is early: testnet, plus a capped mainnet beta (escrow and registry deployed on Robinhood mainnet, deposits capped at $20 per wallet by default). The escrow is unaudited, TEE verification is proven only against a simulated Google, and peer discovery is URLs, gossip and the on-chain registry. See [STATUS](STATUS.md) and [MAINNET](MAINNET.md).

**Is the market on the landing real?** No. "600+ models / 150+ providers" is a launch target. A fresh node shows a simulated demo market, always labelled `SIM`; use `--no-demo` to remove it. Real models are the ones your own sources and live peers provide.

**How do you count models and vendors?** You can measure any node or `/models` endpoint yourself with `npm run catalog:stats` (`node tools/catalog-stats.mjs --data .elyra` or `node tools/catalog-stats.mjs --openrouter --rules`). Our deduplication and classification rules (`tools/catalog-stats.mjs`) are explicit:
1. **Simulated and offline sources are excluded:** the built-in 29-model / 59-peer demo catalog (`SIM`) and unreachable sources (`OFFLINE`) never count as live supply and are reported separately.
2. **Meta-routers and moving `~` aliases are excluded:** aggregator auto-routers (`openrouter/auto`, `openrouter/free`, `router/auto`, or negative-priced routers like `typesafe/jev-router` and `nvidia/switchyard`) and moving alias pointers (`~vendor/*-latest`) route to other models rather than being distinct model weights.
3. **Billing and throughput tiers collapse; parameter sizes stay distinct:** `:free`, `:batch`, `:extended`, `:nitro`, `:floor`, `:online`, `:thinking` and `:latest` suffixes on `vendor/model:tier` IDs collapse to one model, while Ollama parameter-size tags (`llama3.2:1b` vs `llama3.2:3b`) stay separate and only quantisation suffixes (`-q4_K_M`, `-fp16`, `-bf16`) are stripped.
4. **Instruct/chat suffixes, cross-source open-weights names, and redundant date pins collapse:** trailing `-instruct`, `-chat` and `-it` tags are stripped; plain open-weights names (`llama3.2:1b` on Ollama and `meta-llama/llama-3.2-1b-instruct` on OpenRouter) map to the same canonical key (`meta/llama-3.2-1b`) while distills (`deepseek-r1:8b`) and fine-tunes stay separate; date-pinned snapshots (`openai/gpt-4o-2024-11-20`) collapse into their undated base model (`openai/gpt-4o`) when that base model is also listed.
5. **Vendor prefixes are normalized:** leading `~` markers are stripped and multi-prefix makers (`meta` + `meta-llama`, `bytedance` + `bytedance-seed`, `mistralai` + `mistral`, `x-ai` + `xai`, `moonshotai` + `moonshot`, `z-ai` + `zhipu`) count as one vendor; unslashed local names infer their maker from the family prefix.
6. **Hosted APIs are separated from P2P and local capacity:** today the live node (`app.elyrainference.com`) serves **1 live local model** (`llama3.2:1b`, **1 vendor**; **5 unique models across 3 vendors** when the remote GPU tunnel and remembered peer are online). Pointing a node at OpenRouter's public `/api/v1/models` list (`460` raw entries across `69` raw prefixes) yields **339 unique canonical models from 57 vendors** after excluding **9 meta-routers** and **19 moving `~` aliases** and collapsing **82 `:batch`/`:free` tier duplicates**, **1 `-chat` duplicate**, **10 redundant date snapshots**, and **2 duplicate vendor prefixes** — all counted under `hosted` (`HOSTED · CLEAR`), never peer-to-peer and never private/TEE.

**Can I try it without installing?** Yes: [app.elyrainference.com](https://app.elyrainference.com/) is a real node with a real model. Ask it something; the page shows which machine answered. It is rate-limited and uses a small model ([PANEL](PANEL.md#live-app-and-the-try-page)).

**Can I pay peer sellers from the browser without running a node?** Yes, when a public node enables browser session payments (`ELYRA_PUBLIC_PAY=1`). Your browser generates a local session key, you fund that session address from your wallet (`depositFor(sessionAddress)`, capped at **$20 USDG** per wallet by default while the contract is unaudited), and your browser verifies each seller receipt against the price you accepted before signing the cumulative EIP-712 voucher. The public node only relays messages and never holds your funds or session key, and browser withdrawals (`deposit - owed`) leave any signed-but-unredeemed seller vouchers covered. Today `ELYRA_PUBLIC_PAY` is verified end-to-end on a local chain with a simulated wallet and kept off on `app.elyrainference.com` while there is 1 live seller; see [Wallet and USDG](WALLET.md#pay-per-use-on-the-public-page-browser-session-key).

**What is the difference between a hosted source (like OpenRouter) and a peer-to-peer seller?**
- **Peer-to-peer seller (`LIVE`):** another Elyra node reached directly over HTTPS or through a NAT relay (`/r/<id>`). Prompts travel in a sealed `X25519 + AES-256-GCM` envelope, usage is recorded in an `ed25519`-signed receipt, payment settles per token on-chain in USDG straight to the seller through `ElyraEscrow`, and the seller can qualify for `TEE · VERIFIED` once its Confidential Space image digest is in your trust list.
- **Hosted source (`HOSTED · CLEAR`):** an ordinary OpenAI-compatible API key (OpenRouter, OpenAI, Groq, Together) that you attach to *your own* router under **Connect**. Hosted models are ranked by their published per-model prices (never treated as free), billed outside the chain by that company under your account, **never** re-shared with peers or listed on the public market, and **never** counted as peer-to-peer or private/TEE.
**Can the website control my node?** No. Your panel is `http://localhost:8545/app/`, an SSH tunnel for a remote node, or, if you opt in, your own hostname behind a login: [REMOTE-ADMIN](REMOTE-ADMIN.md).

**What does it cost?** Running your own model through your own node is free (price 0). Buying from a peer costs the peer's price per MTok, paid in USDG; on testnet that is free mock money.

**Are my prompts private? What are the limits of TEE today?**
- **Sealed transport (`X25519 + AES-256-GCM`)** hides prompts and completions from network observers and relays, **not** from the machine running the model.
- **`LOCAL`** (your own machine or LAN) is private because your prompt never leaves your hardware.
- **`REMOTE`** (a model on another machine reached over an SSH tunnel or VPN, such as a rented GPU) and **`HOSTED · CLEAR`** (OpenRouter, OpenAI) are **not** private: the remote host or API provider can read prompts.
- **`CLAIMED`** is a seller's self-declared flag and is ignored by `teeOnly` and `auto:private`.
- **`TEE · VERIFIED`** requires Google Confidential Space (AMD SEV-SNP or Intel TDX) where Google's signed attestation token binds `{id, pub, box, wallet}` and matches a container `image_digest` in **your** pinned trust list. **Current limits:** the verifier (`router/tee.mjs`) is built and tested against simulated Google tokens, but **has not yet been run inside a real Google Confidential Space VM** (milestone M1 in [TEE](TEE.md)); ordinary VPSs cannot produce hardware attestations; and without Cloud KMS (M3) a TEE node's identity and wallet reset on reboot. The router itself never logs prompts or completions.

**Is it OpenAI-compatible?** `GET /v1/models` and `POST /v1/chat/completions` (JSON and SSE). Not embeddings, images, audio or the Responses API.

## Install and run

**`npm start` says Node is too old.** Needs Node 20 or newer ([INSTALL](INSTALL.md)).

**The service fails immediately with `203/EXEC`.** `ExecStart` points to a `node` the `elyra` user cannot read (for example under `/root`). Install Node to `/opt/node`.

**It refuses to start: passphrase.** The data dir is encrypted and `ELYRA_PASSPHRASE` is missing or wrong. There is no recovery without it.

**`npm test` fails with "node did not start" or random failures.** The machine is busy. Boot can take 5 s or more under load; tests wait 30 s now. Run them on an idle machine.

**Port 8545 is in use.** `--port 8546` (and pass a different `--data` dir if running two nodes).

## Ollama and models

**`/v1/models` has no Ollama model.** Check `curl 127.0.0.1:11434/v1/models`. `ELYRA_UPSTREAM_URL` must end in `/v1`. Or Connect → Detect local.

**First request takes about a minute.** Ollama is loading the model into RAM. Warm requests take about a second on a 1B model.

**Out of memory.** Pick a smaller model; see the sizing table in [OLLAMA](OLLAMA.md).

## Routing and payments

**I connected Ollama but `auto` still answered with canned text.** Fixed: a live listing now always beats the simulated market. If you still see `[elyra demo engine ...]`, update the node, or check `x-elyra-simulated` and that your source appears under Models as `LIVE`.

**"No route".** Your policy filtered everything out: `teeOnly` with no private listing, a `maxPrice` below every listing, or the requested model has no listing. Loosen the policy or add a source.

**A peer shows but is never used.** Both sides must use the same escrow and settlement mode (`sim` vs `chain`) or there is no route. Also check the protocol version.

**A paid request returns 402/503.** A provider refuses when your wallet's unpaid balance plus the request's worst case exceeds its credit limit (`creditUsd`, default $0.50), when your wallet's on-chain escrow deposit exceeds the seller's per-wallet deposit cap (`402 deposit_cap_exceeded`, default $20 USDG while the contract is unaudited), or when it cannot read the chain (`503`, fail-closed). Deposit within the cap, or wait for the provider to redeem.

**My deposit looks lower than I sent.** Check the explorer. Real USDG's supply controller can burn from any address; the mock token cannot. The escrow cannot protect against that ([SECURITY](../SECURITY.md)).

**Mint does nothing / errors.** Mint works only for the mock test token on testnet.

**Withdraw says locked.** Withdrawals need `request`, then wait 1 day, and must be executed within 7 days.

## Website

**Unknown URLs on the site return 404.** Intended: the bundle ships a `404.html`.

## Contributing and security

See [CONTRIBUTING](../CONTRIBUTING.md) and [SECURITY](../SECURITY.md). Report vulnerabilities privately through GitHub Security Advisories.

## Running it for other people

**Why is generation so slow on my server?** Language models are limited by memory bandwidth, and a small shared CPU server has very little (a typical result is about 1 token per second for a 1B model). Elyra only forwards the request. Use a faster machine or a GPU machine reached over an SSH tunnel: [Use your own model](OLLAMA.md#ollama-on-another-machine-a-gpu-box-over-an-ssh-tunnel).

**Is a model on another machine private?** No. If its operator can run software on it, they can read your prompts. Elyra labels such a source **REMOTE** and never counts it as private routing. Only a local model, or a verified [TEE](TEE.md) peer, is private.

**What happens when the model machine goes down?** The node notices within about 30 seconds, marks the source **OFFLINE**, stops offering its models and routes around it. A public try page shows "offline" instead of failing. When the machine answers again it comes back on its own.

**What should I back up?** The data directory (identity, wallet, state) and your `ELYRA_PASSPHRASE`, in different places. See [Run it in production](OPERATIONS.md#backups).

**My node found a seller but shows no models.** Two nodes can only trade when they use the same escrow. Overview says which escrow the seller uses; check it against the one in the docs and click **Use this settlement** (or set `ELYRA_NETWORK` and `ELYRA_ESCROW` before starting). A node with no escrow configured uses a simulated ledger and cannot trade with an on-chain seller.

