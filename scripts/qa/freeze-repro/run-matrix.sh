#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: bash scripts/qa/freeze-repro/run-matrix.sh --artifact <1.9.6 sha256> --build-run-id <id> --app <Metis.app> --profile-template <dir> [options]
       bash scripts/qa/freeze-repro/run-matrix.sh --hosted-live --artifact <1.9.6 sha256> --build-run-id <id> --app <Metis.app> [--out <dir>]

Runs the M2-0008 freeze/no-reopen matrix on the QA macOS account against the unmodified packaged 1.9.6 app.
Use --dry-run in CI to verify the fixture and report wiring without launching the app.
Use --hosted-live on a macos-latest hosted runner: it builds its own synthetic, content-free profile, launches
the app, drives rows 1-4 itself over DevTools and `open`, samples main and every renderer, never reads
stdin, and writes rows that need a real cloud-file account as BLOCKED_EXTERNAL.

Required for live QA:
  --artifact <sha256>          sha256 of the installed 1.9.6 artifact under test
  --build-run-id <id>          build/provenance run id that produced the artifact
  --app <path>                 installed Metis.app or executable
  --profile-template <dir>     representative synthetic userData profile from M2-0007
  --dataless-brain-index <p>   real evicted .brain/index.json fixture for the idle row
  --dataless-meeting <p>       real evicted meeting fixture for the network/flapping row
  --implementer-session-id <id> opaque implementer session id for the LIVE_VERIFIED record
  --validator-session-id <id>   opaque validator session id for the LIVE_VERIFIED record
  --qa-account                 explicit assertion that this is not the owner's primary account

Options:
  --out <dir>                  output bundle directory (default: ${TMPDIR:-/tmp}/metis-freeze-repro/<timestamp>)
  --minutes <n>                dataless idle row duration in minutes (default: 5)
  --qa-host-label <label>      public QA host label for the evidence record (default: qa-mac-1; with --hosted-live,
                               macos-latest or windows-latest, default macos-latest)
  --implementer-model <id>     implementer model label for the evidence record
  --validator-model <id>       validator model label for the evidence record
  --collect-diagnostic-reports explicit consent to collect matching Metis/AskToto .spin/.hang reports
  --dry-run                    create fixtures and reports without launching or sampling; if --app is provided,
                               record the app executable hash and NODE_OPTIONS fuse state
  --hosted-live                non-interactive hosted-runner live run (mutually exclusive with --dry-run); needs
                               only --artifact, --build-run-id and --app
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
  # $HOME is matched literally: a Windows-style home holds backslashes and dots that a regex would misread.
  perl -pe 'BEGIN { $home = shift @ARGV } s/\Q$home\E/\$HOME/g if length $home' "$HOME" "$src" > "$dest"
}

redact_string() {
  printf '%s' "${1/#$HOME/\$HOME}"
}

# Hashes stdin, never a named file: GNU sha256sum prefixes the digest with "\" when the file name holds a
# backslash (every Windows path), which would corrupt the hex digest and the JSON it is written into.
sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 < "$1" | awk '{print $1}'
    return
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum < "$1" | awk '{print $1}'
    return
  fi
  fail "no sha256 tool available"
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
  if mkfifo -m 600 "$path" 2>/dev/null; then
    return 0
  fi
  [[ "$DRY_RUN" == 1 ]] || fail "could not create FIFO fixture: $path"
  : > "$path"
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
    read -r value || value="not-recorded"
    [[ -n "$value" ]] || value="not-recorded"
  fi
  printf '%s' "$value"
}

is_exercised_result() {
  case "$1" in
    observed|pass|fail) return 0 ;;
    *) return 1 ;;
  esac
}

record_row_result() {
  local row=$1
  local result=$2
  shift 2
  if [[ "$DRY_RUN" == 0 ]] && ! is_exercised_result "$result"; then
    MATRIX_RESULT_FAILURES=$((MATRIX_RESULT_FAILURES + 1))
  fi
  append_jsonl "$OUT/matrix.jsonl" "{\"row\":$(json_string "$row"),\"operator_result\":$(json_string "$result")$*}"
}

record_interrupt_result() {
  local interrupt=$1
  local result=$2
  if [[ "$DRY_RUN" == 0 ]] && ! is_exercised_result "$result"; then
    INTERRUPT_RESULT_FAILURES=$((INTERRUPT_RESULT_FAILURES + 1))
  fi
  append_jsonl "$OUT/interrupt-results.jsonl" "{\"interrupt\":$(json_string "$interrupt"),\"result\":$(json_string "$result")${3-}}"
}

# Hosted-live only: a row or interrupt that needs an outside account is recorded, never faked, and is not
# a matrix failure.
record_blocked_row() {
  local row=$1
  shift
  append_jsonl "$OUT/matrix.jsonl" "{\"row\":$(json_string "$row"),\"operator_result\":\"BLOCKED_EXTERNAL\",\"status\":\"BLOCKED_EXTERNAL\",\"unblock_step\":$(json_string "$CLOUD_ACCOUNT_UNBLOCK_STEP")$*}"
}

record_blocked_interrupt() {
  append_jsonl "$OUT/interrupt-results.jsonl" "{\"interrupt\":$(json_string "$1"),\"result\":\"BLOCKED_EXTERNAL\",\"status\":\"BLOCKED_EXTERNAL\",\"unblock_step\":$(json_string "$CLOUD_ACCOUNT_UNBLOCK_STEP")}"
}

sample_pid() {
  local pid=$1
  local label=$2
  local raw="$SAMPLE_DIR/${label}.raw.sample.txt"
  local redacted="$SAMPLE_DIR/${label}.sample.txt"
  if ! command -v "$SAMPLE_BIN" >/dev/null 2>&1; then
    return 1
  fi
  if ! "$SAMPLE_BIN" "$pid" 10 -file "$raw" >/dev/null 2>&1; then
    rm -f "$raw"
    return 1
  fi
  [[ -s "$raw" ]] || {
    rm -f "$raw"
    return 1
  }
  redact_to_file "$raw" "$redacted"
  rm -f "$raw"
  [[ -s "$redacted" ]]
}

launch_app() {
  local profile=$1
  write_launch_plan "$profile"
  ASKTOTO_USERDATA="$profile" "$EXE" "--user-data-dir=$profile" "--remote-debugging-port=$CDP_PORT" >/dev/null 2>"$OUT/app.stderr.txt" &
  APP_PID=$!
  sleep "$LAUNCH_SETTLE_SECONDS"
}

