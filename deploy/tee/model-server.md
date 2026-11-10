# Running the model server INSIDE the attested workload

Why this matters: the attestation only covers the **one container** that Confidential Space measured. The node already refuses
non-local upstreams in TEE mode (`router/core/upstreams.mjs`), but a model server on another VM, a managed API, or "Ollama on the operator's laptop"
would see every decrypted prompt outside the TEE. The privacy claim is true only if the model runs **in the same container image
(same digest)** as `router/server.mjs`.

## 1. Constraints from the docs

* **One container per VM.** The Confidential Space launcher runs a single workload container, started from `tee-image-reference` ([overview: "a containerized image"](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/confidential-space-overview), [deploy-workloads](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/deploy-workloads); there is no multi-container/sidecar metadata key in the metadata-variables table). A second container (docker-compose style) is therefore **not an option**. I found no statement that says "sidecars are impossible" word for word; this follows from the single `tee-image-reference` and the metadata-variables list.
* **Swap is disabled** (docs): running out of RAM crashes the workload. Plan RAM for model + KV cache + Node.
* **Disk integrity tags cost ~1 % of disk size in RAM** (docs). A 100 GB disk ⇒ 1 GB RAM.
* **Stateful partition ≈ boot disk − 5 GB** (docs): the image (with model) plus the container writable layer must fit inside it.
* **No persistent storage / one run per VM**: the model is loaded from the image on every boot; it cannot be "downloaded once and kept".
* **Egress to the internet from the workload is not blocked by the docs I read**, but fetching a model at runtime would put an unattested, mutable dependency into the TEE (see §5). Download at **build time** instead.
* **Launch policies** make the entrypoint fixed (`allow_cmd_override=false`), so the multi-process logic must live in the image.

## 2. Realistic options

| Option | How | Verdict |
|---|---|---|
| **A. One image, two processes, supervised by a tiny entrypoint** | Bake a `llama-server` (llama.cpp) binary + a GGUF model + Node into the same image. Entry point starts `llama-server` on `127.0.0.1:8080`, waits for it to be healthy, configures the node's upstream, then runs `node router/server.mjs` in the foreground. If either dies, the container exits (and `tee-restart-policy` decides what happens). | **Recommended.** The model weights are inside the image digest, so a buyer pinning the digest also pins the model. |
| B. Node-only entrypoint that spawns the model | `router/` (or a small launcher script) `spawn`s `llama-server` itself. | Equivalent to A; needs a `router/` change. A shell/Node supervisor script in the image is simpler. |
| C. Second container / sidecar | – | **Not possible** in Confidential Space (one workload container). |
| D. Remote model | Model on another VM/provider | **Breaks the TEE claim.** The node refuses non-local upstreams in TEE mode (but accepts private-LAN IPs: do not point it at another machine on your VPC). |
| E. GPU (NVIDIA H100) inside the workload | see §6 | **Unconfirmed for Elyra**; not recommended yet. |

## 3. Option A: concrete layout

llama.cpp's server is OpenAI-compatible (`/v1/chat/completions`, `/v1/models`; [server README](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)), which is exactly what `router/core/exec-local.mjs` expects from an upstream (`baseUrl/chat/completions`, `baseUrl/models`).
Pin llama.cpp to a **release tag or commit hash** (placeholder below). The README I read is the moving `master`; every flag below must be re-checked against the pinned version (**UNCONFIRMED**).

`deploy/tee/Dockerfile.model` (create it when you adopt this option; it extends the main Dockerfile, shown here in full so nothing is implicit):

