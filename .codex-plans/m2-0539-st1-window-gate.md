# M2-0539 ST-1 Window Gate Plan

## Checklist
- [x] Read AGENTS.md and attempted relay baton/vault session context
- [x] Query graphify first; slash command and wiki unavailable in this worktree
- [x] Read scope files and surrounding workflow
- [x] Pin behaviour tests for immediate per-pair warm-up rotation and CI evidence metadata
- [x] Update ST-1 launch plan/root-cause diagnostics
- [x] Run allowed TypeScript checks
- [x] Record review evidence

## Constraints
- No local repository tests or app/script execution except allowed tsc checks.
- No git write commands.
- Public repository only; no secrets, private paths, personal data, or private finding ids.

## Review
- Changed `windowConstructionPlan()` so each measured variant/chrome/repeat launch is immediately preceded by its matching marked warm-up.
- Kept the 250 ms shipped gate unchanged; warm-ups are still skipped by `windowConstructionGate()`.
- Added a behaviour test that fails against the old all-warmups-first order.
- Added root-cause metadata to the gate report from the ticket-provided CI evidence. Direct GitHub run lookup failed locally because `gh` could not reach `api.github.com`.
- Verification: `npx tsc --noEmit -p tsconfig.node.json` passed; `npx tsc --noEmit -p tsconfig.web.json` passed; `npx tsc --noEmit -p tsconfig.tests.json` reported five unrelated type errors, which meets the owner bar of no more than five.
