#!/usr/bin/env bash
# W0-HERMETIC (M2-0190) §2 — runs one command under the owner-account OS sandbox profile
# (scripts/hermetic/owner-account.sb). `-D HOME=$HOME` is what makes `(param "HOME")` inside that
# profile resolve to this machine's real home directory, so the profile file itself stays
# machine-independent.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: run-under-owner-sandbox.sh <command> [args...]" >&2
  exit 2
fi

# Owner admission is held independently of the selected profile, including legacy and cleanup routes.
# Hosted synthetic proofs remain available; they do not qualify this route for personal-device use.
if [ "${OWNER_SANDBOX_ROUTE:-}" = owner ]; then
  echo 'owner-runner sandbox: owner route disabled: architectural isolation hold' >&2
  exit 2
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "${OWNER_SANDBOX_PROFILE:-owner-account.sb}" = owner-account.sb ]; then
  exec sandbox-exec -f "$HERE/owner-account.sb" -D HOME="$HOME" "$@"
fi

fail() { echo "owner-runner sandbox: $*" >&2; exit 2; }
[ "${OWNER_SANDBOX_PROFILE:-}" = owner-runner.sb ] || fail 'unsupported profile'
[ "$(/usr/bin/uname -s)" = Darwin ] || fail 'strict mode requires macOS'
unset OWNER_SANDBOX_ENTERED OWNER_SANDBOX_ENTERED_PROFILE OWNER_SANDBOX_PROFILE_SHA256 OWNER_SANDBOX_CANARY OWNER_SANDBOX_TEMP OWNER_SANDBOX_JOB_ROOT QA_TMP
canonical() {
  local input="$1" physical
  case "$input" in /*) ;; *) fail 'roots must be absolute';; esac
  case "$input" in *$'\n'*|*$'\r'*|*$'\t'*) fail 'control characters in root';; esac
  [ -d "$input" ] && [ ! -L "$input" ] || fail 'root must be an existing real directory'
  physical="$(cd "$input" && pwd -P)" || fail 'root cannot be resolved'
  [ "$input" = "$physical" ] || fail 'root must already be canonical, with no symlink or dot components'
  printf '%s\n' "$physical"
}
overlap() { [ "$1" = "$2" ] || [[ "$1" == "$2/"* ]] || [[ "$2" == "$1/"* ]]; }
home="$(canonical "${HOME:-}")"
workspace="$(canonical "${GITHUB_WORKSPACE:-}")"
runner_temp="$(canonical "${RUNNER_TEMP:-}")"
trusted="$(canonical "$HERE")"
[ "$workspace" = "$(cd "$HERE/../.." && pwd -P)" ] || fail 'workspace must be the physical checkout containing this wrapper'
[ "$(/usr/bin/stat -f %u "$runner_temp")" = "$(/usr/bin/id -u)" ] || fail 'temp root must belong to this runner'
[ "$home" != / ] && [ "$workspace" != / ] && [ "$runner_temp" != / ] || fail 'root-wide paths refused'
[[ "$home" != "$workspace" && "$home" != "$workspace/"* ]] || fail 'workspace contains home'
[[ "$home" != "$runner_temp" && "$home" != "$runner_temp/"* ]] || fail 'temp contains home'
overlap "$workspace" "$runner_temp" && fail 'workspace and temp must be disjoint'
for suffix in '.ssh' '.aws' '.gnupg' '.config' '.netrc' '.claude' '.codex' '.wrangler' \
  Documents Desktop Downloads Pictures Movies Music AI-Brain-build \
  Library/CloudStorage Library/Keychains Library/Preferences/.wrangler Library/Mail Library/Messages Library/Safari Library/Cookies \
  'Library/Application Support/Metis' 'Library/Application Support/Metis Light' 'Library/Application Support/TotoWhisper' \
  'Library/Application Support/Métis' 'Library/Application Support/AskToto' \
  'Library/Application Support/asktoto' 'Library/Application Support/asktoto-dev'; do
  overlap "$workspace" "$home/$suffix" && fail 'workspace overlaps protected state'
  overlap "$runner_temp" "$home/$suffix" && fail 'temp overlaps protected state'
done
[ "${GITHUB_ACTIONS:-}" = true ] || fail 'strict mode requires GitHub Actions'
case "${OWNER_SANDBOX_ROUTE:-}" in
  owner)
    [ "${RUNNER_ENVIRONMENT:-}" = self-hosted ] || fail 'owner route requires a self-hosted runner'
    case "${GITHUB_JOB:-}" in st1-mac-fifo|st1-mac-control) ;; *) fail 'unapproved owner job';; esac
    account_home=$(/usr/bin/dscl /Search -read "/Users/$(/usr/bin/id -un)" NFSHomeDirectory) || fail 'account home query failed'
    account_home="${account_home#NFSHomeDirectory: }"
    [ "$home" = "$(canonical "$account_home")" ] || fail 'HOME differs from the OS account home'
    ;;
  hosted-fixture)
    [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] || fail 'fixtures require a GitHub-hosted runner'
    ;;
  *) fail 'explicit owner or hosted-fixture route required';;
esac
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] || fail 'invalid run identity'
[[ "${GITHUB_JOB:-}" =~ ^[A-Za-z0-9_-]+$ ]] || fail 'invalid job identity'
job_root="$runner_temp/metis-owner-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-$GITHUB_JOB"
umask 077
if [ ! -e "$job_root" ]; then /bin/mkdir "$job_root"; fi
[ "$(canonical "$job_root")" = "$job_root" ] || fail 'job root redirected'
[ "$(/usr/bin/stat -f %u "$job_root")" = "$(/usr/bin/id -u)" ] || fail 'job root owner mismatch'
[ "$(/usr/bin/stat -f %Lp "$job_root")" = 700 ] || fail 'job root mode mismatch'

phase=candidate
control="${OWNER_QA_CONTROL_DIR:-}"
if [ "$1" = --cleanup-owned-temp ]; then
  [ "$#" = 1 ] || fail 'cleanup accepts no target or forwarded command'
  phase=cleanup
  qa_tmp="$job_root"
  canary="$job_root/unused-cleanup-canary"
  control="$job_root/unused-cleanup-control"
  set -- /bin/rm -rf -- "$job_root"
else
  qa_tmp=$(/usr/bin/mktemp -d "$job_root/invocation.XXXXXXXX")
  canary="$qa_tmp/.sandbox-canary"
  printf 'owned canary\n' > "$canary"
  /bin/cat "$canary" > /dev/null
  printf 'baseline write\n' >> "$canary"
  if [ -n "$control" ]; then
    [ "$(canonical "$control")" = "$control" ] || fail 'control directory redirected'
    [[ "$control" == "$job_root/"* && "$control" != "$qa_tmp/"* ]] || fail 'control directory outside this job'
  else
    control="$qa_tmp/.unused-control"
  fi
  export OWNER_SANDBOX_ENTERED=1 OWNER_SANDBOX_ENTERED_PROFILE=owner-runner.sb
  profile_sha256=$(/usr/bin/shasum -a 256 "$HERE/owner-runner.sb")
  export OWNER_SANDBOX_PROFILE_SHA256="${profile_sha256%% *}"
  export OWNER_SANDBOX_CANARY="$canary" OWNER_SANDBOX_TEMP="$qa_tmp"
  export OWNER_SANDBOX_JOB_ROOT="$job_root"
fi

# Renaming an allowed ancestor must not relocate a denied subtree out of the policy.
ancestors='^('
for protected in "$home" "$trusted" "$control" "$job_root"; do
  [ "$phase" != cleanup ] || [ "$protected" != "$job_root" ] || protected="$(/usr/bin/dirname "$job_root")"
  [ "$phase" != cleanup ] || [ "$protected" != "$control" ] || continue
  while [ -n "$protected" ]; do
    escaped=$(printf '%s' "$protected" | /usr/bin/sed 's/[][\\.^$*+?(){}|]/\\&/g')
    ancestors="$ancestors$escaped|"
    [ "$protected" = / ] && break
    protected="$(/usr/bin/dirname "$protected")"
  done
done
ancestors="${ancestors%|})$"
export TMPDIR="$qa_tmp"
exec /usr/bin/sandbox-exec -f "$HERE/owner-runner.sb" \
  -D HOME="$home" -D WORKSPACE="$workspace" -D QA_TMP="$qa_tmp" \
  -D TRUSTED_CODE="$trusted" -D CONTROL="$control" -D CANARY="$canary" \
  -D ANCESTORS="$ancestors" -D PHASE="$phase" "$@"
