# AskToto — Data Protection / Privacy-by-Design Report (Gate 5: Data)

Reviewer: senior data-protection / privacy-by-design engineer.
Scope: AskToto, a **local Electron desktop app** (macOS + Windows). Single user, no server, no
backend, no multi-tenant cloud. The trust boundary is the Electron **main process**; the renderer is
sandboxed (`contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true` —
`src/main/index.ts:155-162`).

All claims below are grounded in `file:line` and in real command output captured during this review
(`grep`, `npm audit`, file reads). Where I could not verify, I mark UNKNOWN. I do not invent endpoints
or data.

---

## 1. Data classification

| # | Data asset | Sensitivity | Where it lives at rest | Protected at rest? | Evidence |
|---|------------|-------------|------------------------|--------------------|----------|
| D1 | Provider API keys (incl. Dust OAuth token) | **Secret** | `userData/key-<provider>.bin` (one file per provider) | **Yes** — `safeStorage.encryptString`, file mode `0o600`; **hard-refuses** to save if encryption unavailable | `store.ts:186-202`, `dustcli`→`index.ts:432` |
| D2 | Settings + **profile PII** (name/role/company/resume/JD/notes) + imported **context docs** (≤25 × 120 KB/mode) | **High (PII / client material)** | `userData/settings.json`, whole-file `ATKENC1`-marked, encrypted via `safeStorage` | **Partial** — encrypted when keychain available; **silently falls back to plaintext** otherwise | `store.ts:104,129-184`; schema `ipc.ts:78-86,193-199` |
| D3 | Azure (Entra) identity — email, name, tenant id, domain | **PII / identity** | `userData/auth-session.bin`, `safeStorage`-encrypted, mode `0o600` | **Partial** — encrypted when available; falls back to plaintext `Buffer` | `auth.ts:101-131` |
| D4 | Meeting **transcripts** + AI notes (full conversation content) | **High (often client-confidential)** | Notes folder markdown (default OneDrive `AskToto Meetings/`, else `~/Documents`) | **Default: NO (plaintext)**; optional `ATKENC1` encryption (`encryptTranscripts`) | `transcripts.ts:38-62,178-265`; default `ipc.ts:188`, `ipc.ts:264` |
| D5 | Derived **knowledge graph** (concepts/titles/snippets from transcripts) | **High (derived from D4)** | `userData/graph/graph.json` + `graph.html` | **NO** — never encrypted | `graphify.ts:59-67` |
| D6 | Live **audio** frames | **High (transient)** | RAM only (bounded queue), never written to disk | N/A (not persisted) | `whisper.worker.ts`, `DATA_FLOW.md:13` |
| D7 | **Screenshots** (Capture / vision) | **High (transient)** | RAM only (base64 JPEG), not persisted | N/A (not persisted) | `index.ts:450-476` |
| D8 | Managed / org policy config | Low (config, no secrets) | `userData/managed-config.json` + machine `/Library/Application Support/AskToto/…` | n/a (non-sensitive) | `store.ts:78-98`, `auth.ts:39-44` |

No database, no `localStorage`/`IndexedDB`/`sessionStorage`/`electron-store` is used anywhere (verified:
`grep -rniE "localStorage|indexedDB|sessionStorage|electron-store" src` → **none found**). The data
layer is a flat **file store under `userData`** plus the markdown notes folder. See `DATABASE_REVIEW.md`.

---

## 2. At-rest protection — verification

### 2.1 API keys (D1) — PASS
- Encrypted with OS keychain (`safeStorage.encryptString`), written `0o600`, and the code **refuses to
  persist a key when encryption is unavailable** rather than silently writing plaintext (`store.ts:195-201`).
- Read path is main-process-only (`getApiKey`, `store.ts:295-306`). A legacy `plain:` prefix is still
  *read* for migration but is never *written* by current code.

### 2.2 Settings + profile PII + context docs (D2) — PASS-with-gap
- Whole-file encryption with an `ATKENC1\n` marker (`store.ts:104,114-140`), atomic write `0o600`
  (`store.ts:179-182`). Plaintext legacy files are read and upgraded on next write.
