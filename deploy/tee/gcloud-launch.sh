#!/usr/bin/env bash
# Elyra seller node on Google Cloud Confidential Space: provision + launch.
#
#   ./gcloud-launch.sh                 # --dry-run (default): only PRINTS every command
#   ./gcloud-launch.sh --apply         # actually runs them
#
# Required environment (no secrets are read, stored or printed by this script):
#   PROJECT           GCP project that runs the VM (the "workload operator" project)
#   ZONE              e.g. us-central1-a  (must offer the chosen machine type + CC technology)
#   IMAGE_DIGEST_REF  immutable reference, e.g. us-docker.pkg.dev/MYPROJ/elyra/elyra-node@sha256:<64 hex>
#   MACHINE_TYPE      e.g. n2d-standard-4 (SEV) | c3-standard-4 (TDX)
#   CC_TYPE           SEV | TDX
#   SA                service account id (e.g. elyra-tee) or full e-mail
# Optional:
#   INSTANCE=elyra-tee-1   IMAGE_FAMILY=confidential-space (production; never the -debug family for real use)
#   RESTART_POLICY=OnFailure (Never|OnFailure; NOT Always: router/tee.mjs rejects tokens with restart_policy=Always)
#   BOOT_DISK_GB=30         ELYRA_PUBLIC_URL=https://seller.example   LOG_LEVEL=info
#   SIGNED_IMAGE_REPOS=     comma-separated repos holding cosign signatures (metadata tee-signed-image-repos)
#   FIREWALL_SOURCE=0.0.0.0/0   source range allowed to reach tcp:8545 (put a TLS proxy/LB here when you can)
#   MIN_CPU_PLATFORM=       default "AMD Milan" for n2d/c2d (as in Google's examples), empty otherwise
#   SKIP_SETUP=1            skip API enablement / service account / IAM / firewall (VM create only)
#   NETWORK=default
# Sources: https://docs.cloud.google.com/confidential-computing/confidential-space/docs/deploy-workloads
#          https://docs.cloud.google.com/confidential-computing/confidential-space/docs/reference/metadata-variables
set -euo pipefail

MODE=dry
for a in "$@"; do
  case "$a" in
    --apply) MODE=apply ;;
    --dry-run) MODE=dry ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown argument: $a (use --dry-run or --apply)" >&2; exit 2 ;;
  esac
done

need() { [ -n "${!1:-}" ] || { echo "missing required env var: $1" >&2; exit 2; }; }
for v in PROJECT ZONE IMAGE_DIGEST_REF MACHINE_TYPE CC_TYPE SA; do need "$v"; done

INSTANCE="${INSTANCE:-elyra-tee-1}"
IMAGE_FAMILY="${IMAGE_FAMILY:-confidential-space}"
RESTART_POLICY="${RESTART_POLICY:-OnFailure}"
BOOT_DISK_GB="${BOOT_DISK_GB:-30}"
NETWORK="${NETWORK:-default}"
FIREWALL_SOURCE="${FIREWALL_SOURCE:-0.0.0.0/0}"
PORT=8545
NET_TAG="elyra-tee"

# ---- validation: fail before printing/doing anything misleading ----
[[ "$IMAGE_DIGEST_REF" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "IMAGE_DIGEST_REF must end in @sha256:<64 hex> (pin by digest, never a tag)" >&2; exit 2; }
[[ "$IMAGE_DIGEST_REF" != *"<"* ]] || { echo "IMAGE_DIGEST_REF still contains a placeholder" >&2; exit 2; }
case "$CC_TYPE" in SEV|TDX) ;; *) echo "CC_TYPE must be SEV or TDX" >&2; exit 2 ;; esac
case "$RESTART_POLICY" in Never|OnFailure) ;; Always) echo "RESTART_POLICY=Always is refused: router/tee.mjs rejects tokens carrying it" >&2; exit 2 ;; *) echo "RESTART_POLICY must be Never or OnFailure" >&2; exit 2 ;; esac
case "$IMAGE_FAMILY" in confidential-space) ;; confidential-space-debug) echo "WARNING: debug image family: SSH enabled, operator has root, token dbgstat=enabled; buyers will reject it." >&2 ;; *) echo "IMAGE_FAMILY must be confidential-space or confidential-space-debug" >&2; exit 2 ;; esac

# Machine type must match the CC technology (Confidential VM supported-configurations table).
case "$CC_TYPE:$MACHINE_TYPE" in
  SEV:n2d-*|SEV:c2d-*|SEV:c3d-*|SEV:c4d-*|SEV:g4-*) ;;
  TDX:c3-standard-*|TDX:c4-standard-*|TDX:a3-highgpu-1g) ;;
  *) echo "MACHINE_TYPE $MACHINE_TYPE is not a documented Confidential VM type for CC_TYPE=$CC_TYPE (SEV: n2d/c2d/c3d/c4d/g4; TDX: c3-standard-*/c4-standard-*/a3-highgpu-1g)" >&2; exit 2 ;;
esac
# Deploy doc: MIGRATE only for N2D machine types that use SEV; TERMINATE for everything else.
if [ "$CC_TYPE" = SEV ] && [[ "$MACHINE_TYPE" == n2d-* ]]; then MAINT=MIGRATE; else MAINT=TERMINATE; fi
if [ -z "${MIN_CPU_PLATFORM+x}" ]; then
  if [ "$CC_TYPE" = SEV ] && [[ "$MACHINE_TYPE" == n2d-* || "$MACHINE_TYPE" == c2d-* ]]; then MIN_CPU_PLATFORM="AMD Milan"; else MIN_CPU_PLATFORM=""; fi
fi

