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

Act 3 (setup) **always** provisions Parakeet + the Whisper floor. It does not skip, and it never says “models missing in this build” or “reinstall.” It calls `asrAssetsEnsure` / polls `asrAssetsStatus` (bundled `resources/` first, then `userData` fetch with a visible meter). Continue on Act 3 stays disabled until the four Parakeet files and the Whisper floor are actually present. A failed fetch stays on the row with Try again.

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
- Concurrency **2**. Decode (FFmpeg) may run two recordings at once. ASR (`transcribe`) is mutexed so Parakeet / the Whisper host stay single-threaded. A 90-minute file cannot occupy the only decoder slot while a five-minute file sits idle.
- PCM buffers are **per job**. The old shared `this.pcm` would mix two decodes.
- Hidden-window decoder fallback (no FFmpeg sidecar) stays one-at-a-time; the second job waits in `queued`.
- Overlay close, quit, and fail still recover from `userData/import-jobs`. Resume is unchanged: failed, no meeting file yet, replay from the durable cursor.

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
- N offered files produce N jobs. Resume still works. Concurrency 2 starts a second decode while the first is still active; a third stays queued.
- Layout/UX helpers for the queue (visible jobs, headline, picked-file list, drop filter).

## Out of scope

- Overlay 58 Hide / Island geometry. Bar orb. Brain 69 leftovers.
- Packing 1.8.2. Fetching the optional WebGPU large-v3-turbo tier (still Settings / MQA-247).
- Giving the renderer a general `readPath` API.