```dockerfile
# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:<PIN-ME>

# ---- build llama-server from a PINNED source commit (no prebuilt binary of unknown origin) ----
FROM ${NODE_IMAGE} AS llama
ARG LLAMA_CPP_COMMIT=<PIN-ME-40-hex>
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git init /src && cd /src && git remote add origin https://github.com/ggml-org/llama.cpp \
 && git fetch --depth 1 origin "$LLAMA_CPP_COMMIT" && git checkout FETCH_HEAD
# Portable CPU build: do NOT tune for the build machine. TDX VMs may expose limited CPUID (Confidential VM docs),
# and the VM family (Milan/Genoa/Turin/Sapphire Rapids) is chosen at deploy time. Flag names: UNCONFIRMED for your commit.
RUN cd /src && cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF -DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON \
      -DBUILD_SHARED_LIBS=OFF -DLLAMA_CURL=OFF \
 && cmake --build build --target llama-server -j"$(nproc)" \
 && strip build/bin/llama-server

# ---- fetch the model at BUILD time, verify its sha256 ----
FROM ${NODE_IMAGE} AS model
ARG MODEL_URL=<PIN-ME: direct https URL of ONE .gguf file at an immutable revision (e.g. a Hugging Face URL containing a commit hash, not 'main')>
ARG MODEL_SHA256=<PIN-ME-64-hex>
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN curl -fL --retry 3 -o /model.gguf "$MODEL_URL" \
 && echo "${MODEL_SHA256}  /model.gguf" | sha256sum -c -

# ---- Elyra node (same steps as deploy/tee/Dockerfile) ----
FROM ${NODE_IMAGE} AS app
WORKDIR /srv/elyra
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY router/ router/
COPY panel/ panel/
COPY contracts/artifacts/ElyraEscrow.json contracts/artifacts/ElyraEscrow.json
RUN rm -rf router/test

# ---- final ----
FROM ${NODE_IMAGE}
WORKDIR /srv/elyra
COPY --from=app /srv/elyra /srv/elyra
COPY --from=llama /src/build/bin/llama-server /usr/local/bin/llama-server
COPY --from=model /model.gguf /opt/model/model.gguf
COPY deploy/tee/entrypoint.sh /usr/local/bin/elyra-entrypoint.sh
RUN chmod 0555 /usr/local/bin/elyra-entrypoint.sh && mkdir -p /var/elyra && chown node:node /var/elyra
USER node
ENV ELYRA_TEE=gcp-confidential-space NODE_ENV=production
EXPOSE 8545
# same launch-policy labels as deploy/tee/Dockerfile (copy that block verbatim, with its comments)
LABEL "tee.launch_policy.allow_env_override"="ELYRA_PUBLIC_URL,LOG_LEVEL"
LABEL "tee.launch_policy.allow_cmd_override"="false"
LABEL "tee.launch_policy.allow_capabilities"="false"
LABEL "tee.launch_policy.allow_cgroups"="false"
LABEL "tee.launch_policy.log_redirect"="always"
LABEL "tee.launch_policy.monitoring_memory_allow"="never"
ENTRYPOINT ["/usr/local/bin/elyra-entrypoint.sh"]
CMD ["--host","0.0.0.0","--no-demo","--data","/var/elyra"]
```

`entrypoint.sh` (supervisor; **sketch, untested**). Note it keeps `llama-server` on loopback only and never enables llama.cpp's prompt-logging or UI features:

```sh
#!/bin/sh
set -eu
THREADS="$(nproc)"
# 127.0.0.1 ONLY: the node (same container, same network namespace) is the single client.
# --no-webui: no static UI. --no-slots: no /slots monitoring endpoint. --offline: never touch the network.
# NEVER pass --log-prompts-dir, -v/--verbose, or --api-key-file with secrets: prompts must not reach logs (AGENTS.md rule 3).
llama-server -m /opt/model/model.gguf --host 127.0.0.1 --port 8080 \
  -c 4096 -t "$THREADS" -np 2 --no-webui --no-slots --offline &
LLAMA_PID=$!
# wait until the model is loaded (llama-server answers /health only when ready; verify for your pinned version)
i=0; until node -e 'fetch("http://127.0.0.1:8080/health").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))'; do
  i=$((i+1)); [ "$i" -gt 300 ] && { echo "model server did not become ready"; exit 1; }
  kill -0 "$LLAMA_PID" 2>/dev/null || { echo "model server exited"; exit 1; }
  sleep 1
done
node router/server.mjs "$@" &
NODE_PID=$!
trap 'kill -TERM "$NODE_PID" "$LLAMA_PID" 2>/dev/null' TERM INT
# exit as soon as either process dies, so the launcher sees a failure instead of a half-working node
wait -n "$NODE_PID" "$LLAMA_PID" 2>/dev/null || true
kill -TERM "$NODE_PID" "$LLAMA_PID" 2>/dev/null || true
exit 1
```

(Readiness probe uses `node` because `wget`/`curl` are not in `node:*-slim`. `wait -n` is not POSIX `sh`: use `#!/bin/bash` and install bash (it is in the Debian base) or poll with `kill -0`. The loopback API bootstrap below must still be written. All **UNTESTED**.)

**Telling the node about the upstream.** The node starts with no upstream and `provide.enabled=false`; upstreams and provider settings are only settable through the **loopback** control API (`POST /api/upstreams`, `PUT /api/provide`, field names in `router/http/api.mjs`). From inside the container those calls pass the node's loopback/`Host` checks. Either (a) the entrypoint performs them after the node is up (`baseUrl=http://127.0.0.1:8080/v1`), or (b) the node reads boot-time env/config. Either way it is part of the image, hence attested. **This bootstrap does not exist yet** (see README §0.1). In TEE mode the node accepts only local upstream URLs; `127.0.0.1` qualifies.

## 4. Sizing

Rules of thumb (not measurements; no benchmark was run for this document):

