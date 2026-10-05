#!/usr/bin/env bash
# Deploy the current checkout to Fly.io.
#
# This is the deployment half of the Fly.io integration: it assumes the app,
# volume and Google secrets were already created by scripts/fly-setup.sh and
# simply pushes the current branch/commit, verifies the deploy, and prints the
# URL. Safe to run from a CI worker or locally, and safe to run repeatedly.
#
# Usage: scripts/fly-deploy.sh [--app NAME] [--region CODE] [--wait SECONDS]
#
# Configuration is read from the environment:
#   FLY_API_TOKEN          required in CI; locally the script falls back to fly auth login
#   FLY_APP                overrides the app name in fly.toml
#   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ADMIN_EMAILS
#                          forwarded as secrets when set, so a single env file can drive deploys
set -euo pipefail

cd "$(dirname "$0")/.."

APP=""
REGION=""
WAIT_SECONDS=120
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --wait) WAIT_SECONDS="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { echo "$*" >&2; exit 1; }

# ---- 1. sanity checks ------------------------------------------------------
[ -f fly.toml ] || die "fly.toml not found; run this from the repository root"
[ -f Dockerfile ] || die "Dockerfile not found"
[ -f scripts/fly-setup.sh ] || die "scripts/fly-setup.sh not found; use that for first-time setup"

TOML_APP=$(sed -n 's/^app *= *"\(.*\)"/\1/p' fly.toml | head -1)
APP=${APP:-${FLY_APP:-$TOML_APP}}
[ -n "$APP" ] || die "could not determine app name from --app, FLY_APP or fly.toml"

# Pin the deploy to the exact commit so CI and local runs are reproducible
COMMIT=$(git rev-parse --short HEAD)
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ -n "$COMMIT" ] || die "not in a git repository"
say "Deploying $APP from $BRANCH ($COMMIT)"

# ---- 2. flyctl -------------------------------------------------------------
if ! command -v fly >/dev/null 2>&1; then
  if [ -x "$HOME/.fly/bin/fly" ]; then
    export PATH="$HOME/.fly/bin:$PATH"
  else
    say "Installing flyctl"
    curl -L https://fly.io/install.sh | sh
    export PATH="$HOME/.fly/bin:$PATH"
  fi
fi
fly version

# ---- 3. authentication ----------------------------------------------------
if [ -n "${FLY_API_TOKEN:-}" ]; then
  say "Using FLY_API_TOKEN from the environment"
elif fly auth whoami >/dev/null 2>&1; then
  say "Already signed in as $(fly auth whoami)"
else
  say "Signing in: open the URL flyctl prints and approve it"
  fly auth login
fi

# ---- 4. make sure the app exists ------------------------------------------
if ! fly apps list --json 2>/dev/null | grep -q "\"Name\": *\"$APP\""; then
  die "App $APP does not exist. Run scripts/fly-setup.sh first to create it."
fi

# ---- 5. keep fly.toml in sync with the chosen app and its hostname --------
HOST=$(fly status --app "$APP" --json 2>/dev/null | sed -n 's/.*"Hostname": *"\([^"]*\)".*/\1/p' | head -1)
HOST=${HOST:-$APP.fly.dev}
BASE_URL="https://$HOST"
say "Public origin: $BASE_URL"

# Build a temporary fly.toml so the repo file stays untouched
TMP_TOML=$(mktemp)
trap 'rm -f "$TMP_TOML"' EXIT
cp fly.toml "$TMP_TOML"
sed -i.bak "s/^app *= *\".*\"/app = \"$APP\"/" "$TMP_TOML" && rm -f "$TMP_TOML.bak"
sed -i.bak "s#^  BASE_URL *= *\".*\"#  BASE_URL = \"$BASE_URL\"#" "$TMP_TOML" && rm -f "$TMP_TOML.bak"

# ---- 6. secrets -----------------------------------------------------------
SECRETS=()
for v in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET ADMIN_EMAILS SESSION_SECRET MAX_IMPORT_MB \
         MACHINES_PER_USER MACHINES_TOTAL MACHINE_CPUS MACHINE_MEMORY_MB MACHINE_MAX_MINUTES \
         MACHINE_IDLE_SECONDS MACHINE_MAX_DEPTH MACHINE_STOCKFISH_FLAVOR MACHINE_USERS \
         STOCKFISH_FLAVOR DEEPEN EXPLORE; do
  if [ -n "${!v:-}" ]; then SECRETS+=("$v=${!v}"); fi
done
if [ ${#SECRETS[@]} -gt 0 ]; then
  say "Staging ${#SECRETS[@]} secret(s) for the next deploy"
  fly secrets set --app "$APP" --stage "${SECRETS[@]}"
fi

# ---- 7. deploy -------------------------------------------------------------
say "Deploying $APP"
fly deploy --app "$APP" --config "$TMP_TOML" --remote-only

# ---- 8. verify -------------------------------------------------------------
say "Waiting for health check (up to ${WAIT_SECONDS}s)"
URL="$BASE_URL/api/health"
ok=0
for i in $(seq 1 "$WAIT_SECONDS"); do
  if curl -fsS "$URL" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done

fly status --app "$APP"
if [ "$ok" = 1 ]; then
  say "Live at $BASE_URL"
  curl -fsS "$URL" || true
  echo
else
  say "Health check did not pass within ${WAIT_SECONDS}s"
  echo "Check the logs: fly logs --app $APP"
  exit 1
fi
