# Quickstart

Five steps from nothing to a real answer from a model you run yourself. No GPU needed: a small model runs on an ordinary CPU.

## 1. Run a node

You need Node.js 20 or newer. There is no build step and one runtime dependency.

```bash
git clone https://github.com/elyrainference/elyra.git
cd elyra
npm ci --omit=dev
npm start
```

Open **http://localhost:8545/app/**. That is your control panel. The node also serves an OpenAI-compatible endpoint at `http://localhost:8545/v1`.

> **Good to know:** until you attach a real model, every answer comes from a *simulated* demo peer and is labelled `SIM`. That is on purpose, so a fresh install has something to show. The next two steps replace it with a real model.

## 2. Attach a model with Ollama

```bash
curl -fsSL https://ollama.com/install.sh -o ollama-install.sh   # read it first
sh ollama-install.sh
ollama pull llama3.2:1b                                          # about 1.3 GB
```

Pick the model by free RAM: about 1B for 4 GB free, 3B for 8 GB, 7-8B for 16 GB or more. Details and sizing in [Run a real model](/docs/ollama/).

## 3. Connect it in the panel

On the **Overview** page click **Detect Ollama**, then **Add**. The panel jumps to Connect, finds Ollama on port 11434 and shows a card saying it is ready. From now on, `auto` goes to your live model first, never to simulated peers.

Prefer the command line? Set `ELYRA_UPSTREAM_URL=http://127.0.0.1:11434/v1` before starting the node ([Configuration](/docs/configuration/)).

## 4. Send a request

In the panel open **Playground** and say something, or:

```bash
curl -i http://localhost:8545/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Say hi in 3 words"}],"max_tokens":16}'
```

Check the response headers:

```
x-elyra-route: self:SELF - Ollama
x-elyra-model: llama3.2:1b
x-elyra-simulated: false
```

`x-elyra-simulated: false` is your proof the answer came from your model. The very first request after a model has been idle can take up to a minute while it loads into memory; later ones take about a second.

## 5. Point your tools at it

Any client that speaks Chat Completions works unchanged:

```bash
export OPENAI_BASE_URL=http://localhost:8545/v1
export OPENAI_API_KEY=anything        # not checked: the endpoint is local only
```

## Buy from the live network (testnet)

The project runs a public node whose market you can join. It uses a test token with no value.

1. Start your node with that seller as its first peer:

```bash
npm start -- --seed https://app.elyrainference.com
```

2. Open `http://localhost:8545/app/`. If the seller settles on an escrow your node does not use, Overview says **Cannot reach these models yet** and names the escrow. Compare it with the one in [Install](INSTALL.md) (testnet escrow `0xe9dA82E45D8CbF84A633a0B0e46e12D2A9288092`), then click **Use this settlement**. The seller's models appear in **Models**.
3. Fund your escrow: see [Wallet and USDG, your first paid request](WALLET.md#your-first-paid-request). While the escrow contract is unaudited, deposits are capped at **$20 USDG per wallet** by default (`maxDepositUsd`).
4. Send a request with that model name. **Routes** shows who answered, the price and the receipt.

A request you cannot pay for is refused before anything is generated, with a message that says how to fund it.

## Pay-per-use from a browser (no install)

When a public node enables browser session payments (`ELYRA_PUBLIC_PAY=1`), you can pay peer sellers per token directly from the public market page without running a local router:

1. Open the public market page and connect your browser wallet (MetaMask, Rabby, or Coinbase Wallet) under **Wallet**.
2. Your browser generates a local **session key** in browser storage and shows its address (`0x...`).
3. Mint test USDG on testnet if needed, enter an amount (up to the **$20 USDG** per-wallet deposit cap), and confirm `approve` + `depositFor(sessionAddress)`.
4. Open the Playground for any paid peer seller: the public node relays the sealed request and returns the seller's signed receipt; your browser checks that the cost fits within the price ceiling you accepted before signing the next cumulative EIP-712 voucher. The public node never holds your funds or your session key.
5. When withdrawing from a session key (`Request withdraw` → 1-day delay → `Withdraw`), the browser leaves enough deposit in escrow (`deposit - owed`) to cover any signed vouchers that sellers have not redeemed on-chain yet.

> **Status:** verified end-to-end on a local chain with a simulated wallet; currently off on `app.elyrainference.com` while there is 1 live seller, and not yet tested with a real MetaMask/Rabby browser extension. Details in [Wallet and USDG](WALLET.md#pay-per-use-on-the-public-page-browser-session-key).

## Hosted APIs vs. peer-to-peer models

In **Connect**, you can also attach an API key from **OpenRouter**, **OpenAI**, **Groq**, or **Together** to your own router:

- **Peer-to-peer (`LIVE`):** served by another Elyra node over sealed `X25519` transport, verified by signed `ed25519` receipts, and paid per token in USDG on Robinhood Chain.
- **Hosted (`HOSTED · CLEAR`):** an ordinary aggregator leg on your own router. Hosted models are ranked by their published per-model prices (never treated as free), billed outside the chain to that provider under your API key, **never** re-shared with peers or listed on the public market, and **never** counted as private/TEE.

## Privacy and TEE limits

- **Sealed transport (`X25519 + AES-256-GCM`)** hides prompts and completions from network observers and relays, **not** from the machine running the model.
- **What counts as private:** `teeOnly` and `auto:private` accept only a `LOCAL` model on your own machine/LAN or a `TEE · VERIFIED` peer. Self-declared `CLAIMED` sellers, `REMOTE` GPUs reached over an SSH tunnel, and `HOSTED · CLEAR` APIs are excluded.
- **TEE status today:** the Google Confidential Space attestation verifier is built and requires the seller's container digest to match **your** pinned trust list, but it has only been tested against simulated Google tokens so far — not yet inside a real Confidential Space VM (milestone M1 in [Private inference (TEE)](TEE.md)).
## Where next

- Run it as a service on a server: [Install](/docs/install/)
- Understand the moving parts: [How it works](/docs/concepts/)
- Tune routing and read receipts: [Use the endpoint](/docs/usage/)
- Offer your model to the network and get paid: [Sell capacity](/docs/provider/)
- Something broke: [FAQ and troubleshooting](/docs/faq/)
