#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# AskToto ship setup — one-time account wiring for the mac + Windows release pipeline.
#
# The CI is already built: .github/workflows/build.yml packages both platforms on every push;
# release.yml signs + notarizes + publishes on a v* tag. This script only does the account
# steps: enable Actions, create the releases repo, set the signing/notarization secrets.
#
# Prereqs: `gh auth login` done (GitHub CLI authenticated as the repo owner), run from repo root.
# Usage:   1) fill in the CONFIG block below   2) `bash scripts/ship-setup.sh`
# Each step is idempotent and skips anything you leave blank, so you can run it in stages.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── CONFIG — fill these in (leave blank to skip a piece) ─────────────────────
REPO="mysticalsin/AskToto-Mantu"            # the private source repo
RELEASES_REPO="mysticalsin/AskToto-Releases" # public repo the app auto-updates from

# GitHub token with `repo` scope on the RELEASES repo (create at github.com/settings/tokens):
GH_TOKEN_VALUE=""

# macOS signing + notarization (Apple Developer ID Application cert):
MAC_CERT_P12=""           # path to your Developer ID Application .p12
MAC_CERT_PASSWORD=""      # its export password
APPLE_ID_EMAIL=""         # your Apple ID
APPLE_APP_PASSWORD=""     # app-specific password (appleid.apple.com → App-Specific Passwords)
APPLE_TEAM_ID_VALUE=""    # 10-char Team ID

# Windows Authenticode signing (.pfx). Optional — unsigned .exe still builds + runs (SmartScreen warns).
WIN_CERT_PFX=""           # path to your Authenticode .pfx
WIN_CERT_PASSWORD=""
WIN_CERT_EXPECTED_SUBJECT="" # exact certificate Subject or common name; never guess this value
# ─────────────────────────────────────────────────────────────────────────────

echo "▸ Checking gh auth…"; gh auth status >/dev/null || { echo "Run 'gh auth login' first."; exit 1; }

set_secret() { # name value  — sets a repo secret only if value is non-empty
  [ -n "${2:-}" ] || { echo "  · skip $1 (blank)"; return; }
  printf '%s' "$2" | gh secret set "$1" --repo "$REPO" && echo "  ✓ set $1"
}
set_secret_file() { # name path  — base64s a cert file into a secret
  [ -n "${2:-}" ] || { echo "  · skip $1 (blank)"; return; }
  [ -f "$2" ] || { echo "  ! $1: file not found: $2"; return; }
  base64 -i "$2" | gh secret set "$1" --repo "$REPO" && echo "  ✓ set $1 (base64 of $2)"
}

echo "▸ 1/4  Enabling Actions on $REPO…"
gh api -X PUT "repos/$REPO/actions/permissions" -F enabled=true -f allowed_actions=all \
  && echo "  ✓ Actions enabled — pushes build verification-only Mac + Windows run artifacts."

echo "▸ 2/4  Ensuring the public releases repo $RELEASES_REPO exists…"
if gh repo view "$RELEASES_REPO" >/dev/null 2>&1; then
  echo "  · already exists"
else
  gh repo create "$RELEASES_REPO" --public --description "AskToto release binaries + auto-update feed" \
    && echo "  ✓ created $RELEASES_REPO"
fi

echo "▸ 3/4  Setting signing / notarization secrets on $REPO…"
set_secret      GH_TOKEN                    "$GH_TOKEN_VALUE"
set_secret_file CSC_LINK                    "$MAC_CERT_P12"
set_secret      CSC_KEY_PASSWORD            "$MAC_CERT_PASSWORD"
set_secret      APPLE_ID                    "$APPLE_ID_EMAIL"
set_secret      APPLE_APP_SPECIFIC_PASSWORD "$APPLE_APP_PASSWORD"
set_secret      APPLE_TEAM_ID               "$APPLE_TEAM_ID_VALUE"
set_secret_file WIN_CSC_LINK                "$WIN_CERT_PFX"
set_secret      WIN_CSC_KEY_PASSWORD        "$WIN_CERT_PASSWORD"
set_secret      WIN_CSC_EXPECTED_SUBJECT     "$WIN_CERT_EXPECTED_SUBJECT"

echo "▸ 4/4  Next steps (manual, when you're ready to cut a release):"
cat <<'NEXT'
  • Verification artifacts: push any commit — Build & Test uploads ad-hoc-signed Mac .dmg/.zip
    and unsigned Windows .exe/.appx artifacts. These are not customer releases.
  • Signed public release: merge to main, then
        version=$(node -p "require('./package.json').version")
        git tag "v$version" && git push origin "v$version"
    → the Release workflow signs, notarizes, and publishes both installers to the releases repo;
      installed apps auto-update from there.
  • Verify a mac build's signature: codesign --verify --deep --strict --verbose=2 <AskToto.app>
NEXT
echo "✓ ship-setup complete."
