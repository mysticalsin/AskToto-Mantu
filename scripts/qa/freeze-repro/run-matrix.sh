#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: bash scripts/qa/freeze-repro/run-matrix.sh --artifact <1.9.6 sha256> --build-run-id <id> --app <Metis.app> --profile-template <dir> [options]

Runs the M2-0008 freeze/no-reopen matrix on the QA macOS account against the unmodified packaged 1.9.6 app.
Use --dry-run in CI to verify the fixture and report wiring without launching the app.

Required for live QA:
  --artifact <sha256>          sha256 of the installed 1.9.6 artifact under test
  --build-run-id <id>          build/provenance run id that produced the artifact
  --app <path>                 installed Metis.app or executable
  --profile-template <dir>     representative synthetic userData profile from M2-0007
  --qa-account                 explicit assertion that this is not the owner's primary account

Options:
  --out <dir>                  output bundle directory (default: ${TMPDIR:-/tmp}/metis-freeze-repro/<timestamp>)
  --minutes <n>                dataless idle row duration in minutes (default: 5)
  --dataless-brain-index <p>   real evicted .brain/index.json fixture for the idle row
  --dataless-meeting <p>       real evicted meeting fixture for the network/flapping row
  --implementer-session-id <id> opaque implementer session id for the LIVE_VERIFIED record
  --validator-session-id <id>   opaque validator session id for the LIVE_VERIFIED record
  --dry-run                    create fixtures and reports without launching or sampling
USAGE
}

fail() {
  echo "[M2-0008] FAIL: $*" >&2
  exit 2
}

