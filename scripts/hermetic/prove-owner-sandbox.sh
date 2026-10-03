#!/usr/bin/env bash
# Proves owner-account.sb is active before owner-runner candidate commands can run.
set -euo pipefail

if [ -z "${RUNNER_TEMP:-}" ]; then
  echo "::error::RUNNER_TEMP is required for the owner-account sandbox probe."
  exit 1
fi

OWNER_HOME="${PROVE_OWNER_SANDBOX_HOME:-$HOME}"
SANDBOX_WRAPPER="${PROVE_OWNER_SANDBOX_WRAPPER:-scripts/hermetic/run-under-owner-sandbox.sh}"
PROBE_OUT="$RUNNER_TEMP/sandbox-probe.out"
PROBE_ERR="$RUNNER_TEMP/sandbox-probe.err"
existing_count=0

protected_paths=(
  "$OWNER_HOME/Library/CloudStorage"
  "$OWNER_HOME/Library/Keychains"
  "$OWNER_HOME/Library/Application Support/Metis"
  "$OWNER_HOME/Library/Application Support/Métis"
  "$OWNER_HOME/Library/Application Support/AskToto"
  "$OWNER_HOME/Library/Application Support/asktoto"
  "$OWNER_HOME/Library/Application Support/asktoto-dev"
)

run_denial_probe() {
  set +e
  "$SANDBOX_WRAPPER" "$@" > "$PROBE_OUT" 2> "$PROBE_ERR"
  status=$?
  set -e
}

require_operation_not_permitted() {
  target="$1"
  if [ "$status" -eq 0 ]; then
    echo "::error::owner-account sandbox allowed $2 $target"
    exit 1
  fi
  if ! grep -Fqi 'Operation not permitted' "$PROBE_ERR"; then
    echo "::error::owner-account sandbox did not deny $target with Operation not permitted"
    cat "$PROBE_ERR"
    exit 1
  fi
}

assert_protected_path_denied() {
  target="$1"
  if [ -e "$target" ] || [ -L "$target" ]; then
    run_denial_probe /bin/ls -ld "$target"
    require_operation_not_permitted "$target" "reading"
    existing_count=$((existing_count + 1))
    echo "$target exists -> denied"
    return
  fi

  run_denial_probe /bin/mkdir "$target"
  if [ "$status" -eq 0 ]; then
    /bin/rmdir "$target" 2> /dev/null || true
    echo "::error::owner-account sandbox allowed creating absent protected path $target"
    exit 1
  fi
  require_operation_not_permitted "$target" "creating"
  echo "$target absent -> denied"
}

for path in "${protected_paths[@]}"; do
  assert_protected_path_denied "$path"
done

if [ "$existing_count" -lt 2 ]; then
  echo "::error::owner-account sandbox proved only $existing_count existing protected paths; expected at least 2."
  exit 1
fi
