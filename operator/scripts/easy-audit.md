# Easy audit: plan 3.7b law 1, "two clicks from anywhere"

Checklist QA fills in during each P1 section review, against the live preview (or staging) for
that section. A flow passes when it takes at most two clicks (plus one confirm dialog for a
destructive action) from any page, with no page hunt.

Columns:
- **Starting page**: where Tony is when the flow starts (should not matter; note if it does).
- **Clicks**: literal click count from the starting page to the completed action, before the
  once-string or confirmation appears. A keyboard shortcut that opens the same target counts as
  zero clicks for that step.
- **Keystrokes**: any typing required (duration picks, search text, pasted values). "None" if the
  flow is pure pointing.
- **Verdict**: PASS / FAIL / N/A (not built yet), with a one-line reason on FAIL.

| # | Flow | Starting page | Clicks | Keystrokes | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | Generate a license | | | | |
| 2 | Revoke a license | | | | |
| 3 | Approve a seat | | | | |
| 4 | Add a key | | | | |
| 5 | Rotate a key | | | | |
| 6 | Add a connector | | | | |
| 7 | Test a connector | | | | |
| 8 | Find a seat (by name, email or device id) | | | | |
| 9 | Open a seat drawer | | | | |
| 10 | Change theme (light / dark / system) | | | | |

## Notes

- Run this against the section's preview HTML (`operator/scripts/preview.mjs`) or a headed local
  demo (`npm run dev:operator` + `operator/scripts/dev-session.mjs`), never against a mockup.
- `⌘K` / `Ctrl K` should reach every seat, license last4, group and connector by name (plan 3.7b
  law 1). If a flow only works by scrolling a nav list, that is a FAIL even if the click count is
  low.
- A FAIL here blocks the section from going to Tony (lock 13): send it back to the owning dev with
  the row filled in as the finding.
