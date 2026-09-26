#!/usr/bin/env bash
# QA fixture for `metis-mac-helper stat-flags` (M2-0191). Run on the isolated QA macOS account only,
# never on an owner account.
#
#   scripts/qa/stat-flags-fixture.sh <helper> <dataless-file> [--cycle]
#
#   <helper>         the metis-mac-helper binary under test (the packaged candidate's
#                    Contents/Resources/mac-helper/metis-mac-helper, or resources/mac-helper/ after
#                    `node scripts/build-mac-helper.mjs`)
#   <dataless-file>  a cloud-only file on the QA cloud account (iCloud Drive: `brctl evict <file>`;
#                    OneDrive: Finder > Free up space)
#   --cycle          also hydrate the file, evict it again with brctl (iCloud Drive only) and print
#                    mtime, ctime, size and flags at each step: evidence for the detector's cache key
#
# Passes when the helper reports the same st_flags as stat(1) for a local, an APFS-compressed, a
# non-ASCII-named and a dataless file; SF_DATALESS is set only on the dataless file; an unstat-able path
# is null; and the dataless file is still dataless after the probe.
set -euo pipefail

SF_DATALESS=$((0x40000000))
UF_COMPRESSED=$((0x20))

fail() { echo "FAIL: $*" >&2; exit 1; }
flags_of() { stat -f %Uf "$1"; }
has_flag() { (( ($1 & $2) != 0 )); }

[[ "$(uname)" == Darwin ]] || fail 'macOS only'
[[ $# -ge 2 ]] || fail 'usage: stat-flags-fixture.sh <helper> <dataless-file> [--cycle]'
helper=$1 dataless=$2 mode=${3:-}
[[ -x "$helper" ]] || fail "helper is not executable: $helper"
[[ -f "$dataless" ]] || fail "dataless fixture not found: $dataless"
has_flag "$(flags_of "$dataless")" "$SF_DATALESS" || fail "$dataless is not dataless; evict it first"

work=$(mktemp -d "${TMPDIR:-/tmp}/stat-flags-fixture.XXXXXX")
trap 'rm -rf "$work"' EXIT
local_file="$work/local.md"
compressed="$work/compressed.md"
unicode="$work/Métis réunion.md"
missing="$work/missing.md"
printf 'local fixture\n' >"$local_file"
printf 'unicode fixture\n' >"$unicode"
head -c 200000 /dev/zero | tr '\0' 'a' >"$work/plain.md"
ditto --hfsCompression "$work/plain.md" "$compressed"
has_flag "$(flags_of "$compressed")" "$UF_COMPRESSED" || fail 'fixture: ditto did not compress the file'

answer=$(printf '%s\0' "$local_file" "$compressed" "$dataless" "$missing" "$unicode" | "$helper" stat-flags)
list=${answer#\[}; list=${list%\]}
IFS=, read -r -a words <<<"$list"
[[ ${#words[@]} -eq 5 ]] || fail "expected 5 words, got: $answer"

expect_stat() { [[ "$2" == "$(flags_of "$1")" ]] || fail "$1: helper said $2, stat(1) says $(flags_of "$1")"; }
expect_stat "$local_file" "${words[0]}"
expect_stat "$compressed" "${words[1]}"
expect_stat "$dataless" "${words[2]}"
[[ "${words[3]}" == null ]] || fail "unstat-able path: expected null, got ${words[3]}"
expect_stat "$unicode" "${words[4]}"
if has_flag "${words[0]}" "$SF_DATALESS"; then fail 'local file reported dataless'; fi
if has_flag "${words[1]}" "$SF_DATALESS"; then fail 'compressed local file reported dataless'; fi
has_flag "${words[2]}" "$SF_DATALESS" || fail 'dataless file not reported dataless'
has_flag "$(flags_of "$dataless")" "$SF_DATALESS" || fail 'the probe hydrated the dataless file'
echo "PASS stat-flags: local=${words[0]} compressed=${words[1]} dataless=${words[2]} missing=null unicode=${words[4]}"

if [[ "$mode" == --cycle ]]; then
  version() { stat -f '%.9Fm %.9Fc %z %Sf' "$dataless"; }
  echo "evicted  (mtime ctime size flags): $(version)"
  sleep 1; cat "$dataless" >/dev/null
  echo "hydrated (mtime ctime size flags): $(version)"
  sleep 1; brctl evict "$dataless"; sleep 5
  echo "evicted  (mtime ctime size flags): $(version)"
fi
