#!/usr/bin/env bash
# One-command production deploy for the AskToto license server:
# license-server + Caddy (automatic HTTPS) behind your own domain.
#
# What this script does, in order:
#   1. Checks that docker and the docker compose plugin are installed.
#   2. Checks that deploy/.env exists (creates it from .env.example and
#      stops if it doesn't, so you can fill in your real values first).
#   3. Warns (but does not block) if LICENSE_ADMIN_TOKEN still looks like
#      the placeholder from .env.example.
#   4. Builds and starts both containers in the background.
#   5. Prints the dashboard URL and a couple of reminders.
#
# Safe to re-run any time (e.g. after a `git pull`) - it just rebuilds and
# restarts the containers with whatever is currently in deploy/.env.

set -euo pipefail

# Always operate from the directory this script lives in (deploy/), so it
# works no matter where you called it from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "== AskToto license server: production deploy =="
echo

# --- Step 1: check docker is installed -------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is not installed on this machine."
  echo
  echo "Install it first, then run this script again:"
  echo "  - Most Linux servers (Ubuntu/Debian/etc.): https://get.docker.com"
  echo "      curl -fsSL https://get.docker.com | sh"
  echo "  - Raspberry Pi OS: same command above works (get.docker.com supports arm64/armv7)."
  echo "  - macOS / Windows: install Docker Desktop from https://www.docker.com/products/docker-desktop/"
  exit 1
fi

# --- Step 2: check the docker compose plugin is installed -------------------
if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: the 'docker compose' plugin is not available."
  echo
  echo "Modern Docker installs (get.docker.com) include it automatically."
  echo "If yours doesn't, see: https://docs.docker.com/compose/install/"
  exit 1
fi

echo "Docker and docker compose are installed. Good."
echo

# --- Step 3: check deploy/.env exists ---------------------------------------
if [ ! -f ".env" ]; then
  echo "No deploy/.env file found yet - creating one from .env.example."
  cp .env.example .env
  echo
  echo "STOPPED: edit deploy/.env before continuing."
  echo
  echo "Open deploy/.env and set:"
  echo "  LICENSE_DOMAIN=<the domain you pointed at this server, e.g. licenses.yourcompany.com>"
  echo "  LICENSE_ADMIN_TOKEN=<a long random secret - generate one with: openssl rand -hex 24>"
  echo
  echo "Then run ./run.sh again."
  exit 1
fi

# --- Step 4: warn if the admin token still looks like the placeholder ------
if grep -q '^LICENSE_ADMIN_TOKEN=change-me-to-a-long-random-secret' .env; then
  echo "WARNING: LICENSE_ADMIN_TOKEN in deploy/.env still looks like the placeholder value."
  echo "         Anyone who finds it could mint or revoke licenses on your server."
  echo "         Edit deploy/.env and set a real secret (e.g. openssl rand -hex 24)."
  echo
fi

# --- Step 5: build and start ------------------------------------------------
echo "Building and starting containers (this can take a few minutes the first time)..."
echo
docker compose -f docker-compose.prod.yml --env-file .env up -d --build

# Read back the domain we just deployed for, for the summary below.
# shellcheck disable=SC1091
LICENSE_DOMAIN="$(grep '^LICENSE_DOMAIN=' .env | cut -d '=' -f2-)"

echo
echo "== Done =="
echo
echo "Dashboard (once the certificate is ready): https://${LICENSE_DOMAIN}/admin/ui"
echo
echo "Reminders:"
echo "  - DNS for ${LICENSE_DOMAIN} must already point at this server's public IP."
echo "  - Ports 80 and 443 must be open on this server/router (Caddy needs both to"
echo "    fetch the HTTPS certificate, even though customers only use 443)."
echo "  - The first HTTPS certificate can take up to a minute or two to issue -"
echo "    if the dashboard doesn't load right away, wait a bit and refresh."
echo "  - Check logs any time with: docker compose -f docker-compose.prod.yml logs -f"
