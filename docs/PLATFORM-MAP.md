# Platform & dispatch map

One repository ships three distinct products. This is the single place that answers "where do I fix X,
and how does the fix reach users?" so a change is easy to locate and easy to dispatch.

There is **no per-OS fork of the Electron source** — Windows and macOS share `src/**` and differ only by
runtime checks and per-platform packaging overlays. The Swift app under `native-app/` is a separate
product with its own distribution.

---

## 1. Métis for Windows — Electron `.exe`

- **Build config:** `electron-builder.win.yml` (extends `electron-builder.yml`).
- **Artifacts:** NSIS installer `Metis-Setup-<v>.exe`, `Metis-Portable-<v>.exe`, and APPX (Store, built
  into `release-appx/`).
- **Windows-only code / resources:** `src/main/win-security.ts` (managed-config ACL trust), DPAPI-backed
  keystore, the PowerShell foreground watcher, `resources/llama/win`, and the win `sharp`/sherpa native
  packages. Runtime branch points use `isWindows` / `process.platform === 'win32'`.
- **Build scripts (`package.json`):** `dist:win`, `release:build:win`, `predist:win`, `installers:win`.
- **Dispatch / auto-update:** `release/latest.yml` → `electron-updater` (NSIS). Portable + APPX/Store do
  not auto-update via this feed.

## 2. Métis for macOS — Electron `.dmg`

- **Build config:** `electron-builder.yml` (mac section). Universal (arm64 + x64), with V8 bytecode
  **OFF** for the universal build (`ASKTOTO_MAC_UNIVERSAL=1`; see BUG-LEDGER MQA-207 / MQA-240).
- **macOS-only code / resources:** `native/mac-helper/` (the shipped Swift sidecar: `watch-frontmost`,
  `ocr`, `transcribe`) → `resources/mac-helper`; `resources/llama/mac`; ScreenCaptureKit loopback +
  Apple Speech paths. Runtime branch points use `process.platform === 'darwin'`.
- **Build scripts:** `dist`, `dist:local`, `release:build:mac`, `release:mas` (Mac App Store),
  `installers:mac`.
- **Dispatch / auto-update:** `release/latest-mac.yml` (`.zip` / `.dmg`) → `electron-updater`. MAS uses
  the App Store, not this feed.

## 3. Métis Native for macOS — Swift / SwiftUI

- **Location:** `native-app/` — `App/` (SwiftUI shell) + `MetisKit/` (Swift package with the tested
  logic). Separate product, `appId com.mantu.metis.native`; Apple Intelligence (Foundation Models), App
  Intents, SwiftData. **Not** an Electron conversion.
- **Build / test:** `xcodegen generate` (`native-app/project.yml`) → Xcode; the core builds and tests via
  `swift build` / `swift test` (runs on Linux/CI too, since Apple-only frameworks are `canImport`-guarded).
- **Dispatch / auto-update:** App Store — deliberately **not** `latest-mac.yml` / `electron-updater`.

## Shared across the Electron products

`src/main` (the trust boundary), `src/preload`, `src/renderer`, `src/shared`. Platform differences are
runtime checks, never separate source trees. Orthogonal services that are **not** part of any app build:
`intelligence/` (dashboard bundle), `cloudflare-proxy/` (the Worker), `license-server/` (standalone Node
service).

---

## How a fix gets dispatched

### Electron (Windows + macOS DMG, released together)

```mermaid
flowchart LR
  bump["Bump package.json version"] --> tag["Tag v&lt;version&gt;"]
  tag --> ci[".github/workflows/release.yml: build + sign mac and win"]
  ci --> verify["check-update-metadata.mjs: asset set + latest*.yml SHA/size parity"]
  verify --> publish["Publish to mysticalsin/Metis-Releases (mirrored to Forgejo via scripts/push-both.sh)"]
  publish --> feed["Installed apps poll latest.yml / latest-mac.yml"]
```

- The public **update feed** is the `mysticalsin/Metis-Releases` GitHub repo (the "update folder"), not a
  tracked `release/` directory — `release/` is gitignored build output.
- Enterprise fleets can point at a private generic feed via managed-config `updateFeedUrl`.

### Native macOS (Swift)

Separate App Store submission from `native-app/`. Does not use the `Metis-Releases` feeds.

---

## Quick "where do I fix it?" index

- Windows-only bug → `electron-builder.win.yml`, `src/main/win-security.ts`, win branches in `src/main/**`.
- macOS(Electron)-only bug → `electron-builder.yml` mac section, `native/mac-helper/**`, darwin branches.
- Cross-platform Electron bug → `src/main/**`, `src/renderer/**`, `src/shared/**`.
- Saved meetings → `src/main/transcripts.ts` owns writes/encryption and draft lifecycle;
  `src/main/features/meetings/transcript-format.ts` owns the pure display projection;
  `src/main/features/meetings/meeting-document.ts` owns frontmatter and recap-section boundaries;
  `src/main/recall.ts` owns typed History reads and edits.
