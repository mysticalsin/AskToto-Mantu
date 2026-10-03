#!/usr/bin/env bash
# M2-0525 — decides whether the native-only macOS jobs (isolation-canary's MetisKit swift test and
# owner-account.sb, build.yml's Native job) must run. The public repository has few concurrent macOS
# runners, so a TypeScript-only ticket-branch push must not queue them.
#
# Prints `native=true|false` and appends it to $GITHUB_OUTPUT. Always `true` except on a push to a ticket
# branch (any branch other than main, master, m2/integration and release/*) whose diff against the
# merge-base with origin/m2/integration touches NATIVE_SURFACE. Any doubt (no merge-base, git error) is `true`.
# Reads GITHUB_EVENT_NAME and GITHUB_REF (both set by Actions).
set -euo pipefail

# Everything the gated jobs read: the native sources, the hermetic sandbox/swift runners and profile
# (scripts/hermetic/), AGENTS.md (the owner-sandbox positive control), the two workflows that define the
# gated jobs and this script. A file a gated job newly reads must be added here.
NATIVE_SURFACE=(
  native/
  native-app/
  scripts/hermetic/
  AGENTS.md
  .github/workflows/isolation-canary.yml
  .github/workflows/build.yml
  scripts/ci/native-changes.sh
)

emit() {
  echo "native=$1"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "native=$1" >> "$GITHUB_OUTPUT"; fi
  exit 0
}

[ "${GITHUB_EVENT_NAME:-}" = "push" ] || emit true
case "${GITHUB_REF:-}" in
  refs/heads/main | refs/heads/master | refs/heads/m2/integration | refs/heads/release/*) emit true ;;
  refs/heads/*) ;;
  *) emit true ;;
esac

base="$(git merge-base HEAD refs/remotes/origin/m2/integration 2>/dev/null)" || emit true
changed="$(git diff --name-only "$base" HEAD -- "${NATIVE_SURFACE[@]}")" || emit true
if [ -n "$changed" ]; then emit true; fi
emit false
