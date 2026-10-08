#!/usr/bin/env bash
# Hosted-only real Seatbelt proof. Every touched data path is synthetic and owned by this process.
set -euo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] && [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] || exit 2
[ "$(/usr/bin/uname -s)" = Darwin ] || exit 2
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
fixture=$(/usr/bin/mktemp -d "${RUNNER_TEMP:?}/owner-runner-proof.XXXXXXXX")
trap '/bin/rm -rf -- "$fixture"' EXIT
/bin/mkdir -p "$fixture/workspace/scripts" "$fixture/home" "$fixture/runner-temp" "$fixture/outside"
/bin/cp -R "$source_root/scripts/hermetic" "$fixture/workspace/scripts/hermetic"
export HOME="$fixture/home" GITHUB_WORKSPACE="$fixture/workspace" RUNNER_TEMP="$fixture/runner-temp"
export OWNER_SANDBOX_PROFILE=owner-runner.sb OWNER_SANDBOX_ROUTE=hosted-fixture
wrapper="$GITHUB_WORKSPACE/scripts/hermetic/run-under-owner-sandbox.sh"
cd "$GITHUB_WORKSPACE"
run() { /bin/bash "$wrapper" "$@"; }
denied() {
  if run "$@" > "$fixture/stdout" 2> "$fixture/stderr"; then
    echo "FAIL: operation unexpectedly succeeded: $1" >&2; exit 1
  fi
  /usr/bin/grep -q 'Operation not permitted' "$fixture/stderr" || { /bin/cat "$fixture/stderr" >&2; exit 1; }
}
refused() {
  if "$@" > "$fixture/stdout" 2> "$fixture/stderr"; then
    echo 'FAIL: invalid configuration was accepted' >&2; exit 1
  fi
  /usr/bin/grep -q 'owner-runner sandbox:' "$fixture/stderr" || { /bin/cat "$fixture/stderr" >&2; exit 1; }
}
alias_denials() {
  local target="$1" label="$2" deny_read="$3" backup alias
  backup=$(/usr/bin/mktemp "$fixture/alias-baseline.XXXXXXXX")
  /bin/cp "$target" "$backup"
  /bin/ln "$target" "$GITHUB_WORKSPACE/$label-hard-alias"
  /bin/ln -s "$target" "$GITHUB_WORKSPACE/$label-sym-alias"
  for alias in "$GITHUB_WORKSPACE/$label-hard-alias" "$GITHUB_WORKSPACE/$label-sym-alias"; do
    /usr/bin/cmp -s "$backup" "$alias"
    printf 'unwrapped baseline append' >> "$alias"
    if /usr/bin/cmp -s "$backup" "$target"; then echo 'FAIL: alias baseline did not write' >&2; exit 1; fi
    /bin/cp "$backup" "$target"
    if [ "$deny_read" = yes ]; then denied /bin/cat "$alias"; else run /bin/cat "$alias" > /dev/null; fi
    denied /bin/bash -c 'printf forbidden >> "$1"' _ "$alias"
    /usr/bin/cmp -s "$backup" "$target"
    denied /bin/bash -c 'printf forbidden > "$1"' _ "$alias"
    /usr/bin/cmp -s "$backup" "$target"
  done
  /bin/rm "$backup"
}

# Independent expected policy list: never extracted from the profile being proved.
roots=(
  '.ssh' '.aws' '.gnupg' '.config' '.claude' '.codex' '.wrangler'
  Documents Desktop Downloads Pictures Movies Music AI-Brain-build
  Library/CloudStorage Library/Keychains Library/Preferences/.wrangler
  Library/Mail Library/Messages Library/Safari Library/Cookies
  'Library/Application Support/Metis' 'Library/Application Support/Metis Light'
  'Library/Application Support/TotoWhisper' 'Library/Application Support/Métis'
  'Library/Application Support/AskToto' 'Library/Application Support/asktoto'
  'Library/Application Support/asktoto-dev'
)
for root in "${roots[@]}"; do
  target="$HOME/$root"
  /bin/mkdir -p "$target"
  printf baseline > "$target/probe"
  /bin/cat "$target/probe" > /dev/null
  printf writable >> "$target/probe"
  /bin/mkdir "$target/baseline-child"
  /bin/rmdir "$target/baseline-child"
  denied /bin/cat "$target/probe"
  denied /bin/bash -c 'printf forbidden >> "$1"' _ "$target/probe"
  denied /bin/mkdir "$target/absent-child"
  [ "$(/bin/cat "$target/probe")" = baselinewritable ]
  [ ! -e "$target/absent-child" ]
  printf 'PASS protected read/write/create: %s\n' "$root"
done
alias_denials "$HOME/.ssh/probe" private-ssh yes

# .netrc is a regular file, not a directory stand-in. Also prove absent-file creation denial.
printf baseline > "$HOME/.netrc"
/bin/cat "$HOME/.netrc" > /dev/null
printf writable >> "$HOME/.netrc"
denied /bin/cat "$HOME/.netrc"
denied /bin/bash -c 'printf forbidden >> "$HOME/.netrc"'
[ "$(/bin/cat "$HOME/.netrc")" = baselinewritable ]
/bin/rm "$HOME/.netrc"
denied /bin/bash -c 'printf forbidden > "$HOME/.netrc"'
[ ! -e "$HOME/.netrc" ]
printf baseline > "$HOME/.netrc"
alias_denials "$HOME/.netrc" private-netrc yes

