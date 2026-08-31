# Import meetings and ASR assets

Date: 2026-08-31

Status: **Active.** Overlay Hide / Island / Bar orb stay frozen. Do not pack a 1.8.2 DMG/EXE in this slice.

This is the design for two coupled product failures: Tony cannot import audio in a runnable Métis because Parakeet weights are missing, and he can only hand the app one meeting at a time.

## Outcome

1. A runnable Métis always has the Parakeet payload and the Whisper floor used by import. `npm run dev` provisions them when they are absent. Pack scripts already fetch; they **hard-fail** if `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, or `tokens.txt` (or the Whisper floor) are missing after fetch. If a packaged app is somehow incomplete, runtime **auto-fetches into `userData`** with visible progress. The user is **never** told to reinstall Métis for missing ASR weights.
2. Several meetings import in one gesture. Native picker uses `multiSelections`. Drop several files in one go. Each file is its own durable `ImportJob`. All start, run with a concurrency cap of 2 (so one huge file cannot hold the decoder slot forever), survive overlay close, and resume after fail or quit. The UI is a quiet queue: name, progress, resume, cancel, done.
3. Renderer still never receives raw paths as a general filesystem read. Tokens or main-owned jobs only. 500 MB cap per file. Magic sniff stays.

## Default engine and first-run download (Tony, 2026-08-31)

Parakeet is the **default** live ASR engine (`asrEngine: 'parakeet'` in `DEFAULT_SETTINGS` and the Zod schema). Whisper and Apple stay available in Settings.

The settings file is a **sparse overlay**. A profile that never wrote `asrEngine` inherits the new default (existing users who never touched ASR migrate to Parakeet). A profile that explicitly chose `whisper` or `apple` keeps that key — do not clobber a deliberate choice.

Onboarding **always** provisions Parakeet + the Whisper floor, starting the moment the exclusive stage mounts (not only Act 3). It does not skip, and it never says “models missing in this build” or “reinstall.” It calls `asrAssetsEnsure` / polls `asrAssetsStatus` (bundled `resources/` first, then `userData` fetch with a visible meter). Continue on Act 3, Skip’s Get started, and Ready’s Get started stay disabled until the four Parakeet files and the Whisper floor are actually present. `finish()` will not write `onboardingDone` while they are missing. A failed fetch stays on the row with Try again.

`asrBundled` still means “the installer/repo `resources/` manifest is complete” (Listen’s `asr-model://` offline gate). Onboarding does **not** use that flag as a skip.

READY TO MERGE stays **no** until Devon Mac-shows a real multi-file import with models present.

## Why the current path fails

`resources/asr/` is empty in git (`.gitkeep` only). `npm run fetch-models` (~700 MB) is wired as `predist` / `prepack`, never as `npm run dev`. `ensureParakeetModel` throws `Bundled Parakeet model assets are missing. Reinstall Métis from a complete installer.` when the four files are absent. Packaged extraResources already map `resources/asr` → `asr` and `resources/models` → `models`; the pack path is fine if fetch actually ran.

The picker is `properties: ['openFile']` only. One token, one file. `ImportJobManager` already has start / resume / cancel / list / remove, but it runs one decoder at a time and the Recall view starts a single job.

## ASR assets

### Dev

`npm run dev` runs `scripts/ensure-asr-assets.mjs` first. If the four Parakeet files and the Whisper-base floor are already on disk under `resources/`, it exits immediately. Otherwise it runs `fetch-models.mjs` (idempotent).

### Pack

`fetch-models.mjs` already extracts Parakeet and then hashes via `check-runtime-assets.mjs`. This slice adds an explicit **hard fail** that names the four required Parakeet files (and the Whisper floor ONNX pair) if any are missing after fetch. Do not ship an installer that can throw the old reinstall string for a packaging miss.

### Runtime

`src/main/asr-bundled-ensure.ts` is the only downloader.

- **Bundled first.** Packaged: `process.resourcesPath/{asr,models}`. Dev: repo `resources/`.
- **userData fallback.** `app.getPath('userData')/asr-models/…` when bundled files are missing (read-only installers, incomplete copy).
- **Fetch once, share in-flight.** Progress is 0–100 and is pushed to the Recall queue (`import-assets:progress`).
- **Honest errors.** Connection / disk / verify failures say so. Never “reinstall from a complete installer.”
- **Parakeet** downloads the reviewed sherpa-onnx `.tar.bz2` and extracts (system `tar` on macOS/Linux). **Whisper floor** downloads the reviewed Xenova/whisper-base files the import host already knows how to load from `fetchedModelsPath`.