- **Gap (Finding F3):** `serializeUserRaw` silently writes **plaintext** JSON when
  `safeStorage.isEncryptionAvailable()` is false (`store.ts:130-140`). Unlike API keys, PII (resume,
  job description, notes) and imported client documents can land on disk unencrypted with no user
  signal. `hasEncryption` is surfaced to the UI (`index.ts:122`, `ipc.ts:233`) but nothing blocks the
  write.

### 2.3 Azure identity (D3) — PASS-with-gap
- `safeStorage`-encrypted, `0o600` (`auth.ts:122-131`); same silent plaintext fallback as D2
  (`auth.ts:126`). Lower volume (one email/name), folded into Finding F3.

### 2.4 Transcripts (D4) — FAIL (default posture for sensitive data)
- `encryptTranscripts` defaults to **false** (`ipc.ts:188`, `ipc.ts:264`); the default save location is
  the **OneDrive-synced** `AskToto Meetings/` folder (`transcripts.ts:146-150`, `detectOneDrive`
  `transcripts.ts:118-143`). So by default, full meeting transcripts (which for this app are typically
  client conversations) are written **plaintext** and **replicated to Microsoft cloud**. See Finding F1.
- When encryption *is* enabled it is sound: `ATKENC1` + `safeStorage`, atomic `0o600`, and the
  plaintext `index.md` row + graph auto-rebuild are deliberately skipped to avoid leaking titles
  (`transcripts.ts:204-209,259-263`, `graphify.ts:237`).
- **Plaintext temp leak (Finding F2):** opening an *encrypted* transcript calls `decryptToTemp`, which
  writes a **decrypted plaintext** copy into the OS temp dir with **no `0o600` mode and no cleanup**,
  under a predictable filename (`transcripts.ts:64-69`, invoked `index.ts:650`). This silently defeats
  the at-rest encryption for any transcript the user opens.

### 2.5 Derived graph (D5) — FAIL (residual sensitive data)
- `graph.json`/`graph.html` hold transcript-derived titles, concepts and snippets and are **never
  encrypted** (`graphify.ts:59-67`). `scheduleRebuild` skips rebuilds when `encryptTranscripts` is on
  (`graphify.ts:237`), but a graph built earlier from plaintext notes **is not purged** when the user
  later enables encryption or deletes the source notes. See Finding F4 and `DATA_RETENTION_AND_DELETION.md`.

---

## 3. Keys never reach the renderer — PASS (verified)

- The renderer only ever receives `PublicSettings`, whose key-related fields are **booleans only**:
  `hasApiKey`, `hasKeys: Record<string,boolean>`, `hasEncryption` (`ipc.ts:230-239`). Raw key material
  is never part of the type.
- `publicSettings()` constructs exactly those booleans via `hasApiKey`/`hasKeysMap`/`encryptionAvailable`
  (`index.ts:110-127`).
- `getApiKey` / `safeStorage` decrypt are **main-process only** (verified
  `grep -rn "getApiKey\|safeStorage\|decryptString" src` → all hits in `src/main/*`; **zero** in
  `src/renderer` or `src/preload`).
- Renderer flow is **write-only**: `state.ts` calls `setApiKey`/`clearApiKey`/`testApiKey` and then
  re-reads booleans via `refresh()` (`state.ts:175-191`). The key text the user types is sent to main
  and never read back (UI shows `•••••• saved` from the boolean — `Settings.tsx:462,483`).

**Conclusion:** keys do not cross the trust boundary to the renderer. ✅

---

## 4. What leaves the device (egress)

