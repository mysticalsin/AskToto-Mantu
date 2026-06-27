# AskToto — Disaster Recovery Plan (Gate 12, part 2)

Scope: AskToto 0.1.0, local desktop app. A "disaster" here is **loss of the endpoint** (lost/stolen/wiped
machine, OS reinstall, disk failure) — not a datacenter or service outage, of which there are none.
Evidence = `file:line`.

Date: 2026-06-27.

---

## 1. Disaster scenarios & recovery

| Scenario | Impact | Recovery | RTO | RPO |
|----------|--------|----------|-----|-----|
| Lost / stolen laptop | App + local config gone; transcripts safe in OneDrive | New device → reinstall → re-enter keys → re-point notes folder | minutes–hours (device provisioning dominates) | **0** for notes synced to OneDrive; config reproducible |
| OS reinstall / disk failure | `userData/*` lost | Reinstall + re-enter keys; notes restored from OneDrive | minutes | 0 (notes) / N/A (config reproducible) |
| Corrupted `settings.json` | Settings unreadable | Auto fail-safe to defaults, no crash (`store.ts:114-127,142-160`) | seconds | last-saved sparse overrides may be lost; re-enter |
| Keychain reset (OS account change) | `.bin`/settings undecryptable | Falls back to defaults; re-enter keys/sign-in | minutes | config only |
| Notes folder deleted | Transcripts gone | OneDrive version history / recycle bin restore (`transcripts.ts:118-150`) | minutes | OneDrive recycle-bin retention window |
| Provider outage | Can't get answers | Switch provider in Settings (14 supported) or work manually | seconds | none (no data lost) |

## 2. Recovery building blocks (verified)

- **App is reproducible**: a clean install + key entry fully restores function; no per-machine state is
  irreplaceable (`store.ts`, `auth.ts`). The package contains only `out/**` + `package.json`
  (`electron-builder.yml:9-14`).
- **Notes are durable + portable**: open markdown in a synced/backed-up folder (`transcripts.ts`).
- **Fail-safe config**: every config-read path degrades to valid defaults rather than crashing
  (`getSettings` repair chain, `selftest.ts:30-66`).
- **Provider redundancy**: 14 provider ids across 3 protocols — a single provider outage is not a DR
  event for the user (`providers.ts:37-243`).

## 3. RTO / RPO summary

- **RPO (notes)**: ≈ OneDrive sync latency (near-real-time) when the notes folder is under OneDrive.
- **RPO (app config)**: effectively 0 — config is reproducible, not data to lose.
- **RTO**: dominated by device provisioning + reinstall; the AskToto-specific steps are minutes
  (install, paste key, point folder).

## 4. Findings

| Sev | Title | Evidence | Fix |
|-----|-------|----------|-----|
| MEDIUM | DR for notes depends on OneDrive being in use (Documents fallback has no backup) | `transcripts.ts:148` | Enforce a synced/backed-up notes folder via managed-config for managed users |
| LOW | No DR drill on record | n/a | Run the §1 lost-laptop recovery once on a managed device and attach evidence |

## 5. N/A (justified)

- **Multi-region failover / replication / RTO for infrastructure** — N/A: no infrastructure.
- **Database point-in-time recovery** — N/A: no database.
- **Failover load balancers / DNS cutover** — N/A: no service endpoints.

## 6. Gate 12 (DR) — **PASS (with conditions)**

A complete, verifiable recovery path exists for both the durable data (OneDrive restore) and the app
(reinstall + reproducible config), with RPO≈0 for synced notes. Infrastructure DR is correctly **N/A**.
Condition: enforce a backed-up notes location and run a one-time recovery drill (findings above).
