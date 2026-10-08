#!/usr/bin/env bash
# Hosted-only lookup/API controls. No owner-account operation is permitted here.
set -euo pipefail
[ "${GITHUB_ACTIONS:-}" = true ] && [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] || exit 2
[ "$(/usr/bin/uname -s)" = Darwin ] || exit 2
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
fixture=$(/usr/bin/mktemp -d "${RUNNER_TEMP:?}/security-broker-proof.XXXXXXXX")
trap '/bin/rm -rf -- "$fixture"' EXIT
/bin/mkdir -p "$fixture/workspace/scripts" "$fixture/home" "$fixture/runner-temp"
/bin/cp -R "$source_root/scripts/hermetic" "$fixture/workspace/scripts/hermetic"
export HOME="$fixture/home" GITHUB_WORKSPACE="$fixture/workspace" RUNNER_TEMP="$fixture/runner-temp"
export OWNER_SANDBOX_PROFILE=owner-runner.sb OWNER_SANDBOX_ROUTE=hosted-fixture
wrapper="$GITHUB_WORKSPACE/scripts/hermetic/run-under-owner-sandbox.sh"
cd "$GITHUB_WORKSPACE"
run() { /bin/bash "$wrapper" "$@"; }
OWNER_QA_CONTROL_DIR="$(run /bin/bash scripts/hermetic/prepare-security-brokers.sh)"
export OWNER_QA_CONTROL_DIR
export QA_CHECK_PATH="$OWNER_QA_CONTROL_DIR/check-security-brokers"
digest=$(/usr/bin/shasum -a 256 "$QA_CHECK_PATH")
export QA_CHECK_SHA256="${digest%% *}"

# Real linked-library inventory: the production probe must not load Security/CoreFoundation.
/usr/bin/otool -L "$QA_CHECK_PATH" > "$fixture/linkage"
/usr/bin/awk 'NR > 1 { count++; if ($1 != "/usr/lib/libSystem.B.dylib") exit 1 } END { if (count != 1) exit 1 }' "$fixture/linkage"
run /bin/bash scripts/hermetic/verify-security-brokers.sh
node_check='const {pathToFileURL}=await import("node:url"); const m=await import(pathToFileURL(process.argv[1]).href); m.observeCanary(process.env); console.log(JSON.stringify(m.observeSecurityBrokers(process.env)));'
run node --input-type=module -e "$node_check" "$source_root/scripts/qa/lib/st-1-launch.mjs"

# An independent fixed list, not extracted from the policy under test.
services=(
  com.apple.SecurityServer com.apple.securityd com.apple.securityd.xpc
  com.apple.securityd.systemkeychain com.apple.securityd.aps com.apple.securityd.ckks
  com.apple.securityd.general com.apple.securityd.sos com.apple.security.octagon
  com.apple.security.escrow-update com.apple.security.kcsharing
)
capture_non_denial() {
  local status
  if "$@" > "$fixture/lookup-output" 2> "$fixture/lookup-error"; then
    echo 'FAIL: ineffective policy unexpectedly produced complete denial' >&2; exit 1
  else status=$?; fi
  [ "$status" = 1 ]
  [ "$(/usr/bin/wc -l < "$fixture/lookup-output" | /usr/bin/tr -d ' ')" = 11 ]
  [ ! -s "$fixture/lookup-error" ]
}
require_non_1100() {
  /usr/bin/awk -v name="$1" '$1 == name { found++; if (NF != 3 || $2 == 1100) exit 1 } END { if (found != 1) exit 1 }' "$fixture/lookup-output"
}
printf '(version 1)\n(allow default)\n' > "$fixture/pass-through.sb"
printf '(version 1)\n(allow default)\n(deny file-read* (subpath (param "HOME")))\n' > "$fixture/outer-only.sb"
for policy in "$fixture/pass-through.sb" "$fixture/outer-only.sb" "$GITHUB_WORKSPACE/scripts/hermetic/owner-account.sb"; do
  # No strict outer wrapper here: it must not mask a missing broker rule in a nested policy.
  capture_non_denial /usr/bin/sandbox-exec -f "$policy" -D HOME="$HOME" /usr/bin/env -i "$QA_CHECK_PATH"
  for service in "${services[@]}"; do require_non_1100 "$service"; done
