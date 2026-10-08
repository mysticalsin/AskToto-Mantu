#!/usr/bin/env bash
# Compile the fixed libSystem-only lookup probe under the strict wrapper.
set -euo pipefail
[ "${OWNER_SANDBOX_ENTERED_PROFILE:-}" = owner-runner.sb ] || exit 1
[ "${OWNER_SANDBOX_ENTERED:-}" = 1 ] || exit 1
[ -n "${TMPDIR:-}" ] && [ -d "$TMPDIR" ] || exit 1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
control=$(/usr/bin/mktemp -d "$TMPDIR/broker-control.XXXXXXXX")
/usr/bin/xcrun clang -std=c11 -fno-modules -Wall -Wextra -Werror \
  "$HERE/check-security-brokers.c" -o "$control/check-security-brokers"
/bin/chmod 500 "$control/check-security-brokers"
printf '%s\n' "$control"