- Incremental record canonicalization → `src/main/infra/storage/incremental-record-canonical.ts`
  owns canonical bytes, record limits and identity digests.
- Incremental record canonicalization coverage → `src/main/infra/storage/incremental-record-canonical.test.ts`
  owns canonicalization regression cases.
- Incremental record receipt custody → `src/main/infra/storage/incremental-record-receipt.ts`
  owns the shared receipt authority used by the speech host and meeting persistence.
- Recording imports → `src/main/import-retention-policy.ts` resolves trusted retention policy;
  `src/main/import-job-retention-coordinator.ts` owns bounded checkpoint inventory, explicit Resume, and
  owner-bound checkpoint writes; `src/main/import-job-store.ts` owns encrypted checkpoints and content-free
  hold markers; `src/main/import-job-pipelines.ts` owns VAD consumption and save/recap finalization.
- Optional speech models → `src/main/features/components/index.ts` (public service API),
  `src/main/features/components/speech-pack/**` (pinned transfer, activation and readiness),
  `src/main/infra/process/speech-pack-host.ts` (owned utility process), and
  `src/main/speech-pack-bootstrap.ts` (desktop lifecycle). The package-owned
  `build/speech-pack-profile.json` keeps the shipping full profile until a lean package is qualified.
- Live cloud speech in the desktop renderer → `src/renderer/src/App.tsx` owns the selected live-speech settings
  and consent UI; `src/renderer/src/lib/cloud-speech-consent.ts` validates the explicit disclosure decision, and
  `src/renderer/src/lib/cloud-speech-listen.ts` binds the controller to Listen lifecycle callbacks. The Listen
  hook in `src/renderer/src/lib/listen.ts` owns capture admission, stop/drain and transcript application;
  `listen-audio-channels.ts` owns acquired streams and audio graph setup/teardown, while
  `listen-audio-recovery.ts` owns recovery policy and fails broker capture closed when a track cannot be
  safely reattached. `listen-startup-policy.ts` owns the cached Operator Listen gate and effective engine
  selection; `cloud-speech-startup.ts` validates live broker capability/readiness and bounds startup events.
- Live cloud speech in main → `speech-desktop-bootstrap.ts` composes the registered runtime, fresh authority
  boundaries and revocation; `speech-desktop-boundary.ts` provides the actual Electron/store adapters.
  `settings-observation.ts` publishes memory snapshots without reading files; `speech-bootstrap-state.ts`
  owns metadata freshness and publication checks. `auth.ts` owns opaque speech authorization leases,
  backed by its private configuration, bounded boundary readers and lease controller. Repeated speech
  authority checks use these memory snapshots; explicit boundaries refresh the trusted files and policy.
  Cloud capture handlers, renewal and finishing ownership live under `src/main/ipc/cloud-speech-*.ts`.
- ASR asset IPC → `src/main/ipc/asr-assets-ipc.ts`, `src/main/ipc/parakeet-assets-ipc.ts`, and
  `src/main/ipc/speech-pack-ipc.ts`; ASR status wire types live in `src/shared/asr-assets.ts` and are
  re-exported by `src/shared/ipc.ts`. Metadata-only probes use `src/main/asr-metadata-readiness.ts`.
- Saved meetings → `src/main/transcripts.ts` owns writes/encryption and draft lifecycle;
  `src/main/features/meetings/transcript-format.ts` owns the pure display projection;
  `src/main/features/meetings/meeting-document.ts` owns frontmatter and recap-section boundaries;
  `src/main/recall.ts` owns typed History reads and edits.
  Exact final speech provenance is owned by `features/meetings/speech-provenance.ts`
  (finite injected budgets and framed association), `meeting-speech.ts` (main-owned
  configuration/public projection), and `meeting-save-document.ts` (pure saved document).
  The legacy parser remains in `features/meetings/legacy-transcript.ts`; public history,
  export and brain inputs project private records out while internal edits and Open retain them.
  Brain field display gates live in `brain/publish-provenance.ts`, called by `brain/publish.ts`.

- Settings panel bug → section code in `src/renderer/src/features/settings/**`, shared primitives in
  `src/renderer/src/ui/**`, and the compatibility export at `src/renderer/src/components/Settings.tsx`.
- Native macOS app → `native-app/App/**` (UI) or `native-app/MetisKit/**` (logic).
- "How does it ship" → bump version + tag; CI publishes to `Metis-Releases`; clients poll `latest*.yml`.
