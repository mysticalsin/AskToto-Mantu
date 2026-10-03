#!/usr/bin/env bash
# Proves owner-runner.sb is active before owner-runner candidate commands can run.
set -euo pipefail

if [ -z "${RUNNER_TEMP:-}" ]; then
  echo "::error::RUNNER_TEMP is required for the owner-runner sandbox probe."
  exit 1
fi

assert_denied() {
  target="$1"
  set +e
  OWNER_SANDBOX_PROFILE=owner-runner.sb bash scripts/hermetic/run-under-owner-sandbox.sh /bin/ls "$target" > "$RUNNER_TEMP/sandbox-probe.out" 2> "$RUNNER_TEMP/sandbox-probe.err"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "::error::owner-runner sandbox allowed reading $target"
    exit 1
  fi
  if ! grep -Fqi 'Operation not permitted' "$RUNNER_TEMP/sandbox-probe.err"; then
    echo "::error::owner-runner sandbox did not deny $target with Operation not permitted"
    cat "$RUNNER_TEMP/sandbox-probe.err"
    exit 1
  fi
  echo "$target: Operation not permitted"
}

assert_writable() {
  target="$1"
  OWNER_SANDBOX_PROFILE=owner-runner.sb bash scripts/hermetic/run-under-owner-sandbox.sh /bin/mkdir -p "$target"
  OWNER_SANDBOX_PROFILE=owner-runner.sb bash scripts/hermetic/run-under-owner-sandbox.sh /usr/bin/touch "$target/probe"
  rm -f "$target/probe"
  rmdir "$target"
}

assert_denied "$HOME/Library/CloudStorage"
assert_denied "$HOME/Library/Application Support/Metis"
assert_denied "$HOME/.ssh"
assert_denied "$HOME/.aws"
assert_denied "$HOME/.gnupg"
assert_denied "$HOME/.config"
assert_denied "$HOME/.netrc"
assert_denied "$HOME/.claude"
assert_denied "$HOME/.codex"
assert_denied "$HOME/Documents"
assert_denied "$HOME/Desktop"
assert_denied "$HOME/Downloads"
assert_denied "$HOME/Pictures"
assert_denied "$HOME/Movies"
assert_denied "$HOME/Music"
assert_denied "$HOME/Library/Mail"
assert_denied "$HOME/Library/Messages"
assert_denied "$HOME/Library/Safari"
assert_denied "$HOME/Library/Cookies"
assert_denied "$HOME/AI-Brain-build"

assert_writable "$RUNNER_TEMP/owner-runner-sandbox-probe"
assert_writable "${GITHUB_WORKSPACE:-$PWD}/.owner-runner-sandbox-probe"
