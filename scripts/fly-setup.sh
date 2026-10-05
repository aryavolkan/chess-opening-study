#!/usr/bin/env bash
# Set this app up on Fly.io, following https://fly.io/agent-ready.md:
# install flyctl, authenticate, create the app from the repository's fly.toml,
# give it a volume and its secrets, deploy, and print the URL. Safe to run
# again: every step checks what already exists.
#
# Usage: scripts/fly-setup.sh [--app NAME] [--region CODE] [--open] [--no-deploy]
#
# Configuration is read from the environment (never written to fly.toml):
#   FLY_API_TOKEN          skips the interactive login (a token the human made)
#   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ADMIN_EMAILS
#                          Sign in with Google; without them the site would be
#                          open to anyone, so the script refuses to deploy a
#                          public URL unless --open is given
#   SESSION_SECRET, MAX_IMPORT_MB, MACHINES_PER_USER, MACHINES_TOTAL, MACHINE_CPUS,
#   MACHINE_MEMORY_MB, MACHINE_MAX_MINUTES, MACHINE_IDLE_SECONDS, MACHINE_MAX_DEPTH,
#   MACHINE_STOCKFISH_FLAVOR, MACHINE_USERS, STOCKFISH_FLAVOR, DEEPEN, EXPLORE
#                          forwarded as secrets when set
set -euo pipefail

cd "$(dirname "$0")/.."
APP=""
REGION=""
OPEN=0
DEPLOY=1
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --open) OPEN=1; shift ;;
    --no-deploy) DEPLOY=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }

# ---- 1. flyctl -------------------------------------------------------------
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

# ---- 2. authentication ----------------------------------------------------
if [ -n "${FLY_API_TOKEN:-}" ]; then
  say "Using FLY_API_TOKEN from the environment"
elif fly auth whoami >/dev/null 2>&1; then
  say "Already signed in as $(fly auth whoami)"
else
  say "Signing in: open the URL flyctl prints and approve it (fly auth signup if you have no account)"
  fly auth login
fi

# ---- 3. the app -----------------------------------------------------------
TOML_APP=$(sed -n 's/^app *= *"\(.*\)"/\1/p' fly.toml | head -1)
TOML_REGION=$(sed -n 's/^primary_region *= *"\(.*\)"/\1/p' fly.toml | head -1)
APP=${APP:-$TOML_APP}
REGION=${REGION:-$TOML_REGION}

if fly apps list --json 2>/dev/null | grep -q "\"Name\": *\"$APP\""; then
  say "App $APP exists"
else
  say "Creating app $APP in $REGION from fly.toml (no database, no deploy yet)"
  if ! fly launch --copy-config --no-deploy --yes --name "$APP" --region "$REGION"; then
    echo "The name $APP is probably taken (app names are global). Run again with --app <another-name>." >&2
    exit 1
  fi
fi
# fly launch may have rewritten fly.toml with the final name
sed -i.bak "s/^app *= *\".*\"/app = \"$APP\"/" fly.toml && rm -f fly.toml.bak
HOST=$(fly status --app "$APP" --json 2>/dev/null | sed -n 's/.*"Hostname": *"\([^"]*\)".*/\1/p' | head -1)
HOST=${HOST:-$APP.fly.dev}
BASE_URL="https://$HOST"
# BASE_URL is configuration, not a secret: it lives in fly.toml so a checkout matches the deployment
sed -i.bak "s#^  BASE_URL *= *\".*\"#  BASE_URL = \"$BASE_URL\"#" fly.toml && rm -f fly.toml.bak
say "Public origin: $BASE_URL (Google redirect URI: $BASE_URL/auth/google/callback)"

# ---- 4. the volume ------------------------------------------------------------
if fly volumes list --app "$APP" --json 2>/dev/null | grep -q '"name": *"study_data"'; then
  say "Volume study_data exists"
else
  say "Creating the 1 GB volume study_data in $REGION"
  fly volumes create study_data --app "$APP" --region "$REGION" --size 1 --yes
fi

# ---- 5. secrets -------------------------------------------------------------
SECRETS=()
for v in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET ADMIN_EMAILS SESSION_SECRET MAX_IMPORT_MB \
         MACHINES_PER_USER MACHINES_TOTAL MACHINE_CPUS MACHINE_MEMORY_MB MACHINE_MAX_MINUTES \
         MACHINE_IDLE_SECONDS MACHINE_MAX_DEPTH MACHINE_STOCKFISH_FLAVOR MACHINE_USERS \
         STOCKFISH_FLAVOR DEEPEN EXPLORE; do
  if [ -n "${!v:-}" ]; then SECRETS+=("$v=${!v}"); fi
done
HAVE_GOOGLE=0
[ -n "${GOOGLE_CLIENT_ID:-}" ] && [ -n "${GOOGLE_CLIENT_SECRET:-}" ] && HAVE_GOOGLE=1
if [ "$HAVE_GOOGLE" = 0 ] && fly secrets list --app "$APP" 2>/dev/null | grep -q GOOGLE_CLIENT_ID; then HAVE_GOOGLE=1; fi
if [ "$HAVE_GOOGLE" = 0 ] && [ "$OPEN" = 0 ] && [ "$DEPLOY" = 1 ]; then
  cat >&2 <<EOF

Not deploying: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set, so the site
would be open to anyone on the internet (study set, imports and server engines
included). Create an OAuth client (Web application) in the Google Cloud console
with the redirect URI
    $BASE_URL/auth/google/callback
export GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and ADMIN_EMAILS, and run this again.
To deploy an open instance anyway, pass --open.
EOF
  exit 1
fi
# The token that lets the app start analysis machines through the Machines API
if ! fly secrets list --app "$APP" 2>/dev/null | grep -q '^FLY_API_TOKEN'; then
  say "Creating a deploy token for dedicated analysis machines"
  MACHINES_TOKEN=$(fly tokens create deploy --app "$APP" -x 999999h)
  SECRETS+=("FLY_API_TOKEN=$MACHINES_TOKEN")
fi
if [ ${#SECRETS[@]} -gt 0 ]; then
  say "Setting ${#SECRETS[@]} secret(s)"
  fly secrets set --app "$APP" --stage "${SECRETS[@]}"
fi

# ---- 6. deploy -------------------------------------------------------------
if [ "$DEPLOY" = 1 ]; then
  say "Deploying"
  fly deploy --app "$APP"
  fly status --app "$APP"
  say "Live at $BASE_URL  (fly logs --app $APP when something goes wrong)"
  echo "Health: $(curl -fsS "$BASE_URL/api/health" || echo 'not answering yet, give it a minute')"
else
  say "Skipping the deploy (--no-deploy). Run: fly deploy --app $APP"
fi
