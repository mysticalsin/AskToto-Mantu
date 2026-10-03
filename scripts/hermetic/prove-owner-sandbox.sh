#!/usr/bin/env bash
# Proves owner-account.sb is active before owner-runner candidate commands can run.
set -euo pipefail

if [ -z "${RUNNER_TEMP:-}" ]; then
  echo "::error::RUNNER_TEMP is required for the owner-account sandbox probe."
  exit 1
fi

assert_denied() {
  target="$1"
  set +e
  bash scripts/hermetic/run-under-owner-sandbox.sh /bin/ls "$target" > "$RUNNER_TEMP/sandbox-probe.out" 2> "$RUNNER_TEMP/sandbox-probe.err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "::error::owner-account sandbox allowed reading $target"
    exit 1
  fi
  if ! grep -Fqi 'Operation not permitted' "$RUNNER_TEMP/sandbox-probe.err"; then
    echo "::error::owner-account sandbox did not deny $target with Operation not permitted"
    cat "$RUNNER_TEMP/sandbox-probe.err"
    exit 1
  fi
}

assert_denied "$HOME/Library/CloudStorage"
assert_denied "$HOME/Library/Application Support/Metis"
