# AskToto — Database Review (Gate 5: Data)

## Verdict: N/A — there is no database

AskToto is a **local Electron desktop app**. It has **no database** of any kind — no SQL (Postgres /
MySQL / SQLite), no NoSQL (Mongo / Redis), no ORM, no embedded KV store, no `electron-store`, and no
browser storage. Therefore the usual database gates (schema review, migrations, connection-string
secrets, least-privilege DB roles, row-level security, injection, backups, replication, PITR) are **not
applicable**.

This N/A is **justified by evidence**, not assumed:

| What I looked for | Command / check | Result |
|-------------------|-----------------|--------|
| SQL / NoSQL / ORM / KV libraries | `grep -rniE "sqlite|better-sqlite|postgres|\\bpg\\b|mysql|mongo|mongoose|redis|prisma|typeorm|sequelize|knex|leveldb|lowdb|electron-store|nedb|dexie" src` | **none found** |
| Browser persistence | `grep -rniE "localStorage|indexedDB|sessionStorage" src` | **none found** |
| Any persistence dependency in the manifest | reviewed `package.json` deps | none — deps are LLM SDKs (`@anthropic-ai/sdk`, `openai`, `@dust-tt/client`), `@azure/msal-node`, `@huggingface/transformers`, `zod`, React/Electron |

## The actual data layer = a flat **file store**, not a DB

Because there is no database, the "data layer" under review is a set of files. Documenting it here so the
Gate-5 matrix has a real data layer to point at.

| Store | Location | Format | Encryption | Code |
|-------|----------|--------|------------|------|
| Settings + profile PII + context docs | `userData/settings.json` | JSON, `ATKENC1`-marked | `safeStorage` (silent plaintext fallback) | `store.ts:104-184` |
| API keys (per provider) + Dust token | `userData/key-<provider>.bin` | encrypted blob | `safeStorage`, refuses plaintext | `store.ts:186-202` |
| Azure identity session | `userData/auth-session.bin` | encrypted JSON | `safeStorage` (plaintext fallback) | `auth.ts:101-131` |
| Meeting transcripts / notes | notes folder (`AskToto Meetings/`, default OneDrive) | Markdown + YAML frontmatter | **plaintext by default**, opt-in `ATKENC1` | `transcripts.ts:178-265` |
| Recall "index" | `index.md` in the notes folder | Markdown table | plaintext (skipped when encrypting) | `transcripts.ts:106-115,204-209` |
| Knowledge graph | `userData/graph/graph.json` + `graph.html` | JSON / HTML | none | `graphify.ts:59-67` |
| Org/managed policy | `userData/managed-config.json` + machine path | JSON | none (non-sensitive config) | `store.ts:78-98` |

`userData` resolves to `~/Library/Application Support/AskToto/` (macOS) /
`%APPDATA%/AskToto/` (Windows) — derived from `productName: AskToto` (`electron-builder.yml:2`,
`app.getPath('userData')` `store.ts:15`).

### "Query" surface and its integrity controls

The nearest thing to queries is `recall.ts` — `listMeetings()` / `searchMeetings()` do a linear scan +
keyword match over the markdown files (`recall.ts:51-88`). Relevant data-layer controls:

- **No injection surface** — there is no query language; search terms are lowercased and `String.includes`-matched (`recall.ts:60-80`). No `eval`, no dynamic SQL.
- **Path-traversal guard** — `recallOpen` constrains the target to the notes folder via `basename()` (`index.ts:648`), so a crafted `file` arg cannot escape the folder.
- **Atomic writes** — every persist uses write-temp-then-rename so a crash mid-write cannot corrupt the store or lose existing settings/transcripts (`store.ts:179-182`, `transcripts.ts:50-61`).
- **Schema validation** — all persisted settings are validated through `zod` (`BaseSettingsSchema`/`SettingsSchema`, `ipc.ts:149-227`); malformed keys are dropped, never written (`store.ts:44-65,162-184`). A corrupt `settings.json` can never brick the app (tolerant migration, `store.ts:142-160`).

### Performance / blocking note (carried from prior audit, still open)

All file-store reads/writes use **synchronous** `node:fs` on the main thread (`readFileSync`/
`writeFileSync`/`readdirSync` — `store.ts`, `transcripts.ts`, `recall.ts:23,69`). For a single-user
local app with a handful of small markdown files this is acceptable; with a large notes folder
`recallList`/`recallSearch` can briefly block the main process. Tracked as a MEDIUM under the
performance/reliability gate, not a data-protection issue.

## Database-specific gates

| Gate | Status | Justification |
|------|--------|---------------|
| DB schema / migration review | **N/A** | No database exists (grep evidence above) |
| Connection-string / DB-credential secrets | **N/A** | No DB → no connection string. App secrets (API keys) covered in `DATA_PROTECTION_REPORT.md` §2.1 |
| SQL/NoSQL injection | **N/A** | No query language; keyword `includes` scan only (`recall.ts:60-80`) |
| Least-privilege DB roles / RLS | **N/A** | No DB, no multi-tenant server; single local user |
| Backups / PITR / replication | **N/A** | No DB. The only replication is OneDrive sync of the plaintext notes folder — a confidentiality risk (Finding F1), not a DB-backup control |
| Data-layer integrity (atomicity, validation, traversal) | **PASS** | Atomic writes + `zod` validation + `basename` traversal guard (`store.ts:179-182`, `ipc.ts:149-227`, `index.ts:648`) |

**Conclusion:** Database review is **N/A (justified)**. The file-store data layer is well-structured for
integrity (atomic + validated + traversal-guarded); its open issues are confidentiality/retention, which
are tracked in `DATA_PROTECTION_REPORT.md` and `DATA_RETENTION_AND_DELETION.md`.
</content>
