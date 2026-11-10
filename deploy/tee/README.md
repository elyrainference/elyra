# Running a Elyra seller node in Google Cloud Confidential Space (runbook)

Goal: run `node router/server.mjs` as the **single workload container** of a Confidential Space VM, so a buyer can
verify an attestation token ("this exact image digest, on confidential hardware, debug off") before sealing a
prompt to the node. Producer/verifier code is `router/tee.mjs`; this folder is only packaging and operations.

| File | What it is |
|---|---|
| `Dockerfile`, `Dockerfile.dockerignore` | The workload image + launch-policy labels (the labels are commented one by one). |
| `gcloud-launch.sh` | Parameterised, **dry-run by default** script: APIs, service account, IAM, firewall, VM. |
| `model-server.md` | How to put a CPU model server *inside* the same container so the TEE claim is honest. |

> Windows dev machine note: nothing here needs to run on Windows except `docker buildx` (Docker Desktop) and `gcloud`.
> `gcloud-launch.sh` is bash (Git Bash / WSL / Cloud Shell).

## 0. Read this first: what is NOT ready yet (status as of the files in this repo)

These are facts about the current code, found while writing the runbook; they decide whether a deployment is useful.

1. **Boot-time configuration is missing.** The image's `CMD` is fixed (`allow_cmd_override=false`, deliberately), but
   `router/server.mjs` reads `--public-url` and `--seed` only from the command line, and upstreams / provider
   settings only from the loopback `/api/*`. So today a VM boots as a node with **no upstream model, `provide.enabled=false`,
   no seeds, and `ELYRA_PUBLIC_URL` (allowed by the image's `allow_env_override`) is not read by any code**.
   Before a real deployment the node needs an env/entrypoint-driven bootstrap (e.g. read `ELYRA_PUBLIC_URL`,
   seed list, upstream `http://127.0.0.1:8080/v1`, `provide.enabled`, price). The loopback API *can* be called from inside the
   container (the `Host`/peer checks pass for `127.0.0.1`), so a small entrypoint script is one option; see `model-server.md`.
   Whatever is chosen becomes part of the image digest, which is what we want.
2. **The wallet lives and dies inside the VM.** `--data /var/elyra` is on the VM's encrypted stateful partition,
   keyed per boot (docs: a restart "encrypts the VM instance's disk with a new ephemeral key"). After any restart or delete the node has a **new
   identity and a new wallet address**. Unredeemed vouchers for the old wallet are lost, and anything already redeemed to
   the old wallet address is **unrecoverable** (nobody has that key). Payout must go to an address the seller controls,
   or redeemed funds must be swept out before the VM stops. Do not run this with real funds until that is solved. The same
   wallet also needs ETH for redeem gas, and must be funded after *every* boot.
3. **`log_redirect=always`** (Dockerfile) means the operator reads stdout/stderr. `router/obs.mjs` never logs prompts/keys, keep it so.
4. **`tee-image-reference` with `@sha256:`**: the docs show only `:latest`-style tags in their examples. Digest references are
   standard containerd syntax but are **UNCONFIRMED** in the Confidential Space docs I read. Either way the *token* reports
   `submods.container.image_digest`, and that is what buyers pin. If the launcher rejects a digest ref, use a tag, read the digest from the first token, and
   never reuse/move that tag.
5. **Non-root + launcher socket.** The image runs as `node` (uid 1000). Whether uid 1000 can open
   `/run/container_launcher/teeserver.sock` is **UNCONFIRMED** (Google's samples run as root). If the node logs
   `cannot reach the Confidential Space launcher: EACCES`, remove `USER node` from the Dockerfile (or run the node as root),
   rebuild, and re-pin: the digest changes.
6. **Is the container root filesystem writable** for `/var/elyra`? Not stated in the docs I read: **UNCONFIRMED**. The docs do say
   the boot disk stateful partition is resized with `--boot-disk-size` (partition ≈ disk − 5 GB), which suggests container storage lives there.

## 1. Variables

```bash
export PROJECT=my-elyra-project            # project that runs the VM
export REGION=us-central1
export ZONE=us-central1-a                    # must offer your machine type + CC technology (see §6)
export AR_HOST=us-docker.pkg.dev             # or ${REGION}-docker.pkg.dev
export AR_REPO=elyra
export IMAGE=${AR_HOST}/${PROJECT}/${AR_REPO}/elyra-node
export TAG=2026-11-05                        # human label only; trust is by DIGEST
export SA=elyra-tee                         # workload service account id
export CC_TYPE=SEV                           # SEV or TDX
export MACHINE_TYPE=n2d-standard-4           # SEV: n2d/c2d/c3d/c4d  |  TDX: c3-standard-*/c4-standard-*
```

## 2. Project, APIs, registry

```bash
gcloud config set project "$PROJECT"
gcloud services enable compute.googleapis.com confidentialcomputing.googleapis.com \
  logging.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com
gcloud artifacts repositories create "$AR_REPO" --repository-format=docker \
  --location="${AR_HOST%-docker.pkg.dev}" --description="Elyra TEE images"
gcloud auth configure-docker "$AR_HOST"
```

(`us-docker.pkg.dev` → location `us`; `europe-west4-docker.pkg.dev` → location `europe-west4`. `gcloud-launch.sh` derives it the same way.)

## 3. Build the image and get the immutable digest

Pin the base image first (instructions at the top of `Dockerfile`: `docker buildx imagetools inspect node:22-bookworm-slim`,
paste the `sha256:` over `<PIN-ME>`). Then, from the **repository root**:

```bash
docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
  -f deploy/tee/Dockerfile -t "$IMAGE:$TAG" --push .
```

* `linux/amd64`: SEV (N2D/C2D/C3D/C4D) and TDX (C3/C4) machines are all x86-64.
* `--provenance=false --sbom=false`: BuildKit otherwise pushes an *index* with attestation manifests, and then "the digest" is ambiguous. We want one image manifest.

Read the digest back from the registry (this is the value buyers pin):

```bash
gcloud artifacts docker images describe "$IMAGE:$TAG" --format='value(image_summary.digest)'
# -> sha256:3f6c…  (64 hex)
export IMAGE_DIGEST_REF="$IMAGE@$(gcloud artifacts docker images describe "$IMAGE:$TAG" --format='value(image_summary.digest)')"
echo "$IMAGE_DIGEST_REF"
```

Whether the launcher's `submods.container.image_digest` equals this registry manifest digest is expected but **UNCONFIRMED by the docs I read**;
confirm it once against a real token (§9) before telling buyers anything. If they differ, buyers pin the token's value.

**Cloud Build alternative** (builds in GCP; the digest is printed at the end). `Dockerfile.dockerignore` is only honoured by BuildKit,
but the Dockerfile's explicit `COPY` lines and its `rm -rf router/test` stage do not depend on it, so the *content* is the same:

```bash
cat > /tmp/cloudbuild-elyra-tee.yaml <<EOF
steps:
- name: gcr.io/cloud-builders/docker
  env: ["DOCKER_BUILDKIT=1"]
  args: ["build","--platform=linux/amd64","-f","deploy/tee/Dockerfile","-t","${IMAGE}:${TAG}","."]
images: ["${IMAGE}:${TAG}"]
EOF
gcloud builds submit --project="$PROJECT" --region="$REGION" --config=/tmp/cloudbuild-elyra-tee.yaml .
```

The step above is an untested sketch (UNCONFIRMED: BuildKit via the `docker` builder honouring `Dockerfile.dockerignore`; the `images:` push step produces a single-platform manifest). `gcloud builds submit` also respects `.gcloudignore`/`.gitignore` when uploading the source. Prefer the local `buildx` build for the release image.

Image digests change with any content/timestamp difference, so two builds of the same commit normally have different digests (no bit-reproducible
build is claimed here). Build **once**, publish the commit hash + digest together, and have buyers pin that digest.
Google mentions Bazel for reproducible images; that is optional hardening, not implemented here.

## 4. (Optional) Sign the image with cosign

Docs: signed images let a verifier trust a *key* instead of a digest (no re-pinning per release); the operator lists the signature repos in
`tee-signed-image-repos` and the token then carries `submods.container.image_signatures` ([create-customize-workloads → Signed container images](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/create-customize-workloads)).

```bash
cosign generate-key-pair                       # keep cosign.key OFFLINE; never commit it. Publish cosign.pub.
cosign sign --key cosign.key "$IMAGE_DIGEST_REF"
export SIGNED_IMAGE_REPOS="$IMAGE"             # passed as tee-signed-image-repos by gcloud-launch.sh
openssl pkey -pubin -in cosign.pub -outform DER | openssl sha256   # = the key_id a verifier would look for
```

**Caveat:** `router/tee.mjs` currently only checks `allowedImages` (digests). Signing does nothing for Elyra buyers until the verifier learns `image_signatures`.
Docs also note signature updates can take up to an hour to be detected, and (AWS-token note) signature claims and digest claims do not appear together in one token,
so a token for a signed-image deployment may lack `image_digest`: **UNCONFIRMED for OIDC tokens**. Do not enable signing and digest pinning together without testing.

## 5. Service account and minimal IAM

The VM's service account needs exactly three things (docs, [deploy-workloads → Attached service account](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/deploy-workloads)):

| Role | Why |
|---|---|
| `roles/confidentialcomputing.workloadUser` | request attestation tokens |
| `roles/logging.logWriter` | `tee-container-log-redirect` → Cloud Logging |
| `roles/artifactregistry.reader` (on the repo) | pull the image |

```bash
SA_EMAIL=${SA}@${PROJECT}.iam.gserviceaccount.com
gcloud iam service-accounts create "$SA" --display-name="Elyra TEE workload"
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA_EMAIL" --role=roles/confidentialcomputing.workloadUser --condition=None
gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA_EMAIL" --role=roles/logging.logWriter --condition=None
gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" --location="${AR_HOST%-docker.pkg.dev}" \
  --member="serviceAccount:$SA_EMAIL" --role=roles/artifactregistry.reader
# you (the operator) need roles/iam.serviceAccountUser on this SA to attach it to a VM:
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" --member="user:$(gcloud config get-value account)" --role=roles/iam.serviceAccountUser
```

Grant nothing else. The service account is visible in the token (`google_service_accounts`); data-plane roles it does not have cannot leak through the workload.

## 6. Firewall, zone, machine type

* Confidential Space blocks **all** inbound ports by default; the image's `EXPOSE 8545` keeps tcp:8545 open on the VM (image ≥ 230600), **and** your VPC firewall must allow it:

```bash
gcloud compute firewall-rules create elyra-tee-allow-p2p --network=default --direction=INGRESS \
  --action=ALLOW --rules=tcp:8545 --source-ranges=0.0.0.0/0 --target-tags=elyra-tee
```

* **TLS.** Port 8545 speaks plain HTTP. The sealed envelope protects prompts end-to-end, but peers, gossip and hello are cleartext and a
  `http://` URL is easy to impersonate. Put a TLS terminator in front (external HTTPS load balancer or a tunnel such as `cloudflared`, which the project already tested, see `docs/STATUS.md`)
  and set `ELYRA_PUBLIC_URL=https://…` (needs the code change in §0.1). A terminator *outside* the VM sees only sealed bodies; do not terminate TLS with a key the operator can read and then claim it is the TEE's. Restrict `--source-ranges` to the proxy's ranges when you use one.
* **CC technology + machine type** (from [Confidential VM supported configurations](https://docs.cloud.google.com/confidential-computing/confidential-vm/docs/supported-configurations)):

| `--confidential-compute-type` | machine types (CPU-only) | `--maintenance-policy` (deploy doc) |
|---|---|---|
| `SEV` | `n2d-*` (Milan), `c2d-*` (Milan), `c3d-*` (Genoa), `c4d-*` (Turin) | `MIGRATE` for N2D, else `TERMINATE` |
| `TDX` | `c3-standard-*`, `c3-standard-*-lssd`, `c4-standard-*` | `TERMINATE` |

  Zones differ per type (TDX `c3-standard-*` zones include us-central1-a/b/c, us-east4-a/b/c, europe-west4-a/b/c, …; AMD SEV: list with
  `gcloud compute zones list --filter="availableCpuPlatforms.list():'AMD Milan'" --format="value(name)"`). Confidential Space also needs Certificate Authority Service in the region (deploy doc). Pick a size from RAM needs (see `model-server.md`); swap is disabled in Confidential Space.

## 7. Create the VM

Easiest: the script. It prints everything first (default), then `--apply` runs it.

```bash
export PROJECT ZONE IMAGE_DIGEST_REF MACHINE_TYPE CC_TYPE SA
export ELYRA_PUBLIC_URL=https://seller.example.com   # optional, see §0.1
./deploy/tee/gcloud-launch.sh            # dry run, review
./deploy/tee/gcloud-launch.sh --apply
```

What it runs for the VM (paraphrased; the script is authoritative):

```bash
gcloud compute instances create elyra-tee-1 \
  --confidential-compute-type="$CC_TYPE" --machine-type="$MACHINE_TYPE" \
  --maintenance-policy=MIGRATE_OR_TERMINATE --shielded-secure-boot \
  --image-project=confidential-space-images --image-family=confidential-space \
  --boot-disk-size=30GB --service-account="$SA_EMAIL" --scopes=cloud-platform --tags=elyra-tee \
  --zone="$ZONE" --project="$PROJECT" \
  --metadata="^~^tee-image-reference=${IMAGE_DIGEST_REF}~tee-restart-policy=OnFailure~tee-container-log-redirect=cloud_logging~tee-env-ELYRA_PUBLIC_URL=https://seller.example.com"
# SEV on n2d/c2d additionally: --min-cpu-platform="AMD Milan"  (as in Google's examples)
```

Metadata reference ([metadata-variables](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/reference/metadata-variables)):

| Key | Used here | Notes |
|---|---|---|
| `tee-image-reference` | yes (required) | digest-pinned, see §0.4 |
| `tee-restart-policy` | `OnFailure` | `Never` (default) / `Always` / `OnFailure`; production image only. **Do not use `Always`**: `router/tee.mjs` rejects tokens with that policy. `OnFailure` restarts the VM on failure (return code 3), and a new identity follows. |
| `tee-container-log-redirect` | `cloud_logging` | `false` default / `true` (serial + Cloud Logging) / `cloud_logging` / `serial`. Image label `log_redirect=always` permits it. High serial volume can slow the workload, so Cloud Logging only. |
| `tee-env-NAME=value` | `ELYRA_PUBLIC_URL`, `LOG_LEVEL` | only names in the image's `allow_env_override` are applied; others are silently ignored. |
| `tee-signed-image-repos` | optional | §4 |
| `tee-cmd` | never | image has `allow_cmd_override=false` |
| `tee-monitoring-memory-enable` | never | image has `monitoring_memory_allow=never` |
| `tee-install-gpu-driver` | no | GPU, see `model-server.md` |

Always use `--image-family=confidential-space` (production). The `-debug` family enables SSH + root for the operator and the token says `dbgstat: enabled`: buyers must (and `router/tee.mjs` does) reject it. Use debug only for a throwaway test with fake data.

## 8. Logs and health

```bash
gcloud compute instances describe elyra-tee-1 --zone="$ZONE" --format='value(id)'     # INSTANCE_ID
gcloud logging read 'resource.type="gce_instance" AND log_id("confidential-space-launcher") AND resource.labels.instance_id="INSTANCE_ID"' \
  --project="$PROJECT" --limit=100 --freshness=1h --format='value(timestamp,jsonPayload.message,textPayload)'
gcloud compute instances get-serial-port-output elyra-tee-1 --zone="$ZONE" | tail -n 50      # launcher output (return codes)
IP=$(gcloud compute instances describe elyra-tee-1 --zone="$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')
curl -s "http://$IP:8545/healthz"
```

Expect node logs (JSON lines) such as `attestation refreshed` or `attestation failed: this node will NOT advertise TEE`. Return codes
([monitor-debug](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/monitor-debug)): 0 workload ok/VM stops, 1 error/VM stops, 3 launcher restarted per `tee-restart-policy`, 4 debug image idling.
If the workload fails the operator only sees `workload finished with a non-zero return code`, so keep `LOG_LEVEL=info` logs useful. Deprecated/revoked Confidential Space images: token `swname` becomes `GCE` or the launcher reports `RIMS_VALIDATION_FAILED`.

## 9. Verify the token by hand

The node publishes its token in `GET /p2p/hello` as `attestation.token`.

```bash
curl -s "http://$IP:8545/p2p/hello" > hello.json
node -e 'const h=JSON.parse(require("fs").readFileSync("hello.json"));const t=h.attestation.token.split(".");
const d=x=>JSON.parse(Buffer.from(x,"base64url"));console.log(d(t[0]));const c=d(t[1]);console.log(JSON.stringify(c,null,2))'
```

Claims to check (names from [token-claims](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/reference/token-claims)):

| Claim | Must be |
|---|---|
| header `alg` / signature | `RS256`, key `kid` from `jwks_uri` in `https://confidentialcomputing.googleapis.com/.well-known/openid-configuration` (`https://www.googleapis.com/service_accounts/v1/metadata/jwk/signer@confidentialspace-sign.iam.gserviceaccount.com`) |
| `iss` | `https://confidentialcomputing.googleapis.com` |
| `aud` | `elyra:v3` (set by `router/tee.mjs`) |
| `exp` / `nbf` | in the future / not in the future |
| `eat_nonce` | contains `sha256(canonical {id,pub,box,wallet})` of this hello: binds the keys to the attestation |
| `swname` | `CONFIDENTIAL_SPACE` |
| `dbgstat` | `disabled-since-boot` (production image) |
| `secboot` | `true` |
| `hwmodel` | `GCP_AMD_SEV` or `GCP_INTEL_TDX` |
| `submods.container.image_digest` | **the digest you built** (the one buyers pin) |
| `submods.container.restart_policy` | `Never` or `OnFailure` |
| `submods.container.env_override` / `args` / `cmd_override` | only `ELYRA_PUBLIC_URL` / `LOG_LEVEL`; args = the fixed CMD |
| `submods.confidential_space.support_attributes` | contains `USABLE` (ideally `STABLE`); `monitoring_enabled.memory` = `false` |
| `submods.gce.project_id`, `zone`, `instance_name` | yours |

The real check, all of the above in one call, using the project's verifier (run in the repo root; it fetches Google's JWKS):

```bash
node --input-type=module -e '
import fs from "node:fs";
import { verifyGcpToken, bindingNonce } from "./router/tee.mjs";
const h = JSON.parse(fs.readFileSync("hello.json"));
const DIGEST = process.argv[1];
const r = await verifyGcpToken(h.attestation.token, { allowedImages: [DIGEST] },
  { binding: bindingNonce({ id: h.id, pub: h.pub, box: h.box.pub, wallet: h.wallet?.address }) });
console.log(r);' "sha256:<your digest>"
```

`ok: true` with `image` equal to your digest closes the loop. If `image` differs from the registry digest (§3), pin the token's value and tell buyers.
(Token field limits from the docs: a nonce is 8–88 bytes in the claims reference, 10–74 bytes in the flow page; Elyra's 64-hex nonce is inside both ranges.)

## 10. Make buyers trust the digest

The trust list is the **buyer's** (a seller cannot add itself). On each buyer's node (control API is loopback-only):

```bash
curl -X PUT http://localhost:8545/api/trust -H 'content-type: application/json' \
  -d '{"allowedImages":["sha256:<digest>"]}'
```

Give buyers the git commit, the `Dockerfile`, the pinned base digest and the image digest so they can rebuild/inspect and decide for themselves. Until a digest is pinned a buyer node reports `no trusted image digests configured`
and shows the peer's TEE as `claimed`, not `verified`. Every release changes the digest: publish it, buyers add it, keep the old one only while you still run the old VM.

## 11. Restart, rotation, updates

* Identity (ed25519), box key (X25519) and wallet are generated **inside the VM on first boot** into `/var/elyra`. Nothing persistent leaves the VM: a stop/start, `OnFailure` restart, or redeploy gives a **new node id, box key, wallet and token**. Buyers see a new peer; reputation does not carry over; old vouchers are void (see §0.2).
* Token lifetime: the node refreshes its custom-audience token when < 20 min remain (`router/core/attestation.mjs`). Quota: **5 queries/s/project/region** for Google Cloud Attestation ([connect-external-resources](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/connect-external-resources)); one node uses a negligible fraction, but a fleet in one project/region, or minting a token per request, will not.
* Update = build → new digest → create a **new** VM with the new digest → buyers add the new digest → delete the old VM. Long-lived VMs on an old Confidential Space image lose `LATEST`/`STABLE` support attributes (≈ one month / six months); redeploy periodically (`gcloud compute images list --project=confidential-space-images --no-standard-images --filter="family~'confidential-space$'"`).
* Graceful stop: the launcher sends SIGTERM and waits up to 120 s. Flush and exit on SIGTERM (the node already flushes state on close).

## 12. Cost and risk

**Cost drivers** (no prices here, intentionally; use the [Google Cloud pricing calculator](https://cloud.google.com/products/calculator) and each product's pricing page for your region):

* **VM hours** of the chosen machine type, billed while the instance exists/runs, including idle time. Confidential VM can carry its own pricing line on top of plain Compute Engine; check the Confidential VM pricing page. A CPU-model node needs a large-RAM machine, so this is the dominant driver.
* **Boot disk** (`--boot-disk-size`, persistent disk). Confidential Space keeps ~1% of disk bytes as integrity tags *in RAM* (docs), so 30 GB ≈ 0.3 GB of RAM; and the image (incl. model) must fit: stateful partition ≈ disk − 5 GB.
* **Network egress** (answers, gossip, image pulls across regions), plus any load balancer / NAT / static IP you add.
* **Artifact Registry** storage and Cloud Build minutes; multi-GB images with embedded models make this visible.
* **Cloud Logging** ingestion/retention for redirected logs.
* **Attestation quota**: 5 qps per project per region (see §11). Not a price; a ceiling.
* GPU (if ever): accelerator VM, **spot/flex-start only** and scarce quota, see `model-server.md`.
* On-chain: ETH gas to redeem, paid from the in-VM wallet.

**Operational risks**: wallet/identity loss on restart (§0.2); `ELYRA_PUBLIC_URL` and bootstrap not wired (§0.1); non-root socket access and writable rootfs untested (§0.5-6); boot time grows with RAM and image size; the VM auto-stops when the workload exits on production (return code 0/1) unless `OnFailure`.
**Stop billing**: `gcloud compute instances delete elyra-tee-1 --zone="$ZONE"` (also removes the identity inside). Stopping keeps disk charges.

## 13. What this does and does not protect

| Threat | Protected? | Why / caveat |
|---|---|---|
| Cloud operator / VM admin reading prompts in RAM or disk | **Yes** | Confidential VM memory encryption; Confidential Space production image has no SSH/remote shell and encrypted, integrity-protected disk partitions with a per-boot key (docs: images, overview) |
| The **seller** (workload operator) reading prompts | **Yes, if the checks hold** | `allow_cmd_override=false`, restricted env, no debug (`dbgstat`), memory monitoring `never`, digest pinned by the buyer. Seller can still read *logs* (we log metadata only), see traffic metadata and sizes, and choose when to stop the VM |
| Seller swapping in modified code | **Yes** | Different code ⇒ different image digest ⇒ buyer's pin fails |
| Network observers reading prompts | Yes | sealed envelope (X25519 + AES-GCM) bound to a key attested by the token |
| **Google** (root of trust: hardware attestation service, firmware, launcher, image) | **No** | You must trust Google Cloud Attestation to sign honest tokens and the platform to be what it says |
| CPU vendor (AMD/Intel) | **No** | Same: the TEE hardware is the root of trust |
| Side channels, speculative-execution and physical attacks on SEV/TDX | **No** | Not addressed here or by Confidential Space; TDX/SEV have published attacks, none claimed fixed here |
| Model server **outside** the attested workload | **No** | The node refuses non-local upstreams in TEE mode (`router/core/upstreams.mjs`), but `isLocalUrl` also accepts private-LAN IPs. Only a model **inside the same container** keeps the claim honest (see `model-server.md`). A model behind OpenRouter/OpenAI/Ollama-elsewhere is not protected |
| Output/metadata leakage (timing, token counts, prices, wallet activity on-chain) | **No** | Visible to anyone on the path or chain; the token-count bill is by design |
| Funds, payout and uptime | **No** | TEE says nothing about availability, honest answers, or wallet loss on restart (§0.2) |
| A buyer who never pinned a digest | **No** | Without `allowedImages` the node shows `claimed`, not `verified` |

## 14. Hardening options (not enabled)

* `LABEL tee.launch_policy.nonroot_container="nonrootonly"` plus metadata `tee-nonroot-container=true`: runs the container in an isolated user namespace as an unprivileged user on the host VM. Needs Confidential Space image `confidential-space-261001`+ (older images ignore it and run as root). Interaction with the launcher socket and the writable data dir is **UNCONFIRMED**; test first.
* `tee.launch_policy.log_redirect=never`: operator-blind build (no logs at all).
* `tee-signed-image-repos` + verifier support for `image_signatures` (§4).

## 15. UNCONFIRMED (summary)

1. `tee-image-reference` accepts `repo@sha256:…` (docs show tags only).
2. `submods.container.image_digest` equals the registry manifest digest of the pushed image.
3. uid 1000 can access `/run/container_launcher/teeserver.sock`.
4. Container rootfs / `/var/elyra` is writable.
5. Cloud Build recipe in §3 (untested sketch), including BuildKit-only `Dockerfile.dockerignore` handling.
6. OIDC tokens for cosign-signed images: whether `image_digest` is present alongside `image_signatures`.
7. `nonroot_container` + socket + data dir behaviour.
8. GPU inference inside Confidential Space for Elyra (see `model-server.md`).
9. Exact prices (deliberately not stated).

## Sources

* Overview: https://docs.cloud.google.com/confidential-computing/confidential-space/docs/confidential-space-overview
* Deploy workloads (gcloud, SA roles, GPU): https://docs.cloud.google.com/confidential-computing/confidential-space/docs/deploy-workloads
* Metadata variables: https://docs.cloud.google.com/confidential-computing/confidential-space/docs/reference/metadata-variables
* Launch policies: https://docs.cloud.google.com/confidential-computing/confidential-space/docs/reference/launch-policies
* Create and customize workloads (ports, labels, signing, non-root, limits): https://docs.cloud.google.com/confidential-computing/confidential-space/docs/create-customize-workloads
* Attestation tokens / launcher socket / quota / JWKS: https://docs.cloud.google.com/confidential-computing/confidential-space/docs/connect-external-resources
* Token claims: https://docs.cloud.google.com/confidential-computing/confidential-space/docs/reference/token-claims
* Images and lifecycle: https://docs.cloud.google.com/confidential-computing/confidential-space/docs/confidential-space-images
* Monitor and debug (logs, return codes): https://docs.cloud.google.com/confidential-computing/confidential-space/docs/monitor-debug
* First environment (SA roles, digest, flags): https://docs.cloud.google.com/confidential-computing/confidential-space/docs/create-your-first-confidential-space-environment
* Confidential VM supported configurations: https://docs.cloud.google.com/confidential-computing/confidential-vm/docs/supported-configurations