# gcloud multi-value metadata uses "~" as delimiter (^~^), so values must not contain it.
for v in ELYRA_PUBLIC_URL LOG_LEVEL SIGNED_IMAGE_REPOS; do
  [[ "${!v:-}" != *"~"* ]] || { echo "$v must not contain '~'" >&2; exit 2; }
done

if [[ "$SA" == *@* ]]; then SA_EMAIL="$SA"; else SA_EMAIL="${SA}@${PROJECT}.iam.gserviceaccount.com"; fi
SA_ID="${SA_EMAIL%%@*}"

# Artifact Registry repo parsed from the image ref: HOST/PROJECT/REPO/IMAGE@sha256:...
REF_PATH="${IMAGE_DIGEST_REF%@*}"
AR_HOST="${REF_PATH%%/*}"; REST="${REF_PATH#*/}"
AR_PROJECT="${REST%%/*}"; REST="${REST#*/}"
AR_REPO="${REST%%/*}"
AR_LOCATION=""
if [[ "$AR_HOST" == *-docker.pkg.dev ]]; then AR_LOCATION="${AR_HOST%-docker.pkg.dev}"; fi

# ---- metadata (^~^ custom delimiter) ----
META="tee-image-reference=${IMAGE_DIGEST_REF}"
META+="~tee-restart-policy=${RESTART_POLICY}"
META+="~tee-container-log-redirect=cloud_logging"   # Cloud Logging only; needs logging.logWriter; allowed by the image's log_redirect=always
[ -z "${SIGNED_IMAGE_REPOS:-}" ] || META+="~tee-signed-image-repos=${SIGNED_IMAGE_REPOS}"
[ -z "${ELYRA_PUBLIC_URL:-}" ] || META+="~tee-env-ELYRA_PUBLIC_URL=${ELYRA_PUBLIC_URL}"   # name is in the image's allow_env_override
[ -z "${LOG_LEVEL:-}" ] || META+="~tee-env-LOG_LEVEL=${LOG_LEVEL}"                           # name is in the image's allow_env_override

run() {
  printf '+'; printf ' %q' "$@"; printf '\n'
  if [ "$MODE" = apply ]; then "$@"; fi
}
note() { printf '\n# %s\n' "$*"; }

echo "# mode: $([ "$MODE" = apply ] && echo APPLY || echo 'DRY RUN (nothing is executed; pass --apply to run)')"
echo "# project=$PROJECT zone=$ZONE machine=$MACHINE_TYPE cc=$CC_TYPE instance=$INSTANCE sa=$SA_EMAIL"

if [ "${SKIP_SETUP:-0}" != 1 ]; then
  note "1. enable APIs (confidentialcomputing = attestation service, used by the launcher)"
  run gcloud services enable compute.googleapis.com confidentialcomputing.googleapis.com logging.googleapis.com artifactregistry.googleapis.com --project="$PROJECT"

  note "2. workload service account (attached to the VM; holds NO data-plane access beyond what is listed)"
  run gcloud iam service-accounts create "$SA_ID" --display-name="Elyra TEE workload" --project="$PROJECT"

  note "3. minimal IAM: attestation tokens, log writing, image pull"
  run gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${SA_EMAIL}" --role=roles/confidentialcomputing.workloadUser --condition=None
  run gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${SA_EMAIL}" --role=roles/logging.logWriter --condition=None
  if [ -n "$AR_LOCATION" ]; then
    run gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" --location="$AR_LOCATION" --project="$AR_PROJECT" --member="serviceAccount:${SA_EMAIL}" --role=roles/artifactregistry.reader
  else
    echo "# NOTE: could not derive an Artifact Registry location from '$AR_HOST'; grant roles/artifactregistry.reader on the repo to $SA_EMAIL manually."
  fi

  note "4. firewall: Confidential Space blocks inbound by default; the image EXPOSEs tcp:$PORT, the VPC rule must allow it too"
  run gcloud compute firewall-rules create elyra-tee-allow-p2p --project="$PROJECT" --network="$NETWORK" --direction=INGRESS --action=ALLOW --rules="tcp:${PORT}" --source-ranges="$FIREWALL_SOURCE" --target-tags="$NET_TAG"
fi

note "5. the Confidential Space VM (production image family, secure boot, single workload container)"
CREATE=(gcloud compute instances create "$INSTANCE"
  --project="$PROJECT" --zone="$ZONE"
  --confidential-compute-type="$CC_TYPE"
  --machine-type="$MACHINE_TYPE"
  --maintenance-policy="$MAINT"
  --shielded-secure-boot
  --image-project=confidential-space-images
  --image-family="$IMAGE_FAMILY"
  --boot-disk-size="${BOOT_DISK_GB}GB"
  --service-account="$SA_EMAIL"
  --scopes=cloud-platform
  --tags="$NET_TAG"
  --network="$NETWORK"
  --metadata="^~^${META}")
[ -z "$MIN_CPU_PLATFORM" ] || CREATE+=(--min-cpu-platform="$MIN_CPU_PLATFORM")
run "${CREATE[@]}"

note "6. afterwards"
echo "# logs:   gcloud logging read 'resource.type=\"gce_instance\" AND log_id(\"confidential-space-launcher\") AND resource.labels.instance_id=\"<INSTANCE_ID>\"' --project=$PROJECT --limit=50 --freshness=1h"
echo "# ip:     gcloud compute instances describe $INSTANCE --zone=$ZONE --project=$PROJECT --format='value(networkInterfaces[0].accessConfigs[0].natIP)'"
echo "# health: curl http://<IP>:$PORT/healthz"
echo "# delete: gcloud compute instances delete $INSTANCE --zone=$ZONE --project=$PROJECT   (VM hours stop billing; the identity inside is gone)"
