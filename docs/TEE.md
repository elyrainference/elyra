# TEE: real confidential inference

Status 2026-11-05: **verifier, producer, trust list, routing rules and tests are built; nothing has run inside a real Confidential Space VM yet.** Until a real token from Google has passed `verifyGcpToken`, the word "verified" is unproven against production (the tests use a locally generated RSA key standing in for Google's). Do not market it before the milestone M1 below.

## What the buyer can conclude (and what not)

A seller shows **TEE · VERIFIED** only if all of these hold (`router/tee.mjs`, tested by `router/test/tee.test.mjs`):

1. Google Cloud Attestation signed the token (RS256, key from Google's OIDC JWKS; never `none`/HS256).
2. It is fresh, minted for audience `elyra:v3`, issuer `https://confidentialcomputing.googleapis.com`.
3. `eat_nonce` equals `sha256(canon({id, pub, box, wallet}))`: the identity key, **sealing key** and wallet in the seller's hello were handed to the attestation service by the code in the measured container. Prompts sealed to that box key can only be opened inside it.
4. `swname=CONFIDENTIAL_SPACE`, `dbgstat=disabled-since-boot`, `secboot=true`, `hwmodel ∈ {GCP_AMD_SEV, GCP_INTEL_TDX}`, image support attribute `USABLE`.
5. `submods.container.image_digest` is in **the buyer's own pinned list** (`PUT /api/trust`, UI: Network → TEE trust list). Empty list = nothing verifies. The seller can never vouch for itself.
6. In TEE mode the node refuses non-local upstreams (`addUpstream`), so the model runs inside the same workload.

Not covered: Google is the root of trust; hardware side channels; a model server that is not inside the attested container; the seller operator seeing *metadata* (timing, sizes, who). Env overrides the operator sets appear in the token (`submods.container.env`) but are not yet checked by the verifier. `image_signatures` (cosign) and GPU claims (`nvidia_gpu.*`) are not verified yet.

Routing: `teeOnly` / `auto:private` accept only **verified** TEE or a **local** upstream. "Claimed" and the demo market's "TEE" no longer count as private.

## Request flow

```
seller VM (Confidential Space)                          buyer (your VPR)
  boot: generate ed25519 + X25519 + wallet in memory
  token = launcher /v1/token {aud:"elyra:v3", nonces:[binding]}
  hello = { ..., box, wallet, attestation:{token} }  ─►  GET /p2p/hello
                                                         verifyGcpToken(token, YOUR trust list, binding recomputed from hello)
                                                         ok → tee = verified → eligible for teeOnly
  ◄── sealed request (X25519 to the attested box key) ──
  decrypt + run model inside the VM, sealed answer + signed receipt ─►
```

## What you must prepare (solo founder checklist)

| # | What | Why | Notes |
|---|---|---|---|
| 1 | **Google Cloud account + billing** (card), a dedicated project | the only supported TEE platform so far | enable Compute Engine, Confidential Computing API, Artifact Registry. Check current pricing in the calculator; I have not quoted any |
| 2 | `gcloud` + Docker (or Cloud Build) on your machine | build and push the image | `deploy/tee/README.md` has exact commands |
| 3 | **One real run** of `deploy/tee/gcloud-launch.sh` | produces the first real token; this is milestone M1 | start with a CPU VM (N2D=SEV or C3=TDX) and a tiny model, hours not days |
| 4 | The **image digest** from your build | the value buyers pin; publish it with each release | one digest per Elyra release; keep a changelog of digests |
| 5 | **ETH on Robinhood Chain for gas** at the ephemeral wallet | the TEE wallet is regenerated on each boot and prints its address in the log | set `ELYRA_PAYOUT` to a wallet you control; earnings are swept there after every redeem; unredeemed vouchers are redeemed on SIGTERM |
| 6 | A **public URL** for the seller (TLS) | buyers must reach it | HTTPS load balancer or a tunnel; set `tee-env-ELYRA_PUBLIC_URL` |
| 7 | The model weights **baked into the image** (pinned sha256) | a second container is not possible; remote model = no privacy | `deploy/tee/model-server.md`; image gets large |
| 8 | **GPU (optional, later)**: Confidential Space supports H100 on TDX (`a3-highgpu-1g`, spot/flex-start, specific zones) per the docs | confidential inference of bigger models | UNCONFIRMED that llama.cpp/CUDA works inside it; needs GPU quota; much higher cost; `nvidia_gpu.*` claims not verified yet |
| 9 | Decide the **testnet vs mainnet** moment | real USDG | keep testnet until M2 |

You do not need to give me cloud credentials. I write the code and runbook; you run the commands and paste back the first real token (decode it, remove nothing sensitive: it holds project/instance ids) so I can fix any mismatch between the docs and reality.

## Can this run on a VPS?

**An ordinary VPS (Hetzner, DigitalOcean, Contabo, any KVM VM): no.** Without CPU-level memory encryption and a vendor-signed attestation there is nothing a buyer can verify, so "TEE mode" there would be a lie. What does work:

| Option | TEE? | Notes |
|---|---|---|
| Google Confidential Space (built) | yes | what the verifier supports today (M1) |
| A **confidential VM / bare-metal server with AMD SEV-SNP or Intel TDX**, rented or owned, where you run the host | yes in principle | attestation is a raw SNP report / TDX quote verified against AMD/Intel certificates: **not built** (planned M4), more code than the Google JWT path. Check the provider actually exposes SNP/TDX to guests and gives you a measured-boot guest image |
| Azure confidential VMs (MAA tokens), AWS Nitro Enclaves | yes | also planned M4 (JWT/COSE verifiers) |
| Ordinary VPS | **no** | still useful for a **non-TEE seller** (price/speed only), a public **bootstrap/seed node**, relays/tunnels, hosting the landing page |

So: use Google for M1 (fastest path to a real token), and treat "TEE on a cheap VPS" as a hardware question first (does the host expose SEV-SNP/TDX?), then a verifier question.

## Milestones

- **M1 – first real token**: image builds, VM boots, launcher token passes `verifyGcpToken` against Google's real JWKS with your digest pinned. Unknowns this resolves: digest format in `tee-image-reference`, uid/socket permissions, writable data dir (see `deploy/tee/README.md §15`).
- **M2 – paid confidential trade on testnet**: buyer (your laptop, teeOnly) → TEE seller, sealed, USDG voucher, auto-redeem, sweep to payout.
- **M3 – hardening**: verify cosign `image_signatures`, inspect `submods.container.env/args`, persist the seller identity across restarts with Cloud KMS bound to the attestation (today every boot = new identity and reputation reset), GPU claims.
- **M4 – second platform** (AWS Nitro Enclaves or Azure CVM with MAA) so verification does not depend on one cloud.

## Known limits today
- Identity and wallet are ephemeral per boot: reputation resets, vouchers for a dead node are unrecoverable (mitigated by auto-redeem + sweep + redeem on shutdown; do not hold funds in that wallet).
- The attestation token lives ~1 h; the seller refreshes it every ≤ 40 min, buyers re-verify on each 15 s gossip refresh.
- Attestation quota: 5 queries/s/project/region.
