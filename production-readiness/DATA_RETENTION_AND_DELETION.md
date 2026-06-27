# AskToto — Data Retention & Deletion (Gate 5: Data)

Scope: local single-user desktop app, no server, no central database. "Retention" here means *what
persists on the user's machine (and OneDrive) and for how long*, and "deletion" means *what the user can
actually erase, and what is left behind*.

## 1. Retention model: none (manual, user-controlled)

There is **no automated retention** and **no expiry / TTL** anywhere. Data persists indefinitely until
the user deletes the underlying files. This is appropriate for a personal local tool, but it must be a
**conscious, documented** choice for a sensitive-data deployment — there is currently no retention
policy, no auto-purge of old transcripts, and no max-age setting (verified: no `retention`/`ttl`/`expire`
/`maxAge` logic in `src/main`).

| Asset | Lifetime | What ages it out | Evidence |
|-------|----------|------------------|----------|
| Meeting transcripts / notes | **Forever** until user deletes the `.md` file | nothing automatic | `transcripts.ts:178-265` |
| `index.md` recall table | grows forever (append-only), plaintext | nothing | `transcripts.ts:106-115` |
| Knowledge graph (`graph.json`/`graph.html`) | rebuilt on save; otherwise persists | rebuild overwrites; never auto-deleted | `graphify.ts:59-67,193-226` |
| API keys / Dust token | until user clears or replaces | `clearApiKey` | `store.ts:204-207` |
| Azure session | until sign-out or domain change | `signOut`; `authStatus` drops a session whose domain no longer matches config | `auth.ts:137,247-254` |
| Settings + profile PII + context docs | forever until edited/cleared | user edits | `store.ts:162-184` |
| Transient (audio frames, screenshots) | RAM only; gone on send/GC | n/a | `index.ts:450-476`, `whisper.worker.ts` |

## 2. Deletion: what works, and what is left behind

### 2.1 Deletion paths that work (PASS)
- **API key / Dust token:** `clearApiKey` removes `key-<provider>.bin` via `rmSync`, and an empty
  Save also clears it (`store.ts:188-207`). ✅
- **Azure session / sign-out:** `signOut` deletes `auth-session.bin` and clears the in-memory session
  (`auth.ts:247-254`). ✅
- **Transcript / note:** the user deletes the markdown file directly in Finder/Explorer (the app opens
  the folder via `path:open`, `index.ts:632-635`). The primary copy is removed. ✅ (manual)

### 2.2 Deletion gaps — data left behind (FAIL: not complete/verifiable)

1. **Derived graph is not purged (Finding F4).** Deleting a transcript `.md` removes the source, but the
   concepts/titles/snippets extracted from it remain in `userData/graph/graph.json` and the rendered
   `graph.html` until the next *full* rebuild — and rebuilds are *skipped entirely* once
   `encryptTranscripts` is enabled (`graphify.ts:237`). A graph built from earlier plaintext notes
   therefore survives both source deletion and the switch to encryption. No code deletes
   `userData/graph/*`.
   *Fix:* on source-note deletion and on enabling encryption, purge `userData/graph/*`.

2. **Plaintext temp copies are never cleaned up (Finding F2).** Opening an encrypted transcript writes a
   decrypted plaintext copy to the OS temp dir (`asktoto-<name>.md`) that is **never deleted** and is not
   `0o600` (`transcripts.ts:64-69`). These accumulate and outlive the "encrypted" transcript.
   *Fix:* unlink on quit; write `0o600`.

3. **`index.md` is append-only.** Titles + dates of every note remain in the plaintext recall index even
   after the underlying transcript file is deleted (`transcripts.ts:106-115`) — metadata residue.
   *Fix:* rewrite the index from the surviving files, or drop the index in favor of `recall.ts`'s live scan.

4. **No "delete all my data" action (Finding F5).** There is no in-app purge / right-to-erasure command.
   A user wanting to wipe everything must manually delete the notes folder **and** `userData`
   (`settings.json`, `key-*.bin`, `auth-session.bin`, `graph/`, `managed-config.json`) **and** OS temp
   copies — across two locations. Easy to miss the `userData` derived data.

5. **Uninstall leaves data.** Electron/electron-builder uninstall removes the app bundle but **not**
   `userData` and **not** the notes folder (no uninstall hook in `electron-builder.yml`). Transcripts,
   the graph, and the encrypted settings persist after uninstall.

6. **OneDrive replication outlives local deletion.** Because the default notes folder is OneDrive-synced
   (`transcripts.ts:146-150`), deleting a transcript locally also propagates to OneDrive, but prior
   versions can persist in OneDrive **version history / recycle bin** server-side — outside the app's
   control. This is a property of the chosen storage location (Finding F1) and should be called out to
   users / in the DPIA.

## 3. Recommendations (privacy-by-design)

1. Add a **"Delete all AskToto data"** action that removes the notes folder (with confirmation), all
   `userData` files (`settings.json`, `key-*.bin`, `auth-session.bin`, `graph/`), and temp copies.
2. **Cascade deletion:** when a note is deleted or encryption is enabled, purge `userData/graph/*` and
   reconcile `index.md`.
3. Make **`decryptToTemp`** write `0o600` and unlink on app quit (or render decrypted in-memory).
4. Add an optional **retention setting** (e.g. auto-delete transcripts older than N days) for
   sensitive-data deployments, plus a managed-config override so IT can enforce it.
5. Document retention/deletion (and the OneDrive version-history caveat) in a user-facing privacy note
   and the DPIA; consider defaulting `encryptTranscripts` true so cloud-synced copies are ciphertext.

## 4. Gate status

| Gate | Status | Evidence |
|------|--------|----------|
| Automated retention policy exists | **FAIL** | No TTL/expiry/retention logic anywhere in `src/main` |
| Manual deletion of primary data works | **PASS** | `clearApiKey` (`store.ts:204-207`), `signOut` (`auth.ts:247-254`), user deletes `.md` files |
| Deletion is complete (no orphaned derived/temp data) | **FAIL** | Graph (`graphify.ts:59-67,237`), temp copies (`transcripts.ts:64-69`), `index.md` (`transcripts.ts:106-115`) survive |
| Purge / right-to-erasure command | **FAIL** | No in-app "delete all" action exists |
| Uninstall data cleanup | **FAIL** | No uninstall hook; `userData` + notes folder remain |
| OneDrive replication accounted for | **UNKNOWN** | Local deletes propagate, but server-side version history is outside app control (`transcripts.ts:146-150`) |

**Retention & deletion overall: FAIL** for a sensitive-data production release — primarily the missing
purge/erasure path and the orphaned derived (`graph/`) + temp plaintext data. Acceptable for a personal
single-user build only with the gaps explicitly risk-accepted.
</content>
