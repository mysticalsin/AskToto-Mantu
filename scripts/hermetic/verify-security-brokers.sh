#!/usr/bin/env bash
# Already inside the strict wrapper. Verify fixed probe bytes before an empty-environment exec.
set -euo pipefail
[ "$#" = 0 ]
[ "${OWNER_SANDBOX_ENTERED:-}" = 1 ]
[ "${OWNER_SANDBOX_ENTERED_PROFILE:-}" = owner-runner.sb ]
job_root="${RUNNER_TEMP:?}/metis-owner-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}-${GITHUB_JOB:?}"
[[ "${OWNER_QA_CONTROL_DIR:-}" =~ ^"$job_root"/invocation\.[A-Za-z0-9]+/broker-control\.[A-Za-z0-9]+$ ]]
[ "${QA_CHECK_PATH:-}" = "$OWNER_QA_CONTROL_DIR/check-security-brokers" ]
[ "$(cd "$OWNER_QA_CONTROL_DIR" && pwd -P)" = "$OWNER_QA_CONTROL_DIR" ]
[ -f "$QA_CHECK_PATH" ] && [ ! -L "$QA_CHECK_PATH" ]
[ "$(/usr/bin/stat -f %u "$QA_CHECK_PATH")" = "$(/usr/bin/id -u)" ]
[ "$(/usr/bin/stat -f %l "$QA_CHECK_PATH")" = 1 ]
[[ "${QA_CHECK_SHA256:-}" =~ ^[a-f0-9]{64}$ ]]
actual=$(/usr/bin/shasum -a 256 "$QA_CHECK_PATH")
[ "${actual%% *}" = "$QA_CHECK_SHA256" ]
expected="$TMPDIR/broker-expected"
observed="$TMPDIR/broker-observed"
printf '%s 1100 0\n' \
  com.apple.SecurityServer com.apple.securityd com.apple.securityd.xpc \
  com.apple.securityd.systemkeychain com.apple.securityd.aps com.apple.securityd.ckks \
  com.apple.securityd.general com.apple.securityd.sos com.apple.security.octagon \
  com.apple.security.escrow-update com.apple.security.kcsharing > "$expected"
printf 'BROKER_LOOKUP_DENIED\n' >> "$expected"
/usr/bin/env -i "$QA_CHECK_PATH" > "$observed"
/usr/bin/cmp -s "$expected" "$observed"
printf 'BROKER_LOOKUP_DENIED; named-service absence not observed\n'