* **RAM ≈ GGUF file size + KV cache + ~1–2 GB** (Node + runtime + page cache). KV cache grows with context length × parallel slots (`-c`, `-np`); a 4k context on a small model is tens to a few hundred MB. Add ~1 % of the boot disk size for Confidential Space integrity tags. No swap.
* **Image size ≈ GGUF + llama-server (tens of MB) + Node base (~200 MB) + deps.** The VM must pull this on every boot, which lengthens start-up; the boot disk must hold it (≥ image + headroom; partition = disk − 5 GB).
* **CPU only** means tokens/s is limited: expect interactive speed only for small, 4-bit-quantised models. Choose enough vCPUs to keep the matmul threads busy; more `-np` slots share the same cores.
* Recommended **model class**: **1–3 B parameter instruct models in 4-bit GGUF (e.g. Q4_K_M, roughly 1–2.5 GB)**; ≤ 8 B Q4 (≈ 4.5–5.5 GB) if you accept slower answers and a bigger machine. Pick one with a permissive licence that allows serving it commercially, and advertise exactly the model id the server reports. 4B–8B on CPU is usable for non-latency-critical sellers. Do not advertise a bigger model than the one inside the image.
* A starting VM: 4–8 vCPU with 16–32 GB RAM for ≤ 3 B Q4 (N2D/C2D/C3D for SEV, C3/C4 for TDX); measure, then resize. `swap` does not exist, so leave margin.

## 5. Model download: pin and verify

* **Fetch at build time**, never at boot: a boot-time download is an unmeasured, mutable input (the digest would not cover what actually runs) and needs outbound access from the TEE. `--offline` in the entrypoint prevents llama.cpp itself from reaching out.
* **Pin the exact bytes**: an immutable URL (commit/revision hash, not `main`) **and** the file's `sha256`, checked with `sha256sum -c` in the build (as above). The build fails on any change.
* **Record provenance** next to the image digest you give buyers: model repo + revision + sha256 + licence + llama.cpp commit.
* Hugging Face URLs in the form `https://huggingface.co/<org>/<repo>/resolve/<commit-sha>/<file>.gguf` pin a revision; the sha256 shown on the file page (LFS) is the value to copy. I did not verify any specific model's URL or hash: **fill these in yourself.**
* `llama-server -hf/--hf-repo` / `-mu` would download at start: **do not use**.
* Gated models need a token at build time only; never bake it into the image (use a BuildKit secret mount) and never pass it as `tee-env-*`.

## 6. GPU inference inside Confidential Space

What the Google docs state ([deploy-workloads → GPU-based workloads](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/deploy-workloads), [token-claims](https://docs.cloud.google.com/confidential-computing/confidential-space/docs/reference/token-claims), [supported configurations](https://docs.cloud.google.com/confidential-computing/confidential-vm/docs/supported-configurations)):

* **Confirmed:** Confidential Space supports **NVIDIA Confidential Computing on H100 GPUs only**, on **Intel TDX**, machine type `a3-highgpu-1g`; zones `europe-west4-c`, `us-central1-a`, `us-east5-a` (A3 High list).
* **Confirmed:** you must pass `tee-install-gpu-driver=true`, use the **spot** or **flex-start** provisioning model (no on-demand example), a boot disk of **30 GB or more**, and have GPU quota (preemptible GPU quota + `GPUs (all regions)`). The workload container must bring the CUDA-X libraries (`LD_LIBRARY_PATH=/usr/local/nvidia/lib64`).
* **Confirmed:** tokens then carry `submods.nvidia_gpu.{cc_feature,cc_mode,gpus[]}` (`SPT` single-GPU passthrough only; `cc_mode` `ON`; `hwmodel` `GCP_NVIDIA_H100`). **`router/tee.mjs` does not check these claims today**, so a buyer verifier would not know whether the GPU was in CC mode.
* **Confirmed known issues:** "GPU Driver installation is not supported" on first boot (workaround: restart the VM); GPU attestation can fail with a mismatched measurement record at index 9 (workaround: full stop/start). A3 High has no reservations; multi-node clusters unsupported.
* **Other GPU types:** `g4-standard-48` (RTX Pro 6000) is a Confidential VM type with NVIDIA CC in the general Confidential VM docs, but the **Confidential Space** docs say H100 only. **UNCONFIRMED** whether G4 works with Confidential Space.

**UNCONFIRMED (cannot be verified from docs or from this machine):** that llama.cpp/CUDA (or any inference server) actually runs correctly and fast inside a Confidential Space container on an H100; GPU price, quota approval and spot preemption behaviour for a service that must stay up; image size with CUDA libraries (multi-GB); whether TDX + CC-mode GPU bounce-buffer overhead is acceptable for token latency; whether the Elyra verifier should require `nvidia_gpu.cc_mode == "ON"`. Treat GPU as a research item, not a deployment option. Note that preemption (spot) also destroys the node identity and wallet (README §0.2).

## 7. Honest checklist before advertising `tee: "verified"`

1. Model + `llama-server` + node are in **one** image; digest published with commit, base digest, llama.cpp commit, model URL + sha256.
2. `llama-server` listens on `127.0.0.1` only; no `--log-prompts-dir`, no verbose logging, UI/slots disabled.
3. Upstream configured is `http://127.0.0.1:…`; nothing in the image calls out to a remote model.
4. Production Confidential Space image family; token shows `dbgstat: disabled-since-boot`, `submods.container.image_digest` = your digest, no unexpected `env_override`.
5. A buyer verified the token with their own trust list (README §9–10).
