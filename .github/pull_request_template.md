## Ticket

- Program ticket: `M2-____` (or `fix/…` hotfix)
- Kit references satisfied: <!-- e.g. TASK-027, UC-014, OBU-02 -->
- Review findings closed: <!-- e.g. B2-F1, L01-F3 -->

## What changed and why

<!-- One paragraph. Link the ticket (docs/metis-2.0/ledger/tickets/M2-####.md in the private program repository). -->

## Evidence

| Check | Command | Result |
|---|---|---|
| Type-check (local, executes no repo code) | `npx tsc --noEmit -p tsconfig.node.json` / `tsconfig.web.json` | |
| Tests (CI only, owner decision D-28) | red run URL → green run URL | |
| Other (packaged launch, measurement, screenshot) | | |

Evidence level reached: <!-- DESIGNED / LOCALLY_TESTED / HOST_CONFIGURED / LIVE_VERIFIED / MEASURED -->

Not run (and why): <!-- list anything skipped; never omit -->

## Validation

- [ ] Failing test written first (bugs) and kept
- [ ] No secrets, account IDs, personal emails or meeting content in code, logs or this PR
- [ ] No mocks, stubs or placeholder receipts in production paths
- [ ] Opus validation recorded in the ticket (reviewer is not the author)
- [ ] `_relay/HANDOFF.md` updated in the private program repository