# Falsify the same denial oracle using only mutated copies inside this fixture.
original_workspace="$GITHUB_WORKSPACE"
original_wrapper="$wrapper"
for mutation in passthrough missing-private-deny; do
  mutant="$fixture/$mutation"
  /bin/mkdir -p "$mutant/scripts"
  /bin/cp -R "$source_root/scripts/hermetic" "$mutant/scripts/hermetic"
  if [ "$mutation" = passthrough ]; then
    printf '(version 1)\n(allow default)\n' > "$mutant/scripts/hermetic/owner-runner.sb"
    if (cd "$mutant" && GITHUB_WORKSPACE="$mutant" /bin/bash scripts/hermetic/prove-owner-sandbox.sh) > "$fixture/negative-out" 2> "$fixture/negative-err"; then
      echo 'FAIL: runtime canary probe accepted a pass-through profile' >&2; exit 1
    fi
    /usr/bin/grep -q 'canary read unexpectedly succeeded' "$fixture/negative-err"
  else
    /usr/bin/sed '/"\/\.ssh"/d' "$mutant/scripts/hermetic/owner-runner.sb" > "$fixture/mutated-profile"
    /bin/mv "$fixture/mutated-profile" "$mutant/scripts/hermetic/owner-runner.sb"
    export GITHUB_WORKSPACE="$mutant"
    wrapper="$mutant/scripts/hermetic/run-under-owner-sandbox.sh"
    if (denied /bin/cat "$HOME/.ssh/probe") > "$fixture/negative-out" 2> "$fixture/negative-err"; then
      echo 'FAIL: protected-content oracle accepted a removed denial' >&2; exit 1
    fi
    /usr/bin/grep -q 'operation unexpectedly succeeded' "$fixture/negative-err"
  fi
done
export GITHUB_WORKSPACE="$original_workspace"
wrapper="$original_wrapper"
if (OWNER_SANDBOX_PROFILE=owner-account.sb denied /bin/cat "$HOME/.ssh/probe") > "$fixture/negative-out" 2> "$fixture/negative-err"; then
  echo 'FAIL: private-content oracle accepted the wrong profile' >&2; exit 1
fi
/usr/bin/grep -q 'operation unexpectedly succeeded' "$fixture/negative-err"

/bin/bash "$GITHUB_WORKSPACE/scripts/hermetic/prove-owner-sandbox.sh"
run /bin/bash -c 'printf allowed > "$GITHUB_WORKSPACE/allowed"; printf allowed > "$TMPDIR/allowed"; /bin/cat "$TMPDIR/allowed"'
[ "$(/bin/cat "$GITHUB_WORKSPACE/allowed")" = allowed ]
first_temp=$(run /bin/bash -c 'printf immutable > "$TMPDIR/first"; printf "%s" "$TMPDIR"')
second_temp=$(QA_TMP="$fixture/outside" run /bin/bash -c 'printf "%s" "$TMPDIR"')
[ "$first_temp" != "$second_temp" ] && [[ "$second_temp" != "$fixture/outside"* ]]
denied /bin/bash -c 'printf forbidden > "$1/first"' _ "$first_temp"
canary_check='const {pathToFileURL}=await import("node:url"); const m=await import(pathToFileURL(process.argv[1]).href); m.observeCanary(process.env);'
run node --input-type=module -e "$canary_check" "$source_root/scripts/qa/lib/st-1-launch.mjs"
if OWNER_SANDBOX_ENTERED=1 OWNER_SANDBOX_ENTERED_PROFILE=owner-runner.sb \
  OWNER_SANDBOX_TEMP="$first_temp" OWNER_SANDBOX_CANARY="$first_temp/.sandbox-canary" \
  OWNER_SANDBOX_JOB_ROOT="$(/usr/bin/dirname "$first_temp")" \
  node --input-type=module -e "$canary_check" "$source_root/scripts/qa/lib/st-1-launch.mjs" > "$fixture/negative-out" 2> "$fixture/negative-err"; then
  echo 'FAIL: forged markers without OS denial were accepted' >&2; exit 1
fi
/usr/bin/grep -q 'canary read/write permission denial not established' "$fixture/negative-err"
/bin/rm "$first_temp/.sandbox-canary"
if OWNER_SANDBOX_TEMP="$first_temp" OWNER_SANDBOX_CANARY="$first_temp/.sandbox-canary" \
  OWNER_SANDBOX_JOB_ROOT="$(/usr/bin/dirname "$first_temp")" \
  node --input-type=module -e "$canary_check" "$source_root/scripts/qa/lib/st-1-launch.mjs" > "$fixture/negative-out" 2> "$fixture/negative-err"; then
  echo 'FAIL: missing canary was accepted as a permission denial' >&2; exit 1
fi
/usr/bin/grep -q 'canary read/write permission denial not established' "$fixture/negative-err"