| Destination | Payload | Trigger | Evidence |
|-------------|---------|---------|----------|
| Selected LLM provider (Anthropic SDK / OpenAI-compatible / Dust) over HTTPS | prompt = question + **profile PII** (interview/sales only) + **context docs** + **transcript** slices (suggest/summary/recap) + **screenshot** (vision) | `ask:start` | `llm.ts:16-77,183-263`, `personas.ts:62-82`, `index.ts:534-555` |
| Provider endpoints (13 base URLs) | API key as bearer; request body | every call / test key | `providers.ts` (`api.openai.com`, `dust.tt`, `integrate.api.nvidia.com`, `openrouter.ai`, `api.groq.com`, … — full list in providers.ts) |
| Dust (`dust.tt`/`eu.dust.tt`) | conversation + **user identity context** (username/email/name/timezone) | Dust provider ask | `llm.ts:79-98,136-144` |
| Hugging Face CDN | Whisper `Xenova/whisper-tiny` model, **no subresource integrity** | first Listen | `whisper.worker.ts:2,5,19` (`env.allowLocalModels=false`) |
| Microsoft Entra (`login.microsoftonline.com`) | OAuth PKCE (public client, no secret) | sign-in, only if SSO configured | `auth.ts:163-220` |
| **OneDrive** | passive cloud sync of the **plaintext notes folder** (and the gitignored `.env`) | OS sync | `transcripts.ts:118-150`; `.env:1-3` |
| graphify extraction backend | note text → Claude/OpenAI **if** backend uses a stored API key; **local only** if `claude-cli` | graph build | `graphify.ts:144-154,207-215` |

Audio transcription is **on-device** (Whisper in a renderer worker); raw audio never reaches the main
process or the network — only the resulting text is later sent to an LLM when the user asks
(`whisper.worker.ts`, `DATA_FLOW.md:13,31`). This is a strong privacy-by-design choice. ✅

Privacy-by-design positives also include: profile PII injected **only** in `interview`/`sales` modes
(`personas.ts:80`); prompt-size caps (profile 24 KB, context 40 KB, transcript 6–16 KB —
`personas.ts:19,30`, `llm.ts:22-34`); content-protection (window hidden from screen capture) on by
default (`index.ts:167`, `ipc.ts:272`).

---

## 5. Secret-leak scan — PASS

| Check | Command | Result |
|-------|---------|--------|
| Secrets baked into build output | `grep -rnoE "(sk-ant-…|nvapi-…|sk-or-…|gsk_…|fw_…|tgp_v1_…|sk-[A-Za-z0-9]{20,})" out` | **No matches** |
| Sensitive data in logs | `grep -rniE "console\.[a-z]+\(.*(key|token|secret|password|apikey|email|profile|resume|transcript)" src` | **No matches** |
| All `console.*` in main/preload | `grep -rn "console\." src/main src/preload` | 6 hits — shortcuts/startup warnings + `[store] ignoring locked setting` + `[display-media]` metadata. **None log keys/PII/transcript content** |
| `.env` live secrets | `awk -F= '{print $1"="length($2)}' .env` | `NVIDIA_API_KEY=0 chars` (empty); only model-name overrides have values. No live secrets present |

**Minor (Finding F6):** `console.log('[display-media]', {...})` runs on **every** Listen grant in
production and logs request origins/frame URLs/booleans (`index.ts:720-730`). No secret or content, but
it is noisy debug output that should be gated behind a debug flag.

Supply-chain note (adjacent to Gate 5, owned by the supply-chain gate): `npm audit --omit=dev` reports
**9 advisories (5 high, 4 moderate)**, all transitive under `@dust-tt/client` (`express`, `qs`,
`path-to-regexp`, `ajv`, `body-parser`, `@modelcontextprotocol/sdk`). These are DoS/ReDoS and
MCP-server issues in code paths AskToto (an HTTP *client*, not a server) does not exercise; the MCP
"cross-client data leak" advisory requires running an MCP server, which AskToto does not. No direct
AskToto data-exposure path was identified, but the Dust dependency should be upgraded. (Full dev-tree
audit: 27 advisories, the rest in `electron-builder`/`node-gyp` build tooling.)

---

## 6. Findings (severity-ranked)

