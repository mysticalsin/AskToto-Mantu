#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for the Métis (asktoto) Electron app.
#
# The repo pins Node exactly (.nvmrc / .node-version / package.json#engines). The base
# Cloud image ships a different Node 22 patch release earlier in PATH, so we install the
# pinned version with nvm and make it the default for future agent shells before running
# the dependency install. Safe to run repeatedly.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_VERSION="$(tr -d '[:space:]' < "$REPO_DIR/.nvmrc")"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
source "$NVM_DIR/nvm.sh"

nvm install "$NODE_VERSION"
nvm alias default "$NODE_VERSION" >/dev/null

# Make the pinned Node active in future interactive/login agent shells. `nvm use` only
# prepends the version's bin dir, so other toolchain paths stay reachable.
SNIPPET='export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; nvm use --silent '"$NODE_VERSION"' >/dev/null 2>&1'
for rc in "$HOME/.bashrc" "$HOME/.profile"; do
  touch "$rc"
  if ! grep -qF "nvm use --silent $NODE_VERSION" "$rc"; then
    printf '\n# Métis: use the Node version pinned in .nvmrc\n%s\n' "$SNIPPET" >> "$rc"
  fi
done

nvm use "$NODE_VERSION"

cd "$REPO_DIR"
npm install

echo "[install] Métis ready — Node $(node -v), npm $(npm -v). Run 'npm run dev' to launch the overlay."