stop_app() {
  if [[ -n "${APP_PID:-}" ]]; then
    kill "$APP_PID" >/dev/null 2>&1 || true
    wait "$APP_PID" >/dev/null 2>&1 || true
    APP_PID=""
  fi
}

# Renderers are chosen by process role (Chromium's --type=renderer switch), never by child order: the
# first children are usually the GPU and utility helpers. The command line is matched, never recorded.
renderer_pids() {
  local main_pid=$1
  local pid
  for pid in $("$PGREP_BIN" -P "$main_pid" 2>/dev/null || true); do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    case " $("$PS_BIN" -ww -o command= -p "$pid" 2>/dev/null || true) " in
      *" --type=renderer "*) printf '%s\n' "$pid" ;;
    esac
  done
}

sample_app() {
  local row=$1
  if [[ "$DRY_RUN" == 1 || -z "${APP_PID:-}" ]]; then
    append_jsonl "$OUT/matrix.jsonl" "{\"row\":$(json_string "$row"),\"sampled\":false,\"reason\":\"dry-run-or-no-app\"}"
    return
  fi
  local main_sampled=true
  printf '%s\n' "$APP_PID" >> "$OUT/app-pids.txt"
  if ! sample_pid "$APP_PID" "$row-main"; then
    main_sampled=false
    SAMPLE_FAILURES=$((SAMPLE_FAILURES + 1))
  fi
  local rp renderer_successes=0 renderer_attempts=0
  while IFS= read -r rp; do
    [[ -n "$rp" ]] || continue
    renderer_attempts=$((renderer_attempts + 1))
    printf '%s\n' "$rp" >> "$OUT/app-pids.txt"
    if sample_pid "$rp" "$row-renderer-$rp"; then
      renderer_successes=$((renderer_successes + 1))
    else
      SAMPLE_FAILURES=$((SAMPLE_FAILURES + 1))
    fi
  done < <(renderer_pids "$APP_PID")
  if (( renderer_successes == 0 )); then
    SAMPLE_FAILURES=$((SAMPLE_FAILURES + 1))
  fi
  append_jsonl "$OUT/matrix.jsonl" "{\"row\":$(json_string "$row"),\"sampled\":$([[ "$main_sampled" == true && "$renderer_successes" -gt 0 ]] && printf true || printf false),\"main_pid\":$APP_PID,\"main_sample\":$main_sampled,\"renderer_attempts\":$renderer_attempts,\"renderer_samples\":$renderer_successes,\"renderers_selected_by\":\"--type=renderer\"}"
}

write_launch_plan() {
  local profile=$1
  cat > "$OUT/launch-plan.json" <<EOF_LAUNCH
{"asktoto_userdata_env":true,"electron_user_data_dir_switch":true,"profile":$(json_string "$(redact_string "$profile")"),"argv":["--user-data-dir=<profile>","--remote-debugging-port=$CDP_PORT"]}
EOF_LAUNCH
}

copy_diagnostic_reports() {
  local stamp=$1
  cat > "$OUT/diagnostic-reports.json" <<EOF_DIAG
{"consented":$([[ "$COLLECT_DIAGNOSTIC_REPORTS" == 1 ]] && printf true || printf false),"source":"Library/Logs/DiagnosticReports","filter":"Metis/AskToto process names or sampled process ids only","copied":[]}
EOF_DIAG
  [[ "$COLLECT_DIAGNOSTIC_REPORTS" == 1 ]] || return 0
  local reports="$OUT/diagnostic-reports"
  mkdir -p "$reports"
  [[ -d /Library/Logs/DiagnosticReports ]] || return 0
  local copied_json=""
  find /Library/Logs/DiagnosticReports -type f \( -name '*.spin' -o -name '*.hang' \) -newer "$stamp" -print 2>/dev/null |
    while IFS= read -r report; do
      diagnostic_report_matches_app "$report" || continue
      local dest="$reports/$(basename "$report").txt"
      if redact_to_file "$report" "$dest"; then
        local item
        item=$(json_string "diagnostic-reports/$(basename "$dest")")
        [[ -z "$copied_json" ]] || copied_json+=","
        copied_json+="$item"
        printf '{"consented":true,"source":"Library/Logs/DiagnosticReports","filter":"Metis/AskToto process names or sampled process ids only","copied":[%s]}\n' "$copied_json" > "$OUT/diagnostic-reports.json"
      fi
    done
}