`ensureParakeetModel` calls this module. Import’s Whisper path calls it before the utilityProcess host is asked to load. App ready starts a background ensure so the first import is not the first download.

Live Listen’s `asr-model://` protocol keeps serving bundled files. If a bundled path 404s, it may also look under the userData ASR root for the same relative `models/…` or `ort/…` object. Still no path traversal.

## Multi-meeting import

### Intake

- Native dialog: `properties: ['openFile', 'multiSelections']`. Same filters. Same 500 MB cap **per file**. Oversized files are skipped with a clear line; the rest still start.
- Drop: Recall’s import surface accepts several files. Preload calls `webUtils.getPathForFile` and immediately exchanges paths for tokens via `import-audio:offer`. The renderer API is `importAudioDrop(File[])` — it never sees a path string.
- Each accepted file gets its own single-use token. `consumePickedAudio` still re-stats and `sniffMediaFile()`s before the job is created.

### Jobs

- N files → N `ImportJob`s. `startMany` creates them all, persists them, then pumps.
- **Decode slot = 1.** FFmpeg and the hidden-window fallback are singletons (`Another audio decoder is already active.`). The slot is released the moment the decoder process/window exits, then `pump()` starts the next decode **before** recap. Job A may transcribe or recap while Job B decodes. ASR stays mutexed. Recap never occupies the decode slot. Fail/cancel reap the slot and pump.
- Concurrency **2** is wrong: two decodes cannot run. A 90-minute recap must not hold the next file at `queued`.
- PCM buffers are **per job**. The old shared `this.pcm` would mix two decodes.
- Hidden-window decoder still throws if a live Listen session is active (`listeningActive`) or another decoder window is up.
- Overlay close, quit, and fail still recover from `userData/import-jobs`. Resume is unchanged: failed, no meeting file yet, replay from the durable cursor.

### Recap (background, one LLM call)

- Save the transcript as soon as ASR finishes. Recap is one background call at the **summary/base** tier (not think/reasoning). Do not run sequential polish batches of 8 with a 120s idle before the summary.
- Polish, if a test wires it, is fail-open **after** recap. Import wiring skips polish (it cannot be cheap).
- Apple-grade recap: decisions, owners, next steps. Stable cached system prefix (`IMPORT_RECAP_SYSTEM_PREFIX`: no `Date.now`). Transcript is the variable suffix. Anthropic `cache_control` ttl `1h`; OpenAI `prompt_cache_key` + system breakpoint.
- Prefer a connected API. Local only when `redactSensitive` or no API/CLI candidate. Keep a trailing-stream recap if `>= 200` chars. Max 3 attempts. “Summary needs attention” is not success when a provider exists.
- Recap must not block the next decode. Import idle may start **one** Intelligence index pass (not a BrainView mount timer). See `docs/design/INTELLIGENCE-UPDATE.md`.

### UI

Recall, not overlay chrome. One accent, small type, glass cards.

- Button: **Import meetings**. Tooltip says several recordings keep processing in the background.
- Quiet drop hint. Dragging over the list highlights the same surface (no second page).
- Queue of every non-cancelled job, including **done** (dismiss to hide). Each row: title, honest progress (`describeImportProgress`), Resume / Cancel / Dismiss as today.
- Headline: “Importing 3 meetings” / “2 of 3 ready”. Failed rows stay visible with Resume.
- Asset fetch, when it happens, is a single quiet card above the queue: “Getting transcription files…” plus a meter. Not a modal. Not a reinstall dialog.

## Tests (required)

- Missing ASR in a fake `resourcesPath` no longer produces the reinstall string; `ensure` fetches or copies into userData and progress fires.
- Picker options include `multiSelections`.
- N offered files produce N jobs. Resume still works. Decode slot 1: the second decode starts only after the first decoder is released; recap of A does not block decode of B.
- Layout/UX helpers for the queue (visible jobs, headline, picked-file list, drop filter).

## Out of scope

- Overlay 58 Hide / Island geometry. Bar orb. Brain 69 leftovers.
- Packing 1.8.2. Fetching the optional WebGPU large-v3-turbo tier (still Settings / MQA-247).
- Giving the renderer a general `readPath` API.
