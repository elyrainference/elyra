# Ollama: run a real model behind Elyra

Ollama serves open models on `127.0.0.1:11434` with an OpenAI-compatible API. Elyra treats it as an **upstream**: any OpenAI-compatible server works, but only localhost/LAN upstreams count as local/private (`LOCAL`). A model server on another machine reached over an SSH tunnel or VPN is flagged `REMOTE` (never private), and hosted upstreams (OpenRouter, OpenAI) are labelled `HOSTED · CLEAR`.

## 1. Install

```bash
curl -fsSL https://ollama.com/install.sh -o ollama-install.sh
less ollama-install.sh            # read it first; it only downloads from ollama.com (and NVIDIA repos if a GPU is found)
sh ollama-install.sh
systemctl is-active ollama        # active
ss -ltnp | grep 11434             # 127.0.0.1:11434 only
```

The installer creates a systemd service. **Keep Ollama on loopback; never expose port 11434.**

## 2. Pull a model that fits your RAM

| Machine | Models (q4, rough) |
|---|---|
| 2 vCPU, 4 GB RAM | `llama3.2:1b`, `qwen2.5:0.5b` |
| 4 vCPU, 16 GB RAM | `llama3.2:3b`, 7-8B models (a few tokens/s on CPU) |
| GPU | 8B to 70B depending on VRAM |

```bash
ollama pull llama3.2:1b           # about 1.3 GB
curl -s http://127.0.0.1:11434/v1/models
```

Models live in `/usr/share/ollama/.ollama/models` by default. For another disk set `OLLAMA_MODELS=/path` in the service environment (`systemctl edit ollama`).

## 3. Smoke-test Ollama directly

```bash
curl -s http://127.0.0.1:11434/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"llama3.2:1b","messages":[{"role":"user","content":"Reply with exactly: ok"}],"max_tokens":8}'
```

The **first** call loads the model into RAM: on a machine with tight free RAM that can take up to a minute; warm calls take about one second.

## 4. Point Elyra at it

Environment (see [CONFIGURATION](CONFIGURATION.md)):

```
ELYRA_UPSTREAM_URL=http://127.0.0.1:11434/v1
ELYRA_UPSTREAM_NAME=ollama
```

or in the panel: Provide → add source. Then:

```bash
curl -s http://127.0.0.1:8545/v1/models                 # includes llama3.2:1b, owned_by "SELF - ollama"
curl -s http://127.0.0.1:8545/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"llama3.2:1b","messages":[{"role":"user","content":"Say hi in 3 words"}],"max_tokens":16}'
```

The response carries an `elyra` block: `route: "self:SELF - ollama"`, `simulated: false`, `tee: "none"`, `price_per_mtok: 0` (your own model costs you nothing to call).

## 5. Sell it (optional)

Setting `ELYRA_PROVIDE=1`, a public HTTPS URL (or `ELYRA_RELAY_URL` behind a home router) and a price makes the node announce the model to peers. A non-TEE seller can read prompts, so it must never be labelled TEE (the node only claims TEE inside Confidential Space). Price per MTok must exceed your cost per MTok served. Start on a machine you already own; rent a GPU only after a buyer exists. Full guide in [Sell capacity](PROVIDER.md).

## Troubleshooting

- `Could not connect to a running Ollama instance`: `systemctl status ollama`; on containers without systemd run `ollama serve`.
- Out-of-memory kills: pick a smaller model; check `free -h` while loaded. Ollama unloads idle models after a few minutes.
- Router shows the model but chat hangs: cold start, wait; or the model name in the request does not match `ollama list`.

## Ollama on another machine (a GPU box over an SSH tunnel)

A small server is slow for language models: generating text is limited by memory bandwidth. A rented or home GPU machine is far faster (measured on a rented RTX 4090: about 45 tokens/s for Llama 3.1 8B, against about 1 token/s on a small shared CPU server). You can keep the node where it is and use that machine as its model source.

1. On the GPU machine run Ollama bound to its own loopback (`OLLAMA_HOST=127.0.0.1:11434`) and pull a model. Do **not** expose Ollama to the internet: it has no login.
2. On the node's machine open a tunnel to it and keep it alive (a systemd service with `Restart=always`, `ServerAliveInterval=15`, `ExitOnForwardFailure=yes`):
   `ssh -N -i key -L 127.0.0.1:11435:127.0.0.1:11434 -p PORT user@GPU_HOST`
3. Add `http://127.0.0.1:11435/v1` as a source in **Connect** and tick **Another machine, reached over an SSH tunnel or VPN**. Over the API: `POST /api/upstreams` with `"remote": true`.

Why tick the box: a loopback address looks local, so without it the router would label the source **LOCAL** and private even though your prompts leave the machine. With it the source is labelled **REMOTE**, never counts as private, and is skipped by private routing. If you rent from a marketplace, the host of that machine can read your prompts: use it for tests and public demos, not for private data.

If the tunnel drops, requests to that source fail and the router tries the next candidate.

