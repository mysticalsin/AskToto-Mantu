#!/usr/bin/env bash
# Proves owner-runner.sb is active before owner-runner candidate commands can run.
set -euo pipefail

if [ -z "${RUNNER_TEMP:-}" ]; then
  echo "::error::RUNNER_TEMP is required for the owner-runner sandbox probe."
  exit 1
fi

if [ "${GITHUB_ACTIONS:-}" = "true" ] && { [ -n "${PROVE_OWNER_SANDBOX_WRAPPER:-}" ] || [ -n "${PROVE_OWNER_SANDBOX_HOME:-}" ]; }; then
  echo "::error::owner-runner sandbox probe overrides are test-only and must not be set in GitHub Actions."
  exit 1
fi

SANDBOX_WRAPPER="${PROVE_OWNER_SANDBOX_WRAPPER:-scripts/hermetic/run-under-owner-sandbox.sh}"
PROBE_OUT="$RUNNER_TEMP/sandbox-probe.out"
PROBE_ERR="$RUNNER_TEMP/sandbox-probe.err"
existing_count=0

if [ -n "${PROVE_OWNER_SANDBOX_HOME:-}" ]; then
  probe_home="${PROVE_OWNER_SANDBOX_HOME//\\//}"
else
  probe_home="$HOME"
fi

protected_paths=(
  "$probe_home/Library/CloudStorage"
  "$probe_home/Library/Keychains"
  "$probe_home/Library/Application Support/Metis"
  "$probe_home/Library/Application Support/Metis Light"
  "$probe_home/Library/Application Support/Métis"
  "$probe_home/Library/Application Support/AskToto"
  "$probe_home/Library/Application Support/TotoWhisper"
  "$probe_home/Library/Application Support/asktoto"
  "$probe_home/Library/Application Support/asktoto-dev"
  "$probe_home/.ssh"
  "$probe_home/.aws"
  "$probe_home/.gnupg"
  "$probe_home/.config"
  "$probe_home/.netrc"
  "$probe_home/.claude"
  "$probe_home/.codex"
  "$probe_home/Documents"
  "$probe_home/Desktop"
  "$probe_home/Downloads"
  "$probe_home/Pictures"
  "$probe_home/Movies"
  "$probe_home/Music"
  "$probe_home/Library/Mail"
  "$probe_home/Library/Messages"
  "$probe_home/Library/Safari"
  "$probe_home/Library/Cookies"
  "$probe_home/AI-Brain-build"
)

run_denial_probe() {
  set +e
  OWNER_SANDBOX_PROFILE=owner-runner.sb "$SANDBOX_WRAPPER" "$@" > "$PROBE_OUT" 2> "$PROBE_ERR"
  status=$?
  set -e
}

require_operation_not_permitted() {
  target="$1"
  if [ "$status" -eq 0 ]; then
    echo "::error::owner-runner sandbox allowed $2 $target"
    exit 1
  fi
  if ! grep -Fqi 'Operation not permitted' "$PROBE_ERR"; then
    echo "::error::owner-runner sandbox did not deny $target with Operation not permitted"
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
    echo "::error::owner-runner sandbox allowed creating absent protected path $target"
    exit 1
  fi
  require_operation_not_permitted "$target" "creating"
  echo "$target absent -> denied"
}

assert_writable() {
  target="$1"
  OWNER_SANDBOX_PROFILE=owner-runner.sb "$SANDBOX_WRAPPER" /bin/mkdir -p "$target"
  OWNER_SANDBOX_PROFILE=owner-runner.sb "$SANDBOX_WRAPPER" /usr/bin/touch "$target/probe"
  rm -f "$target/probe"
  rmdir "$target"
}

for path in "${protected_paths[@]}"; do
  assert_protected_path_denied "$path"
done

if [ "$existing_count" -lt 2 ]; then
  echo "::error::owner-runner sandbox proved only $existing_count existing protected paths; expected at least 2."
  exit 1
fi

if [ -z "${PROVE_OWNER_SANDBOX_WRAPPER:-}" ]; then
  assert_writable "$RUNNER_TEMP/owner-runner-sandbox-probe"
  assert_writable "${GITHUB_WORKSPACE:-$PWD}/.owner-runner-sandbox-probe"
fi
