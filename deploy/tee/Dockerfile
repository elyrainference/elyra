# syntax=docker/dockerfile:1.7
#
# Elyra seller node, packaged as the single workload container of a Google Cloud Confidential Space VM.
#
# Build context = repository root:
#   docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
#     -f deploy/tee/Dockerfile -t REGION-docker.pkg.dev/PROJECT/REPO/elyra-node:TAG --push .
# (--provenance=false --sbom=false keep the pushed result a single image manifest, so the digest you read back
#  is the one the launcher reports; see deploy/tee/README.md.)
#
# ---------------------------------------------------------------------------------------------------------
# HOW TO PIN THE BASE IMAGE (do this before every release build; the build is only as trustworthy as this pin)
#   docker buildx imagetools inspect node:22-bookworm-slim          # prints "Digest: sha256:..." (index digest)
#   -> replace <PIN-ME> below with that value. Pinning the index digest keeps the linux/amd64 pick deterministic.
#   Re-pin deliberately (security updates); a moving tag would silently change what buyers are trusting.
# ---------------------------------------------------------------------------------------------------------
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:<PIN-ME>

# ---- stage 1: dependencies + tree with tests removed ----------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /srv/elyra
COPY package.json package-lock.json ./
# Lockfile-exact, production-only install: the only runtime dependency is ethers. No dev tooling in the image.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# Only what the TEE node serves: peer protocol + health endpoint code, the control panel assets (served only
# on loopback, i.e. never reachable from outside) and the one contract artifact chain.mjs reads at start-up.
# NOT copied: index.html / wp-* landing mirror, contracts sources, docs, tests, dot-directories.
COPY router/ router/
COPY panel/ panel/
COPY contracts/artifacts/ElyraEscrow.json contracts/artifacts/ElyraEscrow.json
# router/test must never ship (also listed in Dockerfile.dockerignore). Removing it here makes that independent of
# the build front-end: the final stage copies from this stage, so the test files are in no layer at all.
RUN rm -rf router/test

# ---- stage 2: runtime ------------------------------------------------------------------------------------
FROM ${NODE_IMAGE}
WORKDIR /srv/elyra
COPY --from=build --chown=root:root /srv/elyra /srv/elyra
# Data dir for identity.json / wallet.json / state. It lives on the VM's encrypted stateful partition and is
# NOT persistent across VM restarts (a Confidential Space VM runs the workload once; a restart = new disk key,
# new identity). Owned by the unprivileged user so the node never needs root.
RUN mkdir -p /var/elyra && chown node:node /var/elyra
USER node

# Selects the Confidential Space attestation producer/verifier in router/tee.mjs; the node reads the launcher
# socket /run/container_launcher/teeserver.sock. Baked into the image => part of what the digest commits to,
# and NOT in allow_env_override below, so the operator cannot switch attestation off.
ENV ELYRA_TEE=gcp-confidential-space
ENV NODE_ENV=production

# Inbound port. Confidential Space VMs block ALL inbound ports by default; EXPOSE is what keeps this one open
# (image >= 230600). Changing EXPOSE changes the digest, so buyers must re-pin after any change.
EXPOSE 8545

# ---------------------------------------------------------------------------------------------------------
# LAUNCH POLICY LABELS. These are enforced by the Confidential Space launcher against the VM metadata the
# (untrusted) operator sets, and the resulting facts show up in the attestation token, so a buyer who pins the
# image digest also pins this policy (the labels are part of the image config that the digest covers).
# Source: https://docs.cloud.google.com/confidential-computing/confidential-space/docs/reference/launch-policies
# ---------------------------------------------------------------------------------------------------------

# allow_env_override: comma-separated NAMES the operator may set via tee-env-NAME metadata. Everything else is
# ignored by the launcher. Kept to two harmless names: the public URL the node advertises to peers, and log
# verbosity. Deliberately NOT allowed: ELYRA_TEE (would disable attestation), ELYRA_TEE_SOCKET (would let the
# operator point the node at a fake token server), ELYRA_PASSPHRASE, NODE_OPTIONS, LD_PRELOAD, PATH,
# HTTP(S)_PROXY, anything that changes code, keys or where traffic goes. Overrides that are applied are
# reported in the token (container.env_override) so a verifier can see them.
LABEL "tee.launch_policy.allow_env_override"="ELYRA_PUBLIC_URL,ELYRA_SEEDS,ELYRA_ESCROW,ELYRA_NETWORK,ELYRA_PAYOUT,ELYRA_PROVIDE,ELYRA_PROVIDE_PRICE,ELYRA_UPSTREAM_URL,ELYRA_UPSTREAM_NAME,LOG_LEVEL"

# allow_cmd_override=false (the documented default, set explicitly so the intent is reviewable): the operator
# cannot replace CMD with tee-cmd, so they cannot start a different program (e.g. one that logs prompts) inside
# the attested image. Without this a buyer would be trusting the operator's command line, not just the image.
LABEL "tee.launch_policy.allow_cmd_override"="false"

# Capabilities and cgroups stay at their default (false): no extra Linux capabilities, no cgroup mount for the
# workload. Explicit so a future edit has to change a visible line (and therefore the digest).
LABEL "tee.launch_policy.allow_capabilities"="false"
LABEL "tee.launch_policy.allow_cgroups"="false"

# log_redirect=always: lets the operator send stdout/stderr to Cloud Logging on the PRODUCTION image (default
# 'debugonly' would give a seller no logs at all). Trust consequence: the OPERATOR can read everything the node
# prints. That is acceptable only because router/obs.mjs never logs prompts, completions, keys or API keys
# (AGENTS.md rule 3/7). Set to "never" for a build whose operator you want blind (then you cannot debug it).
# Valid values per docs: debugonly (default) | always | never.
LABEL "tee.launch_policy.log_redirect"="always"

# monitoring_memory_allow=never: the docs warn that enabling memory monitoring exposes total workload memory
# usage to the operator in Cloud Logging / Metrics Explorer. With an in-VM model, memory use correlates with
# prompt length, so keep this closed. Valid values: debugonly (default) | always | never.
LABEL "tee.launch_policy.monitoring_memory_allow"="never"

# Not set (left at documented defaults): allow_mount_destinations (no operator tmpfs mounts) and nonroot_container
# (unrestricted). See README "Hardening options" for nonroot_container=nonrootonly.

# Fixed command; allow_cmd_override=false makes it impossible to change at deploy time.
#   --host 0.0.0.0   listen on the VM NIC (the container has its own network namespace)
#   --no-demo        never advertise the simulated market from inside a TEE
#   --data /var/elyra   identity + wallet + state (ephemeral, see above)
CMD ["node","router/server.mjs","--host","0.0.0.0","--no-demo","--data","/var/elyra"]