done
original_workspace="$GITHUB_WORKSPACE"
original_wrapper="$wrapper"
index=0
for service in "${services[@]}"; do
  index=$((index + 1))
  mutant="$fixture/missing-broker-$index"
  /bin/mkdir -p "$mutant/scripts"
  /bin/cp -R "$source_root/scripts/hermetic" "$mutant/scripts/hermetic"
  /usr/bin/grep -Fv "(deny mach-lookup (global-name \"$service\"))" \
    "$mutant/scripts/hermetic/owner-runner.sb" > "$fixture/profile-mutated"
  /bin/mv "$fixture/profile-mutated" "$mutant/scripts/hermetic/owner-runner.sb"
  export GITHUB_WORKSPACE="$mutant"
  wrapper="$mutant/scripts/hermetic/run-under-owner-sandbox.sh"
  capture_non_denial run /usr/bin/env -i "$QA_CHECK_PATH"
  require_non_1100 "$service"
  /usr/bin/awk -v omitted="$service" '$1 != omitted && ($2 != 1100 || $3 != 0 || NF != 3) { exit 1 }' "$fixture/lookup-output"
  printf 'PASS: removing %s is detected without an outer broker policy\n' "$service"
done
export GITHUB_WORKSPACE="$original_workspace"
wrapper="$original_wrapper"

# Actual Security API calls operate only on new, disposable hosted paths. Never delete items or
# change global keychain configuration. Observe metadata before/after without restoring it.
echo 'HOSTED_API_PROOF compile-fixture'
/usr/bin/xcrun clang -std=c11 -fno-modules -Wno-deprecated-declarations -Wall -Wextra -Werror \
  -framework Security -framework CoreFoundation "$source_root/scripts/hermetic/security-broker-api.fixture.c" \
  -o "$fixture/security-api-fixture"
api="$fixture/security-api-fixture"
echo 'HOSTED_API_PROOF metadata-before'
"$api" --metadata > "$fixture/metadata-before"
echo 'HOSTED_API_PROOF unwrapped-positive'
"$api" "$fixture/unwrapped-private.keychain-db" > "$fixture/api-positive"
/usr/bin/grep -qx 'SYNTHETIC_API add 0' "$fixture/api-positive"
echo 'HOSTED_API_PROOF strict-negative'
if run /bin/bash -c 'printf writable > "$TMPDIR/api-baseline"; exec "$1" "$TMPDIR/wrapped-private.keychain-db"' _ "$api" > "$fixture/api-denied"; then
  echo 'FAIL: strict profile allowed the synthetic Security API operation' >&2; exit 1
else status=$?; fi
[ "$status" = 3 ]
/usr/bin/grep -Eq '^SYNTHETIC_API (create|add) -[0-9]+$' "$fixture/api-denied"

# Same filesystem/ancestor policy and API, with only the fixed broker rules removed.
# Success here attributes the strict failure above to the broker-denial policy difference.
api_permissive="$fixture/api-without-broker-denies"
/bin/mkdir -p "$api_permissive/scripts"
/bin/cp -R "$source_root/scripts/hermetic" "$api_permissive/scripts/hermetic"
for service in "${services[@]}"; do
  /usr/bin/grep -Fv "(deny mach-lookup (global-name \"$service\"))" \
    "$api_permissive/scripts/hermetic/owner-runner.sb" > "$fixture/profile-mutated"
  /bin/mv "$fixture/profile-mutated" "$api_permissive/scripts/hermetic/owner-runner.sb"
done
export GITHUB_WORKSPACE="$api_permissive"
wrapper="$api_permissive/scripts/hermetic/run-under-owner-sandbox.sh"
echo 'HOSTED_API_PROOF same-policy-without-broker-rules'
run /bin/bash -c 'printf writable > "$TMPDIR/api-baseline"; exec "$1" "$TMPDIR/unblocked-private.keychain-db"' _ "$api" > "$fixture/api-policy-positive"
/usr/bin/grep -qx 'SYNTHETIC_API add 0' "$fixture/api-policy-positive"
export GITHUB_WORKSPACE="$original_workspace"
wrapper="$original_wrapper"
printf 'Unwrapped API observation: '
/bin/cat "$fixture/api-positive"
printf 'Strict API observation: '
/bin/cat "$fixture/api-denied"
printf 'Same strict policy without broker rules: '
/bin/cat "$fixture/api-policy-positive"
echo 'HOSTED_API_PROOF metadata-after'
"$api" --metadata > "$fixture/metadata-after"
/usr/bin/cmp -s "$fixture/metadata-before" "$fixture/metadata-after"
run /bin/bash scripts/hermetic/verify-security-brokers.sh
run --cleanup-owned-temp
echo 'PASS: real fixed broker denials, independent policy negatives, libSystem linkage and hosted synthetic API control'
