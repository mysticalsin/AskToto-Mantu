# AskToto — Backup & Restore Report (Gate 12, part 1)

Scope: AskToto 0.1.0 stores everything as **local files** — there is **no database** and **no server** to
back up. Backup responsibility is split between the user's cloud-sync (OneDrive) for the notes, and
**reproducibility from reinstall** for app config. Evidence = `file:line`.

Date: 2026-06-27.

---

## 1. What state exists, and its backup story

| State | Location | Backup mechanism | Restorable? |
|-------|----------|------------------|:---:|
| Meeting transcripts / notes | notes folder (default OneDrive `AskToto Meetings/`) | **OneDrive version history + cloud copy** | **Yes** — OneDrive restore / version history |
| Settings + profile PII + context docs | `userData/settings.json` (encrypted, OS-account-bound) | none automated (reproducible) | Re-enter in-app; **not** portable across machines |
| Provider API keys | `userData/key-<provider>.bin` (encrypted, OS-account-bound) | none (intentional) | Re-enter; **not** portable |
| Azure session | `userData/auth-session.bin` (encrypted) | none (intentional) | Re-sign-in |
| Notes knowledge graph | `userData/graph/*` | none (derived) | Rebuild from notes (`graphify:rebuild`) |
| The app binary | install location | reinstall from artifact | Yes — DEPLOYMENT_RUNBOOK |

## 2. Why secrets/config are deliberately NOT backed up

safeStorage encryption is keyed to the OS user/keychain (`store.ts:186-202`, `auth.ts:113-127`). The
`.bin`/`settings.json` files **cannot be decrypted on another machine or account** — restoring them
elsewhere fails *safe* (falls back to defaults, never bricks: `store.ts:114-127,142-160`, proven by
`selftest.ts` cases 1-2). So copying them into a backup adds risk (encrypted blobs that won't restore)
with no benefit. The correct "restore" for config is **reinstall + re-enter the key** (seconds of work).

## 3. Data integrity controls (verified)

- **Atomic writes** for settings and transcripts: write to `*.tmp` then `rename` — a crash mid-write
  cannot corrupt the live file (`store.ts:177-182`, `transcripts.ts:50-61`).
- **Collision-safe** transcript filenames (same-minute meetings get distinct files), verified by
  `selftest.ts:79-83`.
- **Self-documenting** notes folder: `README.md` + `index.md` auto-created (`transcripts.ts:91-103`),
  verified `selftest.ts:81-82`.
- Encrypted transcripts carry the `ATKENC1` marker and decrypt transparently on read
  (`transcripts.ts:17-26`).

## 4. Restore procedures

### 4.1 Restore notes (primary data)
1. OneDrive → restore folder/version history for `AskToto Meetings/` (or any synced location).
2. Point AskToto at the folder (Settings → folder) if needed (`transcripts.ts:146-150`).
3. `recall:list/search` re-index automatically from the markdown (`recall.ts:51-87`); rebuild graph if used.

### 4.2 Restore the app + config on a new/wiped machine
1. Reinstall the artifact (DEPLOYMENT_RUNBOOK).
2. Re-enter provider key(s) (Settings → Your AI).
3. Re-sign-in to Entra if SSO is enforced.
4. Point at the OneDrive notes folder → history is back.

## 5. Findings

| Sev | Title | Evidence | Fix |
|-----|-------|----------|-----|
| MEDIUM | Notes backup depends on the user having OneDrive (or another sync/backup) | `transcripts.ts:148` falls back to `Documents` with **no backup** | Document that a non-synced notes folder has no backup; recommend a synced or backed-up location |
| LOW | No restore *drill* evidence (cannot exercise OneDrive restore in this environment) | n/a | Perform a documented restore drill on a managed device and attach results |
| INFO | Plaintext-default notes are backed up *and* exposed in OneDrive | `transcripts.ts:202,257` | See PRIVACY_REVIEW HIGH finding (encrypt vs readability trade-off) |

## 6. Gate 12 (Backup/Restore) — **PASS (with conditions)**

The primary data (notes) has a real, verifiable backup/version mechanism via OneDrive; the app and its
config are **reproducible from reinstall**; writes are atomic and collision-safe (verified). There is no
DB to back up (**N/A**). Conditions: (a) the notes folder must live in a synced/backed-up location
(MEDIUM finding), and (b) a restore drill should be run on a managed endpoint to convert the LOW item to
evidence. See DISASTER_RECOVERY_PLAN for RTO/RPO.
