# AskToto — Data Flow & Egress

Single-user, local. Sensitive data: provider API keys, meeting transcripts/notes, profile PII
(resume/JD/notes), imported context docs, Azure identity, screenshots, live audio. The trust boundary
is the main process; the renderer never holds raw keys.

## Sensitive data: where it lives, how protected, where it flows

| Data | At rest | In transit (boundary cross) | Leaves device? |
|------|---------|-----------------------------|----------------|
| Provider API keys | `userData/key-<provider>.bin`, safeStorage-encrypted, `0o600` (`store.ts:186-202`) | Main only; used to construct SDK clients (`llm.ts:191,221`, `store.ts:226`) | No (key itself stays local; used as Authorization header by SDK over HTTPS) |
| Profile PII + context docs | inside `userData/settings.json`, `ATKENC1` whole-file encrypted (`store.ts:104,142-184`) | Main folds into system prompt (`personas.ts:9-39,62-82`) | **Yes** — embedded in prompt sent to the selected LLM provider |
| Live audio | RAM only (Float32 frames, bounded queue `MAX_QUEUE=24`) (`listen.ts:71,136-138`) | Renderer worker → text; audio never sent to main | No — transcribed **on-device** (Whisper); only text leaves |
| Transcript text | notes folder markdown, plaintext default / opt-in `ATKENC1` (`transcripts.ts:202,257`) | Main → LLM for suggest/summary/recap (`llm.ts:18-40`) | **Yes** to LLM provider; **and OneDrive sync** of the notes folder |
| Screenshot (Capture) | not persisted; base64 JPEG in RAM (`index.ts:450-476`) | Main → renderer → `ask:start` → vision model | **Yes** — image sent to vision-capable provider |
| Azure identity (email/name/tid) | `userData/auth-session.bin`, safeStorage-encrypted (`auth.ts:122-131`) | Attached to Dust message context for attribution (`llm.ts:79-98`) | **Yes (only to Dust)** — username/email/name in Dust agent context |
| Dust OAuth token | imported from OS keychain → `key-dust.bin` encrypted (`dustcli.ts`, `index.ts:432`) | Main → Dust API auth | No (bearer used over HTTPS) |
| Notes graph | `userData/graph/graph.json` + `graph.html` (`graphify.ts:59-67`) | python runner reads notes; extraction backend may call Claude/OpenAI | **Yes if** backend = API key (note text sent to LLM); No if `claude-cli` local |

## What leaves the device (egress map)

| Destination | What | Trigger | Evidence |
|-------------|------|---------|----------|
| Selected LLM provider (Anthropic / OpenAI-compatible / Dust) | prompt = question + profile + context docs + transcript/screenshot | `ask:start` / test key | `llm.ts`, `index.ts:534-555` |
| Hugging Face CDN | Whisper model download (q8), first Listen, **no subresource integrity** | first Listen | `whisper.worker.ts:2,19` |
| Microsoft Entra (`login.microsoftonline.com`) | OAuth PKCE (only if SSO configured) | sign-in | `auth.ts:167,199-220` |
| Dust API (`dust.tt` / `eu.dust.tt`) | agent conversation + user identity context | dust provider ask | `llm.ts:127-144` |
| Update host | update check (HTTPS); currently `REPLACE-WITH...` placeholder → skipped | launch | `electron-builder.yml:67-69`, `updater.ts:13-20` |
| OneDrive | passive cloud sync of the notes folder (and the repo `.env`) | OS sync | `transcripts.ts:118-150`, `.env:1-3` |

Local-only (never leaves device): live audio frames, screenshots after send, the encrypted
`userData/*.bin` files, the loopback HTTP server (`127.0.0.1`, ephemeral), the `security`/`osascript`/
`powershell` child outputs.

## Trust-boundary crossings (renderer → main)

1. Renderer calls `window.toto.*` → preload `ipcRenderer.invoke` → `ipcMain.handle`.
2. Main runs `assertMainWindow(e)` (top frame only) then `requireAuth()` for privileged ops.
3. zod validates the payload; main performs the privileged action and returns a sanitized result
   (e.g. `PublicSettings` strips keys).
4. Main → renderer events (`stream:delta/done/error`, `meeting:detected`, `hotkey`) are one-way.

## Notable data-handling posture

- Keys never serialized to renderer; only `hasKeys` booleans (`index.ts:118-126`).
- Encryption-at-rest is opt-in for transcripts (off by default so Dust/recall/graph can read them);
  on means `index.md` and graph auto-rebuild are skipped to avoid plaintext leakage (`transcripts.ts:204`, `graphify.ts:237`).
- Profile PII only added to prompt in `interview`/`sales` modes (`personas.ts:80`).
- Prompt size caps: profile 24 KB, context docs 40 KB, transcript slices 6–16 KB (`personas.ts:19,27`, `llm.ts:22-34`).
- `.env` lives in a OneDrive-synced repo → gitignore does NOT stop cloud sync (documented risk; only empty NVIDIA key present).
