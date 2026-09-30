# Cap1 Keys → existing Operator Worker (the owner fuse)
**When:** 20 Sep 2026 ~1:12pm ET  
**Tip with Keys UI:** `9568d21` on `implementation branch`<br>
**Target:** https://metis-operator.example.workers.dev (Worker name `metis-operator`)<br>
**NOT:** a second portal/Worker

**Status:** Historical — point-in-time deploy snapshot (20 Sep 2026), superseded by current Operator
deploy state; kept for lineage. The current procedure is [`../operator/RUNBOOKS.md`](../operator/RUNBOOKS.md) and
[`../runbooks/staging.md`](../runbooks/staging.md).

## Status
| Item | Value |
|------|-------|
| Live `/health` version | `2b26efa` (2026-09-14) |
| Branch tip | `9568d21` (Cap1 STAMP + Cap2) |
| Deploy wire | `node operator/scripts/deploy.mjs --env production` |
| Dry-run | OK — same URL, version stamp `9568d21c` |

## Action for Ultron/the owner
Run production deploy from Totos-Mac (wrangler auth) after Cap2 tip push if Keys UI must be live for feel. Cap2 deterministic path does not require Jev live.