# The probe's original bytes and trusted sandbox code cannot be replaced through aliases or renames.
control=$(run /bin/bash -c '/bin/mkdir "$TMPDIR/broker-control.fixture"; printf checker > "$TMPDIR/broker-control.fixture/check-security-brokers"; printf "%s" "$TMPDIR/broker-control.fixture"')
export OWNER_QA_CONTROL_DIR="$control"
control_file="$control/check-security-brokers"
original=$(/usr/bin/shasum -a 256 "$control_file")
alias_denials "$control_file" existing-control no
denied /bin/bash -c 'printf forbidden > "$1"' _ "$control_file"
denied /bin/rm -f "$control_file"
denied /bin/mv "$control" "$control-moved"
denied /bin/mv "$(/usr/bin/dirname "$control")" "$(/usr/bin/dirname "$control")-moved"
denied /bin/mv "$RUNNER_TEMP" "$RUNNER_TEMP-moved"
denied /bin/bash -c '/bin/ln "$1" "$2" && printf forbidden > "$2"' _ "$control_file" "$GITHUB_WORKSPACE/hard-alias"
denied /bin/bash -c '/bin/ln -s "$1" "$2" && printf forbidden > "$2"' _ "$control_file" "$GITHUB_WORKSPACE/sym-alias"
[ "$(/usr/bin/shasum -a 256 "$control_file")" = "$original" ]
trusted="$GITHUB_WORKSPACE/scripts/hermetic/owner-runner.sb"
trusted_original=$(/usr/bin/shasum -a 256 "$trusted")
alias_denials "$trusted" existing-trusted no
denied /bin/bash -c 'printf forbidden > "$1"' _ "$trusted"
denied /bin/bash -c '/bin/ln "$1" "$2" && printf forbidden > "$2"' _ "$trusted" "$GITHUB_WORKSPACE/trusted-alias"
denied /bin/mv "$GITHUB_WORKSPACE/scripts" "$GITHUB_WORKSPACE/scripts-moved"
[ "$(/usr/bin/shasum -a 256 "$trusted")" = "$trusted_original" ]

# Runner command files, future step bodies and actions/runtime siblings lie outside candidate writes.
/bin/mkdir -p "$RUNNER_TEMP/_runner_file_commands" "$fixture/actions" "$fixture/runtime"
for target in "$RUNNER_TEMP/_runner_file_commands/set_env_fixture" "$RUNNER_TEMP/future-step.sh" \
  "$fixture/actions/action.js" "$fixture/runtime/node"; do
  printf baseline > "$target"
  denied /bin/bash -c 'printf "BASH_ENV=poison\n" >> "$1"' _ "$target"
  [ "$(/bin/cat "$target")" = baseline ]
done
denied /bin/bash -c 'printf injected > "$RUNNER_TEMP/not-created-yet.sh"'

# Real admission failure checks, including physical aliases and protected-root overlaps.
refused /usr/bin/env GITHUB_WORKSPACE=/ /bin/bash "$wrapper" /usr/bin/true
refused /usr/bin/env GITHUB_WORKSPACE="$fixture" /bin/bash "$wrapper" /usr/bin/true
refused /usr/bin/env RUNNER_TEMP=relative /bin/bash "$wrapper" /usr/bin/true
refused /usr/bin/env RUNNER_TEMP="$fixture/missing" /bin/bash "$wrapper" /usr/bin/true
refused /usr/bin/env RUNNER_TEMP="$HOME/Documents" /bin/bash "$wrapper" /usr/bin/true
refused /usr/bin/env RUNNER_TEMP="$GITHUB_WORKSPACE" /bin/bash "$wrapper" /usr/bin/true
/bin/ln -s "$RUNNER_TEMP" "$fixture/temp-link"
refused /usr/bin/env RUNNER_TEMP="$fixture/temp-link" /bin/bash "$wrapper" /usr/bin/true
refused /usr/bin/env GITHUB_RUN_ID=../other /bin/bash "$wrapper" /usr/bin/true
refused /usr/bin/env OWNER_SANDBOX_ROUTE=owner RUNNER_ENVIRONMENT=self-hosted GITHUB_JOB=st1-mac-fifo /bin/bash "$wrapper" /usr/bin/true
refused /bin/bash "$wrapper" --cleanup-owned-temp "$fixture/outside"
denied /bin/bash "$wrapper" --cleanup-owned-temp
[ -f "$control_file" ]
unset OWNER_QA_CONTROL_DIR
job_root="$RUNNER_TEMP/metis-owner-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB"
sibling="$RUNNER_TEMP/metis-owner-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-other-job"
/bin/mkdir -m 700 "$sibling"
printf untouched > "$sibling/sentinel"
denied /usr/bin/env GITHUB_JOB=other-job /bin/bash "$wrapper" --cleanup-owned-temp
[ "$(/bin/cat "$sibling/sentinel")" = untouched ]
run --cleanup-owned-temp
[ ! -e "$job_root" ]
[ "$(/bin/cat "$sibling/sentinel")" = untouched ]
echo 'PASS: real Seatbelt strict roots, aliases, control plane, per-invocation writes and bounded cleanup'
