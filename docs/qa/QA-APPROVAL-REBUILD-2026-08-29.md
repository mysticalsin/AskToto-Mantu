# QA Approval — Métis Second-Brain Rebuild (Waves 0–6)

**Date:** 2026-08-29  
**Branch:** `cursor/wave-2-3-4-backend-52de`  
**PR:** https://github.com/mysticalsin/AskToto-Mantu/pull/42  
**Verdict:** **QA APPROVED** for merge to `main` pending human smoke of Listen → Recap → optional MCP on a signed build.

## Evidence

| Gate | Result |
|---|---|
| `tsc -p tsconfig.node.json` | PASS |
| `tsc -p tsconfig.web.json` | PASS |
| `npx vitest run` (full) | **3496 passed**, 18 skipped (declared) |
| `npm run check:bugs` | PASS — 266 FIXED pinned |
| `npm run check:skips` | PASS — linux baseline 18 with reasons |
| Scorecard doc | [`docs/qa/QUALITY-SCORECARD.md`](./QUALITY-SCORECARD.md) |
| Routing policy | [`docs/PROVIDER-ROUTING-POLICY.md`](../PROVIDER-ROUTING-POLICY.md) |
| Rebuild contracts | `scripts/qa/rebuild-waves.contract.test.ts` |

## P0 fixes landed in QA hardening pass

1. **SUMMARY → action items** — `## Next steps` / follow-ups alias into `parseRecapMarkdown` actionItems (Book next steps + wiki export).
2. **Confidential MCP** — Review hides/blocks CRM + task push when confidential; payload never claims confidential:false by accident on a confidential meeting.
3. **Failover chip** — session `lastFailover` on PublicSettings + dismissible App chip + `provider.failover` audit.
4. **check:skips** — linux baseline and reasons for platform-conditional skips.

## Residual (accepted for this approval)

- Physical CDP e2e (`scripts/qa/e2e-workflows.mjs`) still needs operator-run against a live app for routingMode / consolidation / MCP queue — covered by source contracts until then.
- `brain/context.test.ts` MQA-010 warm-cache assert can flake under parallel FS mtime races; original O(N) bug remains FIXED in ledger; not blocking.
- Intelligence workspace typecheck needs `intelligence/npm install` (not part of root CI).

## Sign-off

Automated QA: **APPROVED**  
Human smoke (Listen 5 min FR+EN, Stop → Review Next steps, confidential toggle blocks push, Routing mode Auto failover chip): **required before release tag**