| ID | Sev | Title | File:line | Fix |
|----|-----|-------|-----------|-----|
| F1 | **HIGH** | Meeting transcripts stored **plaintext by default** and saved to the **OneDrive-synced** folder by default — client-confidential conversation content sits unencrypted on disk and is replicated to Microsoft cloud | `ipc.ts:188,264`; `transcripts.ts:146-150,257` | Default `encryptTranscripts: true` for sensitive-data deployments, or let `managed-config.json` force it; warn on first save that the folder cloud-syncs; cover in a DPIA |
| F2 | **MEDIUM** | `decryptToTemp` writes a **decrypted plaintext** copy of an encrypted transcript to the OS temp dir with no `0o600` and **no cleanup**, defeating at-rest encryption for opened transcripts | `transcripts.ts:64-69`; `index.ts:650` | Write `0o600`; unlink on app quit (or open via an in-memory viewer); randomize the filename |
| F3 | **MEDIUM** | Settings (profile PII + imported context docs) and `auth-session` **silently fall back to plaintext** when `safeStorage` is unavailable — unlike API keys, which hard-refuse | `store.ts:130-140`; `auth.ts:126` | Block persistence of PII fields when `hasEncryption` is false, or require explicit user opt-in; surface the downgrade in the UI |
| F4 | **MEDIUM** | Derived knowledge graph (`graph.json`/`graph.html`) is never encrypted and is **not purged** when source notes are deleted or when encryption is enabled — residual sensitive data + incomplete deletion | `graphify.ts:59-67,237` | Purge `userData/graph/*` when `encryptTranscripts` is turned on and when source notes are deleted; or store the graph encrypted |
| F5 | **LOW** | No retention policy / no purge ("delete all my data") action; uninstall leaves `userData` + notes folder | (absence) — see `DATA_RETENTION_AND_DELETION.md` | Add a "Delete all AskToto data" action; document retention |
| F6 | **LOW** | Production `[display-media]` debug log on every Listen grant | `index.ts:720-730` | Gate behind `if (process.env.ASKTOTO_DEBUG)` |

Verified-good controls (PASS evidence): API-key encryption + hard-refuse (`store.ts:195-201`), keys
never reach renderer (§3), atomic writes prevent data-loss/corruption (`store.ts:179-182`,
`transcripts.ts:50-61`), on-device audio transcription (`whisper.worker.ts`), no secrets in
build/logs (§5).

---

## 7. Gate 5 (Data) — status summary

| Sub-gate | Status | One-line evidence |
|----------|--------|-------------------|
| API keys encrypted at rest | **PASS** | `safeStorage` + `0o600`, refuses plaintext (`store.ts:195-201`) |
| Keys never reach renderer | **PASS** | `PublicSettings` exposes only `hasKeys`/`hasApiKey` booleans; `getApiKey` main-only (`ipc.ts:231-239`, grep clean) |
| Settings/PII encrypted at rest | **PASS-with-gap** | `ATKENC1` encrypted when keychain available, but silent plaintext fallback (`store.ts:130-140`) → F3 |
| Transcripts encrypted at rest by default | **FAIL** | Default plaintext + OneDrive-synced (`ipc.ts:188`, `transcripts.ts:146-150`) → F1 |
| Encrypted-transcript handling | **FAIL** | `decryptToTemp` leaks plaintext to temp, no cleanup (`transcripts.ts:64-69`) → F2 |
| Secret-leak scan (repo/build/logs) | **PASS** | No key-shaped strings in `out/`; no sensitive `console.*`; `.env` empty |
| Egress documented & controlled | **PASS-with-gap** | Egress mapped (§4); Whisper CDN has no SRI (known) |
| Database review | **N/A** | No DB; flat-file store under `userData` (`DATABASE_REVIEW.md`) |
| Data retention & deletion | **FAIL** | No purge; deletion doesn't cascade to graph/temp; uninstall leaves data (`DATA_RETENTION_AND_DELETION.md`) → F4/F5 |

**Gate 5 overall: FAIL** — blocked on F1 (default-plaintext, cloud-synced sensitive transcripts) and the
deletion-completeness gaps (F2/F4). For a *single-user dev/personal* build the residual risk is lower;
for "production with client-confidential data" these must be remediated or formally risk-accepted in a
DPIA before release.
</content>
</invoke>