diagnostic_report_matches_app() {
  local report=$1
  local name
  name=$(basename "$report")
  if [[ "$name" =~ (Metis|AskToto|asktoto) ]]; then
    return 0
  fi
  if grep -E -m 1 '^(Process|Path|Identifier): .*([Mm]etis|AskToto|asktoto)' "$report" >/dev/null 2>&1; then
    return 0
  fi
  [[ -s "$OUT/app-pids.txt" ]] || return 1
  local pid
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    if grep -E -m 1 "(^Process: .+\\[$pid\\]$|pid[[:space:]]*[:=][[:space:]]*$pid|PID[[:space:]]*[:=][[:space:]]*$pid)" "$report" >/dev/null 2>&1; then
      return 0
    fi
  done < "$OUT/app-pids.txt"
  return 1
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
  local placeholders=0
  local item
  local -a opened_states=()
  local position=0
  for item in "${FIFO_FIXTURES[@]}"; do
    if [[ ! -p "$item" ]]; then
      placeholders=$((placeholders + 1))
      opened_states+=("placeholder")
    elif (( ${#FIFO_HELD_STATES[@]} > 0 )); then
      # Hosted-live already probed each reader once, in FIFO_FIXTURES order, while holding the write ends
      # (hold_fifo_writers); probing again here would find those ends released.
      opened_states+=("${FIFO_HELD_STATES[$position]:-false}")
      [[ "${FIFO_HELD_STATES[$position]:-false}" != true ]] || opened=$((opened + 1))
    elif release_fifo_once "$item"; then
      opened=$((opened + 1))
      opened_states+=("true")
    else
      opened_states+=("false")
    fi
    position=$((position + 1))
  done
  {
    printf '{\n'
    printf '  "kind": "fifo",\n'
    printf '  "count": %s,\n' "${#FIFO_FIXTURES[@]}"
    printf '  "dry_run_placeholders": %s,\n' "$placeholders"
    printf '  "opened_by_1_9_6": %s,\n' "$opened"
    printf '  "fixtures": [\n'
    local first=1
    local index=0
    for item in "${FIFO_FIXTURES[@]}"; do
      [[ "$first" == 1 ]] || printf ',\n'
      first=0
      local state=${opened_states[$index]}
      printf '    {"path":%s,"opened_by_1_9_6":%s}' \
        "$(json_string "$(rel_to_profile "$item")")" \
        "$([[ "$state" == placeholder ]] && printf null || printf '%s' "$state")"
      index=$((index + 1))
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

copy_profile_template() {
  local src=$1
  local dest=$2
  if command -v ditto >/dev/null 2>&1; then
    ditto "$src" "$dest"
  else
    cp -R "$src"/. "$dest"/
  fi
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
    printf '  "dataless_brain_index_required": %s,\n' "$([[ "$DRY_RUN" == 1 || -n "$DATALess_BRAIN_INDEX" ]] && printf true || printf false)"
    printf '  "dataless_meeting_required": %s,\n' "$([[ "$DRY_RUN" == 1 || -n "$DATALess_MEETING" ]] && printf true || printf false)"
    if [[ "$HOSTED_LIVE" == 1 ]]; then
      printf '  "host": {"label": %s, "os": %s, "os_version": %s, "arch": %s, "memory_bytes": %s},\n' \
        "$(json_string "$QA_HOST_LABEL")" \
        "$(json_string "$(uname -s)")" \
        "$(json_string "$(host_os_version)")" \
        "$(json_string "$(uname -m)")" \
        "$(host_memory_bytes)"
    fi
    printf '  "mode": %s,\n' "$(json_string "$MODE")"
    printf '  "minutes": %s\n' "$MINUTES"
    printf '}\n'
  } > "$OUT/environment.json"
}

# Content-free host facts only: no host name, user name or serial.
host_os_version() {
  if command -v sw_vers >/dev/null 2>&1; then
    sw_vers -productVersion 2>/dev/null || uname -r
  else
    uname -r
  fi
}

host_memory_bytes() {
  local bytes=""
  if [[ "$(uname -s)" == Darwin ]]; then
    bytes=$(sysctl -n hw.memsize 2>/dev/null || true)
  elif [[ -r /proc/meminfo ]]; then
    bytes=$(awk '/^MemTotal:/ {printf "%.0f", $2 * 1024}' /proc/meminfo)
  fi
  [[ "$bytes" =~ ^[0-9]+$ ]] && printf '%s' "$bytes" || printf 'null'
}

write_external_blockers() {
  if [[ "$HOSTED_LIVE" == 1 ]]; then
    cat > "$OUT/external-blockers.json" <<EOF_HOSTED_BLOCKERS
{
  "ticket": "M2-0008",
  "mode": "hosted-live",
  "blockers": [
    {
      "status": "BLOCKED_EXTERNAL",
      "rows": ["row-5-dataless-brain-idle", "row-9-network-off-flapping"],
      "interrupts": ["network-off", "file-provider-cancel"],
      "needs": "a test cloud-file account with real hydrating (dataless) files; none exists after D-9",
      "unblock_step": $(json_string "$CLOUD_ACCOUNT_UNBLOCK_STEP")
    }
  ]
}
EOF_HOSTED_BLOCKERS
    return
  fi
  if [[ "$DRY_RUN" == 0 ]]; then
    printf '{"ticket":"M2-0008","blockers":[]}\n' > "$OUT/external-blockers.json"
    return
  fi
  cat > "$OUT/external-blockers.json" <<'EOF_BLOCKERS'
{
  "ticket": "M2-0008",
  "blockers": [
    {
      "status": "BLOCKED_EXTERNAL",
      "rows": ["row-1-history-open", "row-2-brain-status-blocked-brain", "row-5-dataless-brain-idle", "row-9-network-off-flapping"],
      "unblock_step": "Run the same harness on the QA account with a representative synthetic profile, real dataless cloud-file fixtures, network-off and network-flapping observations, and consented DiagnosticReports collection."
    },
    {
      "status": "BLOCKED_EXTERNAL",
      "rows": ["row-3-macos-activate", "row-4-second-instance-reopen"],
      "unblock_step": "Run the same harness on the QA macOS desktop session against the installed 1.9.6 app and record activate versus second-instance reopen behavior."
    }
  ]
}
EOF_BLOCKERS
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
    if [[ "$(uname -s)" != "Darwin" && "${M2_0008_CONTRACT_ALLOW_NON_DARWIN:-0}" == 1 ]]; then
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
# Evidence Import Not Emitted

This was a dry run. Evidence import metadata is emitted only by a QA-account live run against the unmodified installed artifact.
EOF_RECORD_DRY
    return
  fi
  local output_hash bug_hash
  output_hash=$(sha256_file "$OUT/matrix.jsonl")
  local now
  now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  local bundle_id
  bundle_id=$(basename "$OUT")
  cat > "$OUT/owner-bug-records.json" <<EOF_BUGS
{
  "ticket": "M2-0008",
  "artifact_sha256": "$ARTIFACT",
  "owner_bug_records": [
    {"bug": "history-freeze", "artifact_sha256": "$ARTIFACT", "matrix_rows": ["row-1-history-open", "row-2-brain-status-blocked-brain", "row-5-dataless-brain-idle", "row-9-network-off-flapping"]},
    {"bug": "no-reopen", "artifact_sha256": "$ARTIFACT", "matrix_rows": ["row-3-macos-activate", "row-4-second-instance-reopen"]}
  ]
}
EOF_BUGS
  bug_hash=$(sha256_file "$OUT/owner-bug-records.json")
  local commit
  commit=$(git rev-parse HEAD 2>/dev/null || printf '0000000000000000000000000000000000000000')
  local exit_code=0
  [[ "$result" == PASS ]] || exit_code=2
  if [[ "$HOSTED_LIVE" == 1 ]]; then
    write_hosted_evidence_import "$result" "$now" "$bundle_id" "$output_hash" "$bug_hash" "$commit" "$exit_code"
    return
  fi
  local command
  command="bash scripts/qa/freeze-repro/run-matrix.sh --artifact <1.9.6-sha256> --build-run-id $BUILD_RUN_ID --app <installed-1.9.6-app> --profile-template <m2-0007-synthetic-userdata> --dataless-brain-index <evicted-brain-index> --dataless-meeting <evicted-meeting> --implementer-session-id <opaque> --validator-session-id <opaque> --qa-account"
  cat > "$OUT/M2-0008.evidence-import.json" <<EOF_IMPORT
{
  "ticket": "M2-0008",
  "recorded_at": "$now",
  "result": "$result",
  "artifact_sha256": "$ARTIFACT",
  "build_run_id": $BUILD_RUN_ID,
  "bundle_id": "$bundle_id",
  "matrix_sha256": "$output_hash",
  "owner_bug_records_sha256": "$bug_hash",
  "implementer_session_id": "$(json_escape "$IMPLEMENTER_SESSION_ID")",
  "validator_session_id": "$(json_escape "$VALIDATOR_SESSION_ID")",
  "implementer_model": "$(json_escape "$IMPLEMENTER_MODEL")",
  "validator_model": "$(json_escape "$VALIDATOR_MODEL")",
  "qa_host_label": "$(json_escape "$QA_HOST_LABEL")",
  "commit": "$commit",
  "command": $(json_string "$command"),
  "exit_code": $exit_code,
  "sample_failures": $SAMPLE_FAILURES,
  "matrix_result_failures": $MATRIX_RESULT_FAILURES,
  "interrupt_result_failures": $INTERRUPT_RESULT_FAILURES,
  "baseline_chain_position": {
    "first": "M2-0008",
    "second": "M2-0009",
    "requires_paired_m2_0009_baseline": true
  },
  "required_evidence_level": "LIVE_VERIFIED",
  "outputs": [
    {"kind": "matrix", "path": "matrix.jsonl", "sha256": "$output_hash"},
    {"kind": "owner-bug-records", "path": "owner-bug-records.json", "sha256": "$bug_hash"}
  ],
  "owner_bug_records": [
    {"bug": "history-freeze", "artifact_sha256": "$ARTIFACT", "matrix_rows": ["row-1-history-open", "row-2-brain-status-blocked-brain", "row-5-dataless-brain-idle", "row-9-network-off-flapping"]},
    {"bug": "no-reopen", "artifact_sha256": "$ARTIFACT", "matrix_rows": ["row-3-macos-activate", "row-4-second-instance-reopen"]}
  ]
}
EOF_IMPORT
  cat > "$OUT/M2-0008.records.README.md" <<'EOF_RECORDS'
# Evidence Import Manifest

This live QA bundle emitted `M2-0008.evidence-import.json` and `owner-bug-records.json`.
Use those content-free files to file the controlled program evidence records after validating this bundle and its paired M2-0009 baseline record.
EOF_RECORDS
}

# The hosted-live import carries the OD-26 hosted-runner environment kind (record.mjs) instead of a QA host
# label. Session ids are left to the lead who files the record; ci_run_id is the Actions run that executed
# this matrix (GITHUB_RUN_ID), which record.mjs requires for a hosted-runner LIVE_VERIFIED record.
write_hosted_evidence_import() {
  local result=$1 now=$2 bundle_id=$3 output_hash=$4 bug_hash=$5 commit=$6 exit_code=$7
  local ci_run_id=null
  [[ ! "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]*$ ]] || ci_run_id=$GITHUB_RUN_ID
  local command="bash scripts/qa/freeze-repro/run-matrix.sh --hosted-live --artifact <1.9.6-sha256> --build-run-id $BUILD_RUN_ID --app <installed-1.9.6-app>"
  cat > "$OUT/M2-0008.evidence-import.json" <<EOF_HOSTED_IMPORT
{
  "ticket": "M2-0008",
  "mode": "hosted-live",
  "recorded_at": "$now",
  "result": "$result",
  "artifact_sha256": "$ARTIFACT",
  "build_run_id": $BUILD_RUN_ID,
  "ci_run_id": $ci_run_id,
  "environment": {"kind": "hosted-runner", "host": $(json_string "$QA_HOST_LABEL")},
  "bundle_id": $(json_string "$bundle_id"),
  "matrix_sha256": "$output_hash",
  "owner_bug_records_sha256": "$bug_hash",
  "commit": "$commit",
  "command": $(json_string "$command"),
  "exit_code": $exit_code,
  "sample_failures": $SAMPLE_FAILURES,
  "matrix_result_failures": $MATRIX_RESULT_FAILURES,
  "interrupt_result_failures": $INTERRUPT_RESULT_FAILURES,
  "reproduced": $([[ -n "$SYMPTOM_ROWS" ]] && printf true || printf false),
  "blocked_external_rows": ["row-5-dataless-brain-idle", "row-9-network-off-flapping"],
  "blocked_external_interrupts": ["network-off", "file-provider-cancel"],
  "baseline_chain_position": {
    "first": "M2-0008",
    "second": "M2-0009",
    "requires_paired_m2_0009_baseline": true
  },
  "required_evidence_level": "LIVE_VERIFIED",
  "outputs": [
    {"kind": "matrix", "path": "matrix.jsonl", "sha256": "$output_hash"},
    {"kind": "owner-bug-records", "path": "owner-bug-records.json", "sha256": "$bug_hash"}
  ],
  "owner_bug_records": [
    {"bug": "history-freeze", "artifact_sha256": "$ARTIFACT", "matrix_rows": ["row-1-history-open", "row-2-brain-status-blocked-brain", "row-5-dataless-brain-idle", "row-9-network-off-flapping"]},
    {"bug": "no-reopen", "artifact_sha256": "$ARTIFACT", "matrix_rows": ["row-3-macos-activate", "row-4-second-instance-reopen"]}
  ]
}
EOF_HOSTED_IMPORT
  cat > "$OUT/M2-0008.records.README.md" <<'EOF_HOSTED_RECORDS'
# Evidence Import Manifest

This hosted-live bundle emitted `M2-0008.evidence-import.json` and `owner-bug-records.json` with the
hosted-runner environment kind. Rows 5 and 9 and the network-off and file-provider-cancel interrupts are
BLOCKED_EXTERNAL (see `external-blockers.json`). Use those content-free files to file the controlled program
evidence records after validating this bundle and its paired M2-0009 baseline record.
EOF_HOSTED_RECORDS
}

# One automatic row: observe (and drive) over DevTools, then sample main and every renderer while the
# fixtures are still blocking, then record. A precondition failure (the row's own drive step could not
# run) makes the row not-exercised whatever the observation says.
hosted_row() {
  local row=$1 drive=$2 method=$3 precondition=$4
  shift 4
  local observation result
  observation=$(run_with_timeout "$OBSERVE_WALL_SECONDS" node "$SCRIPT_DIR/cdp-observe.mjs" \
    --port "$CDP_PORT" --row "$row" --drive "$drive" --timeout-ms "$OBSERVE_TIMEOUT_MS" 2>/dev/null | head -n 1) || true
  result=$(printf '%s' "$observation" | sed -n 's/^{"operator_result":"\([a-z-]*\)".*}$/\1/p')
  if [[ -z "$result" ]]; then
    result="not-exercised"
    observation=null
  fi
  [[ "$precondition" == ok ]] || result="not-exercised"
  [[ "$result" != observed ]] || SYMPTOM_ROWS+="$row "
  sample_app "$row"
  record_row_result "$row" "$result" ",\"automatic\":true,\"drive_method\":$(json_string "$method"),\"precondition\":$(json_string "$precondition"),\"observation\":$observation$*"
}

# Opens every FIFO fixture for writing without blocking and keeps the write ends open. A fixture the app is
# reading has a reader, so its open succeeds (opened_by_1_9_6: true); the reader's open(2) then returns
# and its read(2) stays blocked, because a writer is present and no data ever arrives. The process-signal
# interrupt below therefore still hits a FIFO-blocked read.
hold_fifo_writers() {
  local states="$FIFO_HOLD_DIR/states"
  perl -e '
    use Fcntl qw(O_WRONLY O_NONBLOCK);
    my $out = shift @ARGV;
    my (@held, $states);
    for my $path (@ARGV) {
      if (sysopen(my $fh, $path, O_WRONLY | O_NONBLOCK)) { push @held, $fh; $states .= "true\n" }
      else { $states .= "false\n" }
    }
    open(my $fh, ">", "$out.part") or exit 2;
    print $fh $states;
    close $fh;
    rename("$out.part", $out) or exit 2;
    sleep 3600;
  ' "$states" "${FIFO_FIXTURES[@]}" &
  FIFO_HOLDER_PID=$!
  local waited=0
  while [[ ! -f "$states" ]] && (( waited < 20 )); do
    sleep 0.5
    waited=$((waited + 1))
  done
  FIFO_HELD_STATES=()
  local state
  if [[ -f "$states" ]]; then
    while IFS= read -r state; do
      FIFO_HELD_STATES+=("$state")
    done < "$states"
  fi
}

release_fifo_writers() {
  if [[ -n "${FIFO_HOLDER_PID:-}" ]]; then
    kill "$FIFO_HOLDER_PID" >/dev/null 2>&1 || true
    wait "$FIFO_HOLDER_PID" >/dev/null 2>&1 || true
    FIFO_HOLDER_PID=""
  fi
}

# Runs after every automatic row has been sampled: SIGTERM to main while the FIFO reads are held blocked,
# then whether it exits within 10 s. Either outcome is an observation; only a signal that could not be sent
# leaves the interrupt not exercised.
hosted_process_signal() {
  hold_fifo_writers
  local result="not-exercised" exited=false waited=0
  if [[ -n "${APP_PID:-}" ]] && kill -TERM "$APP_PID" >/dev/null 2>&1; then
    while (( waited < 10 )); do
      if ! kill -0 "$APP_PID" >/dev/null 2>&1; then
        exited=true
        break
      fi
      sleep 1
      waited=$((waited + 1))
    done
    if [[ "$exited" == true ]]; then
      result="pass"
    else
      result="observed"
      kill -KILL "$APP_PID" >/dev/null 2>&1 || true
    fi
    wait "$APP_PID" >/dev/null 2>&1 || true
    APP_PID=""
  fi
  release_fifo_writers
  record_interrupt_result "process-signal" "$result" \
    ",\"automatic\":true,\"signal\":\"TERM\",\"target\":\"main\",\"against\":\"fifo-blocked-read\",\"exited_within_10s\":$exited,\"waited_seconds\":$waited"
}

run_hosted_live_matrix() {
  local reopen_status

  hosted_row "row-1-history-open" history \
    "cdp Runtime.evaluate window.toto.recallList() with the FIFO meeting and .brain fixtures in place" ok

  sleep "$BRAIN_POLL_WAIT_SECONDS"
  hosted_row "row-2-brain-status-blocked-brain" brain-status \
    "blocked .brain/index.json left in place for ${BRAIN_POLL_WAIT_SECONDS}s (longer than one 2s brainStatus poll), then cdp Runtime.evaluate window.toto.brainStatus()" ok \
    ",\"brain_status_poll_wait_seconds\":$BRAIN_POLL_WAIT_SECONDS"

  reopen_status=ok
  "$OPEN_BIN" "$APP" >/dev/null 2>&1 || reopen_status="open-failed"
  sleep "$REOPEN_SETTLE_SECONDS"
  hosted_row "row-3-macos-activate" none "open <app>" "$reopen_status"

  reopen_status=ok
  # The second instance gets the same profile, so the app's single-instance lock hands it to the first.
  "$OPEN_BIN" -n --env "ASKTOTO_USERDATA=$PROFILE" "$APP" --args "--user-data-dir=$PROFILE" >/dev/null 2>&1 || reopen_status="open-failed"
  sleep "$REOPEN_SETTLE_SECONDS"
  hosted_row "row-4-second-instance-reopen" none "open -n --env ASKTOTO_USERDATA=<profile> <app> --args --user-data-dir=<profile>" "$reopen_status"

  record_blocked_row "row-5-dataless-brain-idle" ',"automatic":false,"fixture":"dataless-brain-index"'
  record_blocked_row "row-9-network-off-flapping" ',"automatic":false,"fixture":"dataless-meeting"'

  record_blocked_interrupt "network-off"
  record_blocked_interrupt "file-provider-cancel"
  hosted_process_signal
}

write_hosted_summary() {
  local reproduced=false conclusion
  [[ -z "$SYMPTOM_ROWS" ]] || reproduced=true
  if (( MATRIX_RESULT_FAILURES > 0 || SAMPLE_FAILURES > 0 || INTERRUPT_RESULT_FAILURES > 0 )); then
    conclusion="incomplete: at least one automatic row, sample or interrupt did not run; this is not a matrix result"
  elif [[ "$reproduced" == true ]]; then
    conclusion="reproduced: an automatic row observed the owner-bug symptom on the unmodified 1.9.6 app"
  else
    conclusion="documented-unsuccessful: every automatic row ran against the unmodified 1.9.6 app with its samples and observed no freeze and no failed reopen; rows 5 and 9 remain BLOCKED_EXTERNAL"
  fi
  local symptom_json="" row
  for row in $SYMPTOM_ROWS; do
    [[ -z "$symptom_json" ]] || symptom_json+=","
    symptom_json+=$(json_string "$row")
  done
  cat > "$OUT/hosted-live-summary.json" <<EOF_SUMMARY
{
  "ticket": "M2-0008",
  "mode": "hosted-live",
  "automatic_rows": ["row-1-history-open", "row-2-brain-status-blocked-brain", "row-3-macos-activate", "row-4-second-instance-reopen"],
  "blocked_external_rows": ["row-5-dataless-brain-idle", "row-9-network-off-flapping"],
  "symptom_rows": [$symptom_json],
  "reproduced": $reproduced,
  "conclusion": $(json_string "$conclusion")
}
EOF_SUMMARY
  HOSTED_CONCLUSION=$conclusion
}

write_lead_action() {
  cat > "$OUT/M2-0008.lead-action.md" <<'EOF_LEAD_ACTION'
LEAD_ACTION: Import this public bundle into the controlled program evidence chain: file the two M2-0008 owner-bug evidence records from owner-bug-records.json and M2-0008.evidence-import.json, then update the M2-0008 hypothesis ranking from matrix.jsonl, interrupt-results.jsonl, fifo-fixtures.json, dataless-fixtures.json, and node-options-fuse.json using OBSERVED for directly measured rows and DERIVED for rankings inferred from those measurements.
EOF_LEAD_ACTION
}

live_result() {
  [[ "$DRY_RUN" == 1 ]] && {
    printf 'PASS'
    return
  }
  if (( SAMPLE_FAILURES > 0 || MATRIX_RESULT_FAILURES > 0 || INTERRUPT_RESULT_FAILURES > 0 )); then
    printf 'FAIL'
    return
  fi
  printf 'PASS'
}

live_failure_summary() {
  local -a reasons=()
  (( SAMPLE_FAILURES == 0 )) || reasons+=("required main and renderer samples")
  (( MATRIX_RESULT_FAILURES == 0 )) || reasons+=("required matrix rows exercised")
  (( INTERRUPT_RESULT_FAILURES == 0 )) || reasons+=("required interrupt checks exercised")
  local joined=""
  local reason
  for reason in "${reasons[@]}"; do
    [[ -z "$joined" ]] || joined+=", "
    joined+="$reason"
  done
  printf '%s' "$joined"
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
IMPLEMENTER_MODEL="claude-sonnet-4-6"
VALIDATOR_MODEL="claude-opus-4-6"
QA_HOST_LABEL=""
COLLECT_DIAGNOSTIC_REPORTS=0
HOSTED_LIVE=0
SAMPLE_FAILURES=0
MATRIX_RESULT_FAILURES=0
INTERRUPT_RESULT_FAILURES=0
LAUNCH_SETTLE_SECONDS="${M2_0008_CONTRACT_LAUNCH_SETTLE_SECONDS:-10}"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SAMPLE_BIN=/usr/bin/sample
OPEN_BIN=/usr/bin/open
PGREP_BIN=pgrep
PS_BIN=ps
CDP_PORT=9334
OBSERVE_TIMEOUT_MS=10000
BRAIN_POLL_WAIT_SECONDS=5
REOPEN_SETTLE_SECONDS=5
# The contract tests substitute the macOS-only tools and shorten the waits; nothing else may.
if [[ "${M2_0008_CONTRACT_ALLOW_NON_DARWIN:-0}" == 1 ]]; then
  SAMPLE_BIN=${M2_0008_CONTRACT_SAMPLE_BIN:-$SAMPLE_BIN}
  OPEN_BIN=${M2_0008_CONTRACT_OPEN_BIN:-$OPEN_BIN}
  PGREP_BIN=${M2_0008_CONTRACT_PGREP_BIN:-$PGREP_BIN}
  PS_BIN=${M2_0008_CONTRACT_PS_BIN:-$PS_BIN}
  CDP_PORT=${M2_0008_CONTRACT_CDP_PORT:-$CDP_PORT}
  OBSERVE_TIMEOUT_MS=${M2_0008_CONTRACT_OBSERVE_TIMEOUT_MS:-$OBSERVE_TIMEOUT_MS}
  BRAIN_POLL_WAIT_SECONDS=${M2_0008_CONTRACT_POLL_WAIT_SECONDS:-$BRAIN_POLL_WAIT_SECONDS}
  REOPEN_SETTLE_SECONDS=${M2_0008_CONTRACT_REOPEN_SETTLE_SECONDS:-$REOPEN_SETTLE_SECONDS}
fi
[[ "$CDP_PORT" =~ ^[1-9][0-9]*$ && "$OBSERVE_TIMEOUT_MS" =~ ^[1-9][0-9]*$ ]] || fail "contract overrides must be positive integers"
# Each observation makes at most three bounded evaluations per page plus the target list.
OBSERVE_WALL_SECONDS=$(( OBSERVE_TIMEOUT_MS * 6 / 1000 + 10 ))
SYMPTOM_ROWS=""
HOSTED_CONCLUSION=""
FIFO_HOLDER_PID=""
FIFO_HELD_STATES=()
CLOUD_ACCOUNT_UNBLOCK_STEP="Provision a test cloud-file account (there is none after D-9) on a macOS host, evict a synthetic .brain/index.json and a synthetic meeting file to dataless, then run run-matrix.sh in QA-live mode with --dataless-brain-index and --dataless-meeting pointing at them."

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
    --implementer-model) IMPLEMENTER_MODEL=${2:-}; shift 2 ;;
    --validator-model) VALIDATOR_MODEL=${2:-}; shift 2 ;;
    --qa-host-label) QA_HOST_LABEL=${2:-}; shift 2 ;;
    --collect-diagnostic-reports) COLLECT_DIAGNOSTIC_REPORTS=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --hosted-live) HOSTED_LIVE=1; shift ;;
    --qa-account) QA_ACCOUNT=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[[ "$HOSTED_LIVE" == 0 || "$DRY_RUN" == 0 ]] || fail "--hosted-live and --dry-run are mutually exclusive"
# QA_LIVE is the interactive QA-account live mode; its requirements below are unchanged.
QA_LIVE=0
[[ "$DRY_RUN" == 1 || "$HOSTED_LIVE" == 1 ]] || QA_LIVE=1
if [[ "$HOSTED_LIVE" == 1 ]]; then
  MODE="hosted-live"
elif [[ "$DRY_RUN" == 1 ]]; then
  MODE="dry-run"
else
  MODE="qa-live"
fi

[[ "$ARTIFACT" =~ ^[0-9a-f]{64}$ ]] || fail "--artifact must be a lowercase sha256"
[[ "$BUILD_RUN_ID" =~ ^[0-9]+$ ]] || fail "--build-run-id must be a positive integer"
[[ "$MINUTES" =~ ^[0-9]+$ && "$MINUTES" -gt 0 ]] || fail "--minutes must be a positive integer"
[[ "$QA_LIVE" == 0 || "$QA_ACCOUNT" == 1 ]] || fail "--qa-account is required for live runs"
[[ "$DRY_RUN" == 1 || -n "$APP" ]] || fail "--app is required for live runs"
[[ "$QA_LIVE" == 0 || -d "$PROFILE_TEMPLATE" ]] || fail "--profile-template must exist for live runs"
[[ "$QA_LIVE" == 0 || -n "$DATALess_BRAIN_INDEX" ]] || fail "--dataless-brain-index is required for live runs"
[[ "$QA_LIVE" == 0 || -n "$DATALess_MEETING" ]] || fail "--dataless-meeting is required for live runs"
[[ "$QA_LIVE" == 0 || -n "$IMPLEMENTER_SESSION_ID" ]] || fail "--implementer-session-id is required for live runs"
[[ "$QA_LIVE" == 0 || -n "$VALIDATOR_SESSION_ID" ]] || fail "--validator-session-id is required for live runs"
# Hosted-live builds its own synthetic, content-free profile and has no cloud-file fixtures.
[[ "$HOSTED_LIVE" == 0 || -z "$PROFILE_TEMPLATE" ]] || fail "--hosted-live builds its own synthetic profile; --profile-template is not accepted"
[[ "$HOSTED_LIVE" == 0 || ( -z "$DATALess_BRAIN_INDEX" && -z "$DATALess_MEETING" ) ]] || fail "--hosted-live has no dataless fixtures; rows 5 and 9 are BLOCKED_EXTERNAL"
[[ "$DRY_RUN" == 1 || "$(uname -s)" == "Darwin" || "${M2_0008_CONTRACT_ALLOW_NON_DARWIN:-0}" == 1 ]] || fail "live M2-0008 sampling currently runs on macOS QA only"
if [[ -z "$QA_HOST_LABEL" ]]; then
  if [[ "$HOSTED_LIVE" == 1 ]]; then QA_HOST_LABEL="macos-latest"; else QA_HOST_LABEL="qa-mac-1"; fi
fi
[[ "$HOSTED_LIVE" == 0 || "$QA_HOST_LABEL" == macos-latest || "$QA_HOST_LABEL" == windows-latest ]] || fail "--hosted-live host must be macos-latest or windows-latest"
[[ -z "$IMPLEMENTER_SESSION_ID" || "$IMPLEMENTER_SESSION_ID" =~ ^[A-Za-z0-9._:-]+$ ]] || fail "--implementer-session-id has unsupported characters"
[[ -z "$VALIDATOR_SESSION_ID" || "$VALIDATOR_SESSION_ID" =~ ^[A-Za-z0-9._:-]+$ ]] || fail "--validator-session-id has unsupported characters"
[[ "$IMPLEMENTER_MODEL" =~ ^[a-z0-9][a-z0-9.-]{0,63}$ ]] || fail "--implementer-model has unsupported characters"
[[ "$VALIDATOR_MODEL" =~ ^[a-z0-9][a-z0-9.-]{0,63}$ ]] || fail "--validator-model has unsupported characters"
[[ "$QA_HOST_LABEL" =~ ^[a-z0-9][a-z0-9._-]{0,62}$ ]] || fail "--qa-host-label has unsupported characters"
[[ "$QA_LIVE" == 0 || "$IMPLEMENTER_SESSION_ID" != "$VALIDATOR_SESSION_ID" ]] || fail "validator session must differ from implementer session"

timestamp=$(date -u '+%Y%m%dT%H%M%SZ')
[[ -n "$OUT" ]] || OUT="${TMPDIR:-/tmp}/metis-freeze-repro/$timestamp"
mkdir -p "$OUT"
SAMPLE_DIR="$OUT/samples"
mkdir -p "$SAMPLE_DIR"
: > "$OUT/matrix.jsonl"
: > "$OUT/interrupt-results.jsonl"
: > "$OUT/app-pids.txt"
STAMP="$OUT/run-start.stamp"
: > "$STAMP"

PROFILE=$(mktemp -d "${TMPDIR:-/tmp}/metis-m2-0008-profile-XXXXXX")
IDLE_PROFILE=$(mktemp -d "${TMPDIR:-/tmp}/metis-m2-0008-idle-profile-XXXXXX")
FIFO_HOLD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/metis-m2-0008-fifo-hold-XXXXXX")
cleanup() {
  stop_app
  release_fifo_writers
  local item
  for item in "${FIFO_FIXTURES[@]:-}"; do
    release_fifo_once "$item" >/dev/null 2>&1 || true
  done
  rm -rf "$PROFILE"
  rm -rf "$IDLE_PROFILE"
  rm -rf "$FIFO_HOLD_DIR"
}
trap cleanup EXIT

if [[ -n "$PROFILE_TEMPLATE" ]]; then
  copy_profile_template "$PROFILE_TEMPLATE" "$PROFILE"
  copy_profile_template "$PROFILE_TEMPLATE" "$IDLE_PROFILE"
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
  if [[ -n "$APP" ]]; then
    EXE=$(resolve_exe "$APP")
    [[ -x "$EXE" ]] || fail "app executable is not executable"
    APP_EXE_SHA=$(sha256_file "$EXE")
    record_fuse_state "$EXE"
  else
    APP_EXE_SHA="dry-run-no-app"
    printf '{"node_options_fuse":"NOT_EXERCISED","detail":"dry-run without --app"}\n' > "$OUT/node-options-fuse.json"
  fi
  write_launch_plan "$PROFILE"
fi

write_environment
write_external_blockers
record_dataless_fixture_state

if [[ "$HOSTED_LIVE" == 1 ]]; then
  # Never reads stdin: every row is driven and judged from machine observations.
  run_hosted_live_matrix
  write_fixture_manifest
  copy_diagnostic_reports "$STAMP"
  RESULT=$(live_result)
  write_hosted_summary
  write_evidence_records "$RESULT"
  write_lead_action
  cat > "$OUT/README.md" <<EOF_HOSTED_README
# M2-0008 Freeze Repro Bundle (hosted-live)

- Mode: \`hosted-live\` on \`$QA_HOST_LABEL\`
- Result: \`$RESULT\`
- Conclusion: $HOSTED_CONCLUSION
- Artifact sha256: \`$ARTIFACT\`
- Build run id: \`$BUILD_RUN_ID\`
- Matrix rows (rows 1-4 automatic, rows 5 and 9 BLOCKED_EXTERNAL): \`matrix.jsonl\`
- Run summary: \`hosted-live-summary.json\`
- FIFO fixture evidence: \`fifo-fixtures.json\`
- NODE_OPTIONS fuse state: \`node-options-fuse.json\`
- Interrupt checks for ADR-021/C10: \`interrupt-results.jsonl\`
- Cloud-account blockers and their unblock step: \`external-blockers.json\`
- Main/renderer samples: \`samples/\`
- DiagnosticReports .spin/.hang copies, if any: \`diagnostic-reports/\`
- DiagnosticReports consent/filter manifest: \`diagnostic-reports.json\`
- Evidence import manifest: \`M2-0008.evidence-import.json\`
- Owner-bug record summary: \`owner-bug-records.json\`
- Lead filing handoff: \`M2-0008.lead-action.md\`
EOF_HOSTED_README
  printf '[M2-0008] wrote content-free bundle: %s\n' "$OUT"
  [[ "$RESULT" == PASS ]] || fail "live run did not produce PASS evidence: $(live_failure_summary)"
  exit 0
fi

row_result=$(prompt_result "row-1-history-open" "Row 1: open History/Recall with FIFO meeting and .brain fixtures in place, wait for freeze/no-freeze evidence, then press return.")
sample_app "row-1-history-open"
record_row_result "row-1-history-open" "$row_result"

row_result=$(prompt_result "row-2-brain-status-blocked-brain" "Row 2: leave the blocked .brain/index.json fixture in place until the brainStatus poll should fire, then press return.")
sample_app "row-2-brain-status-blocked-brain"
record_row_result "row-2-brain-status-blocked-brain" "$row_result"

row_result=$(prompt_result "row-3-macos-activate" "Row 3: hide/island the app, activate the existing app from macOS, and record whether it reopens.")
sample_app "row-3-macos-activate"
record_row_result "row-3-macos-activate" "$row_result"

row_result=$(prompt_result "row-4-second-instance-reopen" "Row 4: launch a second instance/open request for the installed app and record whether the existing hidden/island layout reopens.")
sample_app "row-4-second-instance-reopen"
record_row_result "row-4-second-instance-reopen" "$row_result"

if [[ "$DRY_RUN" == 0 ]]; then
  stop_app
  launch_app "$IDLE_PROFILE"
fi
row_result=$(prompt_result "row-5-dataless-brain-idle" "Row 5: use the real evicted .brain/index.json fixture and do not open History; wait $MINUTES minute(s) from launch.")
idle_wait_seconds=$((MINUTES * 60))
if [[ "${M2_0008_CONTRACT_ALLOW_NON_DARWIN:-0}" == 1 && "${M2_0008_CONTRACT_IDLE_SECONDS:-}" =~ ^[0-9]+$ ]]; then
  idle_wait_seconds=$M2_0008_CONTRACT_IDLE_SECONDS
fi
[[ "$DRY_RUN" == 1 ]] || sleep "$idle_wait_seconds"
sample_app "row-5-dataless-brain-idle"
record_row_result "row-5-dataless-brain-idle" "$row_result" ',"fixture":"dataless-brain-index"'

row_result=$(prompt_result "row-9-network-off-flapping" "Row 9: with a real hydrating/dataless fixture, turn network off, then flap it on/off once; record whether the blocked read interrupts or remains pinned.")
sample_app "row-9-network-off-flapping"
record_row_result "row-9-network-off-flapping" "$row_result" ',"fixture":"dataless-meeting"'

interrupt=$(prompt_result "interrupt-network-off" "Interrupt test: while a kernel-blocked hydrating read is active, turn network off and record whether the read unwinds.")
record_interrupt_result "network-off" "$interrupt"
interrupt=$(prompt_result "interrupt-file-provider-cancel" "Interrupt test: cancel hydration in the File Provider UI and record whether the read unwinds.")
record_interrupt_result "file-provider-cancel" "$interrupt"
interrupt=$(prompt_result "interrupt-process-signal" "Interrupt test: signal the process only after samples are captured; record whether the blocked read unwinds before process exit.")
record_interrupt_result "process-signal" "$interrupt"

write_fixture_manifest
copy_diagnostic_reports "$STAMP"
RESULT=$(live_result)
write_evidence_records "$RESULT"
write_lead_action

cat > "$OUT/README.md" <<EOF_README
# M2-0008 Freeze Repro Bundle

- Artifact sha256: \`$ARTIFACT\`
- Build run id: \`$BUILD_RUN_ID\`
- Matrix rows: \`matrix.jsonl\`
- FIFO fixture evidence: \`fifo-fixtures.json\`
- NODE_OPTIONS fuse state: \`node-options-fuse.json\`
- Interrupt checks for ADR-021/C10: \`interrupt-results.jsonl\`
- Hosted/QA account blockers: \`external-blockers.json\`
- Main/renderer samples: \`samples/\`
- DiagnosticReports .spin/.hang copies, if any: \`diagnostic-reports/\`
- DiagnosticReports consent/filter manifest: \`diagnostic-reports.json\`
- Evidence import manifest: \`M2-0008.evidence-import.json\`
- Owner-bug record summary: \`owner-bug-records.json\`
- Lead filing handoff: \`M2-0008.lead-action.md\`
EOF_README

printf '[M2-0008] wrote content-free bundle: %s\n' "$OUT"
[[ "$RESULT" == PASS ]] || fail "live run did not produce PASS evidence: $(live_failure_summary)"
