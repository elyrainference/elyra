# Selling from a rented GPU (Vast.ai, RunPod, Lambda...)

Written 2026-11-07 after a real Vast.ai rental stopped at five models. Vast-specific UI details are from general knowledge, not checked against current Vast docs.

## Why a rented GPU "runs out of models"
Elyra offers every model the source lists (`/v1/models` of Ollama / vLLM); there is no cap in the code. What limits you:

| Limit | What happens | Fix |
|---|---|---|
| **Disk** | Models you cannot download do not exist. A 32 GB disk fills with ~5 mid-size models | Create the instance with **150-300 GB**. Vast fixes disk size at creation; it cannot be enlarged later, so destroy and recreate |
| **VRAM** | Only models loaded in GPU memory answer fast; others are loaded on demand (cold start of seconds to a minute) | Offer fewer, popular models hot; let Ollama swap the rest (`OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_KEEP_ALIVE`) |
| **Bandwidth/price** | Re-downloading models on every new instance costs time and money | Keep one long-lived instance; do not recreate it often |

Rough sizes at 4-bit quantisation (rules of thumb, not measured): 3B ~2 GB, 8B ~5 GB, 14B ~9 GB, 32B ~20 GB, 70B ~40 GB. Pick models people actually ask for, not as many as fit.

## Stopped instances still cost money
On Vast an **Inactive** (stopped) instance keeps its disk and is still billed for storage (the small `$/hr` on the card). Two forgotten instances add up. **Destroy** instances you no longer need (trash icon), do not just stop them.

## Setup outline
1. Instance: 1 GPU, **150+ GB disk**, a CUDA/Ollama template or a plain CUDA image with SSH. Note which public ports the host maps to your container; the instance's ports are not the normal 80/443.
2. Install Ollama, set `OLLAMA_MODELS` to the big disk path, `ollama pull` your models.
3. Run the Elyra node there following `docs/VPS.md` (steps 2-4). Env: `ELYRA_UPSTREAM_URL=http://127.0.0.1:11434/v1`, `ELYRA_PROVIDE=1`, per-model prices in the panel (Provide).
4. **Reachability.** A rented container usually has no domain and TLS. Use the built-in relay (`ELYRA_RELAY`, see `docs/OPERATIONS.md`) or a Cloudflare tunnel, and set `ELYRA_PUBLIC_URL` to what buyers will use.
5. Price above your rent: price per MTok must exceed rent per hour divided by the tokens you actually serve per hour. With no buyers yet, rent the cheapest box that fits one model.

## Honesty
A rented GPU host can read prompts. The seller shows as `CLEAR` (or `REMOTE` if the model is on a different machine than the node), never TEE. If the GPU host is in another jurisdiction, say so in your offer description; buyers decide.
