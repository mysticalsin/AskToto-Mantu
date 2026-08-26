#!/usr/bin/env bash
# Push the same refspecs to GitHub AND Forgejo in one command.
#
# The Forgejo push-mirror force-syncs GitHub and deletes any ref Forgejo does
# not hold, so a ref pushed to only one remote is a ref scheduled for deletion.
# Usage: bash scripts/push-both.sh <refspec> [<refspec>...]   e.g. main, v1.6.7
set -u
[ $# -ge 1 ] || { echo "usage: bash scripts/push-both.sh <refspec> [...]" >&2; exit 2; }
fail=0
for remote in github origin; do
  if git push "$remote" "$@"; then
    echo "OK   $remote: $*"
  else
    echo "FAIL $remote: $* — retry this remote before the next mirror sync (8h)" >&2
    fail=1
  fi
done
exit $fail
