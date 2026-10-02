# Program velocity re-forecast (M2-0197)

`scripts/program/velocity.mjs` reads a program ledger and its evidence records and computes the estimated hours
closed with evidence per day, the measured velocity, the remaining estimated hours per milestone, a forecast
completion date, and the D-14 degrade order. The ledger and records are inputs at run time only; nothing private is
committed here, and the tests use synthetic fixtures.

Run it from GitHub Actions with the `Program Velocity` workflow (`workflow_dispatch`, inputs `ledger_path`,
optional `records_path`, `gate`). It writes `FORECAST.md` and `forecast.json` to `out/program-velocity/` and uploads
them as the `program-velocity-forecast` artifact. Locally: `node scripts/program/velocity.mjs --ledger <path>
[--records <dir>] [--out-dir <dir>] [--gate m3] [--as-of YYYY-MM-DD]` (CI only, per D-28).

D-14 status is read from the ledger's `decisions` register. `ANSWERED_AS_DEFAULT` or `APPROVED` records the default
order as owner-approved; `OPEN` proceeds on the default order labelled ASSUMED (not a failure);
`ANSWERED_CHANGED` requires an owner-approved order in `degrade_orders.D-14`; a missing entry is a problem and the
tool exits 1. The default order is M2-0155, M2-0124, M2-0185, M2-0161, M2-0156. Degrading only lowers the evidence
level or ships DEFERRED flag-off; every traced ID stays in the ledger.

The m5 and m6 re-forecasts are acceptance lines of the T1 and T2 train tickets and use the same workflow with
`gate` set accordingly.

LEAD_ACTION: write the private m3 FORECAST.md from a `gate=m3` run of velocity.mjs over the private ledger (the `program-velocity-forecast` artifact), and record D-14 as approved per the owner autopilot directive of 2026-09-27
