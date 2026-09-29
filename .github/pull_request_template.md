## Ticket

- Program ticket: `M2-____` (or `fix/…` hotfix)
- Kit references satisfied: <!-- e.g. TASK-027, UC-014, OBU-02 -->
- Review findings closed: <!-- e.g. B2-F1, L01-F3 -->
- Evidence record: attach the private evidence artifact or link in the internal tracker
- Implementer model: <!-- e.g. claude-sonnet-5 -->
- Reviewing model: <!-- the validator; its session must differ from the implementer's -->

## Refactor classification

Select exactly one. Mixed refactor PRs are rejected; send the pure move first, then the behaviour change.

- [ ] Pure move
- [ ] Behaviour change

## What changed and why

<!-- One paragraph. Link the ticket in the internal tracker. -->

## Evidence

| Check | Command | Result |
|---|---|---|
| Type-check (local, executes no repo code) | `npx tsc --noEmit -p tsconfig.node.json` / `tsconfig.web.json` | |
| Tests (CI only, owner decision D-28) | red run URL (fixes: the new test failing before the fix) → green run URL on the head commit | |
| Other (packaged launch, measurement, screenshot) | | |

Evidence levels recorded: <!-- any of DESIGNED, LOCALLY_TESTED, HOST_CONFIGURED, LIVE_VERIFIED, ACCEPTED, MEASURED; a set, not a ladder -->

Not run (and why): <!-- list anything skipped; never omit -->

## Evidence record

<!--
  Once Build & Test is green on the head commit, the validator adds the record here as one fenced
  code block whose info string is json evidence (fields: evidence/SCHEMA.md in the program
  repository). The Evidence check verifies it against this PR's head commit and the named runs. A
  new push makes it stale; replace it. The same record is then appended unchanged to the record
  file above.
-->

## Validation

- [ ] Failing test written first (bugs) and kept; its failing run is the record's `repro`
- [ ] No secrets, account IDs, personal emails or meeting content in code, logs or this PR
- [ ] No mocks, stubs or placeholder receipts in production paths
- [ ] Evidence record added and the Evidence check is green; Opus validation recorded in the ticket (the reviewer's session is not the implementer's)
- [ ] `_relay/HANDOFF.md` updated in the private program repository