json_escape() {
  local s=${1-}
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

json_string() {
  printf '"%s"' "$(json_escape "${1-}")"
}

rel_to_profile() {
  local path=$1
  case "$path" in
    "$PROFILE"/*) printf '%s' "${path#"$PROFILE"/}" ;;
    *) printf '%s' "<outside-profile>" ;;
  esac
}

redact_to_file() {
  local src=$1
  local dest=$2
  sed "s#${HOME}#\$HOME#g" "$src" > "$dest"
}

redact_string() {
  printf '%s' "${1/#$HOME/\$HOME}"
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

resolve_exe() {
  local app=$1
  if [[ -d "$app" && "$app" == *.app ]]; then
    printf '%s/Contents/MacOS/%s' "$app" "$(basename "$app" .app)"
  else
    printf '%s' "$app"
  fi
}

make_fifo() {
  local path=$1
  rm -f "$path"
  mkfifo -m 600 "$path"
}

release_fifo_once() {
  local path=$1
  if perl -e 'use Fcntl qw(O_WRONLY O_NONBLOCK); sysopen(my $fh, $ARGV[0], O_WRONLY|O_NONBLOCK) or exit(($!{ENXIO}) ? 1 : 2); close $fh; exit 0' "$path"; then
    return 0
  fi
  return 1
}

run_with_timeout() {
  local seconds=$1
  shift
  "$@" &
  local pid=$!
  local elapsed=0
  while kill -0 "$pid" >/dev/null 2>&1; do
    if (( elapsed >= seconds )); then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
      return 124
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  wait "$pid"
}

append_jsonl() {
  local file=$1
  local row=$2
  printf '%s\n' "$row" >> "$file"
}

prompt_result() {
  local id=$1
  local prompt=$2
  local value="not-recorded"
  if [[ "$DRY_RUN" == 0 ]]; then
    printf '\n[M2-0008] %s\n' "$prompt" >&2
    printf '[M2-0008] result for %s (observed/pass/fail/not-exercised): ' "$id" >&2
    read -r value
    [[ -n "$value" ]] || value="not-recorded"
  fi
  printf '%s' "$value"
}

sample_pid() {
  local pid=$1
  local label=$2
  local raw="$SAMPLE_DIR/${label}.raw.sample.txt"
  local redacted="$SAMPLE_DIR/${label}.sample.txt"
  /usr/bin/sample "$pid" 10 -file "$raw" >/dev/null 2>&1 || true
  [[ -f "$raw" ]] && redact_to_file "$raw" "$redacted"
  rm -f "$raw"
}

launch_app() {
  local profile=$1
  ASKTOTO_USERDATA="$profile" "$EXE" --remote-debugging-port=9334 >/dev/null 2>"$OUT/app.stderr.txt" &
  APP_PID=$!
  sleep 10
}

stop_app() {
  if [[ -n "${APP_PID:-}" ]]; then
    kill "$APP_PID" >/dev/null 2>&1 || true
    wait "$APP_PID" >/dev/null 2>&1 || true
    APP_PID=""
  fi
}

renderer_pids() {
  local main_pid=$1
  pgrep -P "$main_pid" 2>/dev/null | head -n 3 || true
}

sample_app() {
  local row=$1
  if [[ "$DRY_RUN" == 1 || -z "${APP_PID:-}" ]]; then
    append_jsonl "$OUT/matrix.jsonl" "{\"row\":$(json_string "$row"),\"sampled\":false,\"reason\":\"dry-run-or-no-app\"}"
    return
  fi
  sample_pid "$APP_PID" "$row-main"
  local rp sampled_renderers=0
  while IFS= read -r rp; do
    [[ -n "$rp" ]] || continue
    sample_pid "$rp" "$row-renderer-$rp"
    sampled_renderers=$((sampled_renderers + 1))
  done < <(renderer_pids "$APP_PID")
  append_jsonl "$OUT/matrix.jsonl" "{\"row\":$(json_string "$row"),\"sampled\":true,\"main_pid\":$APP_PID,\"renderer_samples\":$sampled_renderers}"
}

copy_diagnostic_reports() {
  local stamp=$1
  local reports="$OUT/diagnostic-reports"
  mkdir -p "$reports"
  find /Library/Logs/DiagnosticReports -type f \( -name '*.spin' -o -name '*.hang' \) -newer "$stamp" -print 2>/dev/null |
    while IFS= read -r report; do
      local dest="$reports/$(basename "$report").txt"
      redact_to_file "$report" "$dest" || true
    done
}

record_fuse_state() {
  local exe=$1
  local probe_dir="$OUT/fuse-probe"
  mkdir -p "$probe_dir"
  local probe="$probe_dir/node-options-probe.cjs"
  local marker="$probe_dir/marker"
  cat > "$probe" <<PROBE
require('node:fs').writeFileSync(process.env.M2_0008_NODE_OPTIONS_MARKER, 'loaded')
PROBE
  local status="UNKNOWN"
  local detail="probe did not run"
  if run_with_timeout 10 env ELECTRON_RUN_AS_NODE=1 NODE_OPTIONS="--require $probe" M2_0008_NODE_OPTIONS_MARKER="$marker" "$exe" -e "process.exit(require('node:fs').existsSync(process.env.M2_0008_NODE_OPTIONS_MARKER) ? 0 : 42)" >/dev/null 2>"$probe_dir/stderr.txt"; then
    status="ENABLED"
    detail="NODE_OPTIONS --require loaded under ELECTRON_RUN_AS_NODE"
  elif [[ -f "$marker" ]]; then
    status="ENABLED"
    detail="marker written although command exited non-zero"
  else
    status="DISABLED_OR_UNAVAILABLE"
    detail="marker absent after ELECTRON_RUN_AS_NODE probe"
  fi
  printf '{"node_options_fuse":%s,"detail":%s}\n' "$(json_string "$status")" "$(json_string "$detail")" > "$OUT/node-options-fuse.json"
}

write_fixture_manifest() {
  local opened=0
  local item
  for item in "${FIFO_FIXTURES[@]}"; do
    if release_fifo_once "$item"; then
      opened=$((opened + 1))
    fi
  done
  {
    printf '{\n'
    printf '  "kind": "fifo",\n'
    printf '  "count": %s,\n' "${#FIFO_FIXTURES[@]}"
    printf '  "opened_by_1_9_6": %s,\n' "$opened"
    printf '  "fixtures": [\n'
    local first=1
    for item in "${FIFO_FIXTURES[@]}"; do
      [[ "$first" == 1 ]] || printf ',\n'
      first=0
      printf '    %s' "$(json_string "$(rel_to_profile "$item")")"
    done
    printf '\n  ]\n}\n'
  } > "$OUT/fifo-fixtures.json"
}

link_os_fixture() {
  local src=$1
  local dest=$2
  [[ -n "$src" ]] || return 0
  [[ -e "$src" ]] || fail "OS fixture does not exist"
  rm -f "$dest"
  ln -s "$src" "$dest"
}

make_fifo_fixtures() {
  local root=$1
  mkdir -p "$root/.brain/entities/person" "$root/.brain/entities/account"
  FIFO_FIXTURES=(
    "$root/2026-01-01_090000-m2-0008-fifo-1.md"
    "$root/2026-01-02_090000-m2-0008-fifo-2.md"
    "$root/2026-01-03_090000-m2-0008-fifo-3.md"
    "$root/2026-01-04_090000-m2-0008-fifo-4.md"
    "$root/.brain/index.json"
    "$root/.brain/entities/person/m2-0008-fifo-person.json"
    "$root/.brain/entities/account/m2-0008-fifo-account.json"
  )
  local item
  for item in "${FIFO_FIXTURES[@]}"; do
    make_fifo "$item"
  done
}

write_environment() {
  {
    printf '{\n'
    printf '  "ticket": "M2-0008",\n'
    printf '  "artifact_sha256": %s,\n' "$(json_string "$ARTIFACT")"
    printf '  "build_run_id": %s,\n' "$(json_string "$BUILD_RUN_ID")"
    printf '  "qa_account_asserted": %s,\n' "$QA_ACCOUNT"
    printf '  "dry_run": %s,\n' "$DRY_RUN"
    printf '  "app_executable_sha256": %s,\n' "$(json_string "${APP_EXE_SHA:-not-recorded}")"
    printf '  "profile_template_used": %s,\n' "$(json_string "$([[ -n "${PROFILE_TEMPLATE:-}" ]] && echo yes || echo no)")"
    printf '  "minutes": %s\n' "$MINUTES"
    printf '}\n'
  } > "$OUT/environment.json"
}

record_dataless_fixture_state() {
  local out="$OUT/dataless-fixtures.json"
  printf '{\n  "fixtures": [\n' > "$out"
  local first=1
  local label path flags dataless
  for label in brain-index meeting; do
    if [[ "$label" == "brain-index" ]]; then
      path=$DATALess_BRAIN_INDEX
    else
      path=$DATALess_MEETING
    fi
    [[ -n "$path" ]] || continue
    [[ -e "$path" ]] || fail "dataless fixture does not exist: $label"
    flags=$(stat -f '%Uf' "$path" 2>/dev/null || printf '0')
    dataless=false
    if [[ "$flags" =~ ^[0-9]+$ ]] && (( (flags & 1073741824) != 0 )); then
      dataless=true
    fi
    [[ "$DRY_RUN" == 1 || "$dataless" == true ]] || fail "dataless fixture is not marked dataless by stat: $label"
    [[ "$first" == 1 ]] || printf ',\n' >> "$out"
    first=0
    printf '    {"label":%s,"path":%s,"stat_user_flags":%s,"dataless":%s}' \
      "$(json_string "$label")" \
      "$(json_string "$(redact_string "$path")")" \
      "$(json_string "$flags")" \
      "$dataless" >> "$out"
  done
  printf '\n  ]\n}\n' >> "$out"
}

write_evidence_records() {
  local result=${1:-PASS}
  if [[ "$DRY_RUN" == 1 ]]; then
    cat > "$OUT/M2-0008.records.README.md" <<'EOF_RECORD_DRY'
# Evidence Record Not Emitted

This was a dry run. LIVE_VERIFIED evidence is emitted only by a QA-account live run against the unmodified installed artifact.
EOF_RECORD_DRY
    return
  fi
  local output_hash
  output_hash=$(sha256_file "$OUT/matrix.jsonl")
  local now
  now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  local bundle_id
  bundle_id=$(basename "$OUT")
  cat > "$OUT/M2-0008.evidence-import.json" <<EOF_IMPORT
{
  "ticket": "M2-0008",
  "recorded_at": "$now",
  "result": "$result",
  "artifact_sha256": "$ARTIFACT",
  "build_run_id": $BUILD_RUN_ID,
  "bundle_id": "$bundle_id",
  "matrix_sha256": "$output_hash",
  "implementer_session_id": "$(json_escape "$IMPLEMENTER_SESSION_ID")",
  "validator_session_id": "$(json_escape "$VALIDATOR_SESSION_ID")",
  "owner_bug_records": [
    {"bug": "history-freeze", "artifact_sha256": "$ARTIFACT", "matrix_rows": ["row-1-history-open", "row-2-brain-status-blocked-brain", "row-5-dataless-brain-idle", "row-9-network-off-flapping"]},
    {"bug": "no-reopen", "artifact_sha256": "$ARTIFACT", "matrix_rows": ["row-3-macos-activate", "row-4-second-instance-reopen"]}
  ]
}
EOF_IMPORT
  cat > "$OUT/M2-0008.records.README.md" <<'EOF_RECORDS'
# Evidence Import Ready

The public bundle contains a content-free import manifest. Create the formal LIVE_VERIFIED record in the controlled program evidence store after validating this bundle and its paired baseline record.
EOF_RECORDS
}

ARTIFACT=""
BUILD_RUN_ID=""
APP=""
PROFILE_TEMPLATE=""
OUT=""
MINUTES=5
DRY_RUN=0
QA_ACCOUNT=0
DATALess_BRAIN_INDEX=""
DATALess_MEETING=""
IMPLEMENTER_SESSION_ID=""
VALIDATOR_SESSION_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --artifact) ARTIFACT=${2:-}; shift 2 ;;
    --build-run-id) BUILD_RUN_ID=${2:-}; shift 2 ;;
    --app) APP=${2:-}; shift 2 ;;
    --profile-template) PROFILE_TEMPLATE=${2:-}; shift 2 ;;
    --out) OUT=${2:-}; shift 2 ;;
    --minutes) MINUTES=${2:-}; shift 2 ;;
    --dataless-brain-index) DATALess_BRAIN_INDEX=${2:-}; shift 2 ;;
    --dataless-meeting) DATALess_MEETING=${2:-}; shift 2 ;;
    --implementer-session-id) IMPLEMENTER_SESSION_ID=${2:-}; shift 2 ;;
    --validator-session-id) VALIDATOR_SESSION_ID=${2:-}; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --qa-account) QA_ACCOUNT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ "$ARTIFACT" =~ ^[0-9a-f]{64}$ ]] || fail "--artifact must be a lowercase sha256"
[[ "$BUILD_RUN_ID" =~ ^[0-9]+$ ]] || fail "--build-run-id must be a positive integer"
[[ "$MINUTES" =~ ^[0-9]+$ && "$MINUTES" -gt 0 ]] || fail "--minutes must be a positive integer"
[[ "$DRY_RUN" == 1 || "$QA_ACCOUNT" == 1 ]] || fail "--qa-account is required for live runs"
[[ "$DRY_RUN" == 1 || "$(uname -s)" == "Darwin" ]] || fail "live M2-0008 sampling currently runs on macOS QA only"
[[ "$DRY_RUN" == 1 || -n "$APP" ]] || fail "--app is required for live runs"
[[ "$DRY_RUN" == 1 || -d "$PROFILE_TEMPLATE" ]] || fail "--profile-template must exist for live runs"
[[ -z "$IMPLEMENTER_SESSION_ID" || "$IMPLEMENTER_SESSION_ID" =~ ^[A-Za-z0-9._:-]+$ ]] || fail "--implementer-session-id has unsupported characters"
[[ -z "$VALIDATOR_SESSION_ID" || "$VALIDATOR_SESSION_ID" =~ ^[A-Za-z0-9._:-]+$ ]] || fail "--validator-session-id has unsupported characters"

timestamp=$(date -u '+%Y%m%dT%H%M%SZ')
[[ -n "$OUT" ]] || OUT="${TMPDIR:-/tmp}/metis-freeze-repro/$timestamp"
mkdir -p "$OUT"
SAMPLE_DIR="$OUT/samples"
mkdir -p "$SAMPLE_DIR"
: > "$OUT/matrix.jsonl"
: > "$OUT/interrupt-results.jsonl"
STAMP="$OUT/run-start.stamp"
: > "$STAMP"

PROFILE=$(mktemp -d "${TMPDIR:-/tmp}/metis-m2-0008-profile-XXXXXX")
IDLE_PROFILE=$(mktemp -d "${TMPDIR:-/tmp}/metis-m2-0008-idle-profile-XXXXXX")
cleanup() {
  stop_app
  local item
  for item in "${FIFO_FIXTURES[@]:-}"; do
    release_fifo_once "$item" >/dev/null 2>&1 || true
  done
  rm -rf "$PROFILE"
  rm -rf "$IDLE_PROFILE"
}
trap cleanup EXIT

if [[ -n "$PROFILE_TEMPLATE" ]]; then
  ditto "$PROFILE_TEMPLATE" "$PROFILE"
  ditto "$PROFILE_TEMPLATE" "$IDLE_PROFILE"
fi
MEETINGS_ROOT="$PROFILE/Métis Meetings"
make_fifo_fixtures "$MEETINGS_ROOT"
IDLE_MEETINGS_ROOT="$IDLE_PROFILE/Métis Meetings"
mkdir -p "$IDLE_MEETINGS_ROOT/.brain"
link_os_fixture "$DATALess_BRAIN_INDEX" "$IDLE_MEETINGS_ROOT/.brain/index.json"
link_os_fixture "$DATALess_MEETING" "$IDLE_MEETINGS_ROOT/2026-01-09_090000-m2-0008-dataless-meeting.md"

if [[ "$DRY_RUN" == 0 ]]; then
  EXE=$(resolve_exe "$APP")
  [[ -x "$EXE" ]] || fail "app executable is not executable"
  APP_EXE_SHA=$(sha256_file "$EXE")
  record_fuse_state "$EXE"
  launch_app "$PROFILE"
else
  APP_EXE_SHA="dry-run"
  printf '{"node_options_fuse":"NOT_EXERCISED","detail":"dry-run"}\n' > "$OUT/node-options-fuse.json"
fi

write_environment
record_dataless_fixture_state

row_result=$(prompt_result "row-1-history-open" "Row 1: open History/Recall with FIFO meeting and .brain fixtures in place, wait for freeze/no-freeze evidence, then press return.")
sample_app "row-1-history-open"
append_jsonl "$OUT/matrix.jsonl" "{\"row\":\"row-1-history-open\",\"operator_result\":$(json_string "$row_result")}"

row_result=$(prompt_result "row-2-brain-status-blocked-brain" "Row 2: leave the blocked .brain/index.json fixture in place until the brainStatus poll should fire, then press return.")
sample_app "row-2-brain-status-blocked-brain"
append_jsonl "$OUT/matrix.jsonl" "{\"row\":\"row-2-brain-status-blocked-brain\",\"operator_result\":$(json_string "$row_result")}"

row_result=$(prompt_result "row-3-macos-activate" "Row 3: hide/island the app, activate the existing app from macOS, and record whether it reopens.")
sample_app "row-3-macos-activate"
append_jsonl "$OUT/matrix.jsonl" "{\"row\":\"row-3-macos-activate\",\"operator_result\":$(json_string "$row_result")}"

row_result=$(prompt_result "row-4-second-instance-reopen" "Row 4: launch a second instance/open request for the installed app and record whether the existing hidden/island layout reopens.")
sample_app "row-4-second-instance-reopen"
append_jsonl "$OUT/matrix.jsonl" "{\"row\":\"row-4-second-instance-reopen\",\"operator_result\":$(json_string "$row_result")}"

if [[ -n "$DATALess_BRAIN_INDEX" ]]; then
  if [[ "$DRY_RUN" == 0 ]]; then
    stop_app
    launch_app "$IDLE_PROFILE"
  fi
  row_result=$(prompt_result "row-5-dataless-brain-idle" "Row 5: use the real evicted .brain/index.json fixture and do not open History; wait $MINUTES minute(s) from launch.")
  [[ "$DRY_RUN" == 1 ]] || sleep "$((MINUTES * 60))"
  sample_app "row-5-dataless-brain-idle"
else
  row_result="not-exercised-missing-dataless-brain-index"
fi
append_jsonl "$OUT/matrix.jsonl" "{\"row\":\"row-5-dataless-brain-idle\",\"operator_result\":$(json_string "$row_result"),\"fixture\":$(json_string "$DATALess_BRAIN_INDEX")}"

row_result=$(prompt_result "row-9-network-off-flapping" "Row 9: with a real hydrating/dataless fixture, turn network off, then flap it on/off once; record whether the blocked read interrupts or remains pinned.")
sample_app "row-9-network-off-flapping"
append_jsonl "$OUT/matrix.jsonl" "{\"row\":\"row-9-network-off-flapping\",\"operator_result\":$(json_string "$row_result"),\"fixture\":$(json_string "$DATALess_MEETING")}"

interrupt=$(prompt_result "interrupt-network-off" "Interrupt test: while a kernel-blocked hydrating read is active, turn network off and record whether the read unwinds.")
append_jsonl "$OUT/interrupt-results.jsonl" "{\"interrupt\":\"network-off\",\"result\":$(json_string "$interrupt")}"
interrupt=$(prompt_result "interrupt-file-provider-cancel" "Interrupt test: cancel hydration in the File Provider UI and record whether the read unwinds.")
append_jsonl "$OUT/interrupt-results.jsonl" "{\"interrupt\":\"file-provider-cancel\",\"result\":$(json_string "$interrupt")}"
interrupt=$(prompt_result "interrupt-process-signal" "Interrupt test: signal the process only after samples are captured; record whether the blocked read unwinds before process exit.")
append_jsonl "$OUT/interrupt-results.jsonl" "{\"interrupt\":\"process-signal\",\"result\":$(json_string "$interrupt")}"

write_fixture_manifest
copy_diagnostic_reports "$STAMP"
write_evidence_records PASS

cat > "$OUT/README.md" <<EOF_README
# M2-0008 Freeze Repro Bundle

- Artifact sha256: \`$ARTIFACT\`
- Build run id: \`$BUILD_RUN_ID\`
- Matrix rows: \`matrix.jsonl\`
- FIFO fixture evidence: \`fifo-fixtures.json\`
- NODE_OPTIONS fuse state: \`node-options-fuse.json\`
- Interrupt checks for ADR-021/C10: \`interrupt-results.jsonl\`
- Main/renderer samples: \`samples/\`
- DiagnosticReports .spin/.hang copies, if any: \`diagnostic-reports/\`
- Evidence import manifest: \`M2-0008.evidence-import.json\`
EOF_README

printf '[M2-0008] wrote content-free bundle: %s\n' "$OUT"
