# Métis full physical QA ledger

**Date:** 2026-07-14

## Test boundary

Physical testing uses the final packaged Apple Silicon macOS app with synthetic data and isolated profiles. The current corrected DMG, ZIP, and app are under `/private/tmp/metis-release-brain-auto-20260714-mac`; Windows x64 Setup and Portable EXEs are under `/private/tmp/metis-release-brain-auto-20260714-win`. They pass payload, ASAR extraction, architecture, and runtime checks, but there is no Windows device or runner available for native execution. Provider-authenticated paths and OS permission approval are intentionally not performed with real credentials or captured user content.

## Workflow matrix

| ID | Workflow | Test method | Status |
| --- | --- | --- | --- |
| WF-01 | First launch and onboarding | Clean-profile packaged-app UI at `/private/tmp/Metis-QA-Onboarding-20260714.app`: consent, all onboarding pages, **Decide later**, and **Get started** | Passed |
| WF-02 | Overlay window, keyboard controls, minimize, restore, quit | Final packaged app: main bar, Spotlight Ref, Interview mode, minimize/pill/expand, hide invocation, quit/relaunch | Passed |
| WF-03 | Settings persistence and privacy controls | Final packaged app: mode persisted as Interview after relaunch; Privacy and AI tabs; About shows `Métis 1.0.2 · Mantu` | Passed |
| WF-04 | Offline audio import and transcription | Final packaged app native picker selected `en.wav`; UI showed `Transcribing`, then `Summary needs attention` and saved transcript; smoke import also passed | Passed |
| WF-05 | Saved meeting, history, recall, and recovery | Synthetic six-line meeting opened from History with transcript; imported meeting produced a recoverable summary notice and Open action | Passed |
| WF-06 | Métis Local text routing, summary, vision, warm restart, and brain extraction | AI tab showed bundled Qwen3.5 0.8B and enabled local features; model hashes and packaged warm-suggest proof passed; clean-profile Index extraction completed locally with `ok: true` | Passed |
| WF-07 | Mantu Intelligence, manual indexing, automatic backlog, read views, and guarded backfill | Manual Index completed one saved meeting; a separate clean profile opened Mantu Intelligence without pressing Index and automatically completed the backlog; dashboard showed the resulting meeting and intelligence | Passed |
| WF-08 | Permissions, capture, error states, and safe recovery | Privacy statuses inspected without accepting OS prompts; screen capture showed the safe notice together with provider error; Spotlight Ref recovery path verified | Passed |
| WF-09 | Windows installer and portable payload | Final Setup and Portable EXEs passed post-sign runtime checks, ASAR extraction, exact platform inventory, and SHA-256 capture | Passed structurally; native Windows execution external |

## Findings

| ID | Severity | Reproduction | Root cause | Fix | Status |
| --- | --- | --- | --- | --- | --- |
| QA-001 | High | In an offline, Local-only profile, click **Index meetings** with saved meetings present. The command returned without a visible result and queued zero meetings. | Backfill intentionally rejects Local-only extraction but returned only `{ queued: 0 }`; both UI entry points ignored that result. | Return `deferred: 'no-provider'` and show a direct setup explanation in History and the in-app Intelligence view. | Fixed and physically verified: History and Mantu Intelligence showed the explicit no-provider setup guard. |
| QA-002 | High | On the normal bar without a configured Dust agent, the Spotlight Ref control was absent. | `Bar.tsx` rendered the control only when `spotlightReady` was true, making the feature undiscoverable for the default profile. | Keep the control visible and use a setup-aware label; the existing click path explains how to connect Dust. | Fixed and physically verified on the final app: `Spotlight Ref · Connect Dust in Settings` is present and clickable. |
| QA-003 | Medium | Clicking the unavailable Spotlight Ref path said to pick an agent even though Settings marks that agent as managed/read-only. | The unavailable-agent copy described a user-selectable agent that cannot be selected in this build. | Replace it with the managed-agent reconnect message pointing to Settings → AI. | Fixed and physically verified: `The Spotlight Ref agent is managed. Connect or reconnect Dust in Settings → AI to the workspace that has it.` |
| QA-004 | Medium | Capture could show a provider fallback error while hiding the capture notice that explains the answer is context-only. | The `Answer` error branch rendered the provider error but omitted the already-built `notice` node. | Render the notice in the error branch before the provider error. | Fixed and physically verified: the final app showed `Couldn’t capture your screen. Answering from context only.` together with the missing-provider error. |
| QA-005 | Low | About displayed `Métis 1.0.0 · Mantu` while the package version was 1.0.2. | The footer contained a hard-coded version literal. | Read the version from the root package metadata and add a contract test. | Fixed and physically verified: final app displayed `Métis 1.0.2 · Mantu`. |
| QA-006 | High | A Windows build could leave Darwin Sherpa entries marked `unpacked` in `app.asar` after `afterPack` removed the foreign files. | The child config's target-specific file override fell back to a broad source selection, so the ASAR header and unpacked tree diverged. | Add an explicit Windows allowlist, exclude foreign Sherpa before ASAR creation, and fail the runtime check on any dangling unpacked reference. | Fixed; fresh Windows package passes post-sign runtime check and `asar extract OK true`. |
| QA-007 | High | The same Windows configuration pulled ignored worktrees, video files, and local model caches into `app.asar`, producing an approximately 9.7 GB unusable package. | The target-specific file override did not preserve the base allowlist. | Add complete allowlists to both the Windows child and macOS target config. | Fixed; final app.asar is 61 MB, resources are approximately 1.7 GB, and final DMG/ZIP/EXE artifacts are approximately 1.3 GB each. |
| QA-008 | Medium | A normal completed llama-server archive response could fail after the bytes were written with `Cannot read properties of null (reading 'setTimeout')`. | The downloader cleared an idle timer through `IncomingMessage.setTimeout(0)` after Node had detached the response socket. | Remove the post-pipeline socket call and add a completed-response regression test. | Fixed; `scripts/fetch-llama-server.test.ts` passes all 3 tests and both platform sidecars provision/check cleanly. |
| QA-009 | High | In a clean Local-only profile, click **Index meetings** or open Mantu Intelligence with a saved meeting. The sidecar ran, but the meeting initially remained absent or failed in `.brain/index.json`. | Brain backfill only considered credentialed cloud/CLI providers, and the automatic dashboard trigger was not wired to the saved-meeting/index count. | Route brain extraction to the bundled local model when opted in, use the structured summary path with a larger output budget, trigger backlog processing from both Intelligence entry points, and expose progress/retry state in the UI. | Fixed and physically verified on the corrected packaged Mac app: manual Index and automatic dashboard-open each persisted one `ok: true` meeting and refreshed Mantu Intelligence. |
| QA-010 | High | Qwen3.5 returned a valid first JSON object followed by a second fragment, then returned null-valued optional deal sidecars; extraction was marked failed. | JSON extraction used the last closing brace, and the schema rejected the small model's semantically empty optional sidecars. | Parse the first balanced JSON object, normalize all-null amount/close-date sidecars to `null`, and add direct schema/parser regressions. | Fixed; full suite passes and the latest clean-profile automatic run completed with no index warnings. |
| QA-011 | Low | Backfill treated the meetings-folder README as a transcript candidate. | The candidate filter accepted every non-hidden `.md` except `index.md`. | Exclude `README.md` from brain backfill candidates. | Fixed; clean-profile runs indexed only the synthetic meeting, with no README entry. |

## Verification record

### Source and build gates

- `npm test`: **103 test files, 1,298 tests passed**.
- `npm run typecheck`: **passed** for both Node and web projects.
- `npm run build:intelligence`: **passed**.
- `npm run build`: **passed**, including offline-package and bytecode checks.
- Targeted regressions for Spotlight Ref, Answer notice handling, Settings version, Dust messaging, LLM behavior, local routing, brain extraction, schema normalization, and automatic-backfill gating all passed.
- `npx vitest run scripts/fetch-llama-server.test.ts`: **3 tests passed**.

### Runtime and artifact gates

- Sidecar checks passed for macOS and Windows llama-server, FFmpeg, and platform-specific Sherpa.
- Bundled model check passed: exactly one Qwen3.5-0.8B model with verified model, mmproj, and license hashes.
- Branding check passed: `/Users/tony/Downloads/Métis.png` and `build/icon-metis-source.png` have the same SHA-256; both final platform payloads contain the derived `build/icon.png` resource, the macOS app has `icon.icns`, and both builder targets point at that same icon. The macOS bundle metadata reports display name `Métis` and executable `Metis`, not Electron.
- macOS `check-packaged-runtime.mjs ... --post-sign`: **passed**; deep strict codesign verification passed.
- Windows `check-packaged-runtime.mjs ... --post-sign`: **passed** for the final unpacked payload.
- ASAR extraction passed for both final platform payloads. The Windows Setup and Portable SHA-256 values are recorded in the release handoff:
  - Setup: `f5e2269449fcf7ccb976423253b53067a09ea771a30530be397a568ee81237f4`
  - Portable: `8358c09b943b55fd7519d2b05d33c14932ebe21ba4fb84fb97e827d1477df98a`
- Final macOS artifact SHA-256 values:
  - DMG: `a72d8852717c6e05f6fabfc44a7a7e60b02a0b520a2e4b6e60a2d80a8dbb77bb`
  - ZIP: `1867e75ae74e9acacb02215df35197ad8a32bbb4af134f5e103311d804a918d6`
- Exact final macOS bundled-model warm-suggest proof passed: sidecar healthy after 2,432 ms, warm TTFT 1,311 ms, decode 26.2 tok/s. The command exited 0; timing is machine-load dependent.
- Exact final macOS smoke import passed with one transcript line saved.
- Latest physical brain proof profile `/private/tmp/metis-physical-qa-brain-auto3-20260714`: clicking **Index meetings** showed `Building your brain… 0 / 1 meetings`; the persisted index then contained one `ok: true` meeting and History showed `Intelligence · 1 meetings · 2 people · 1 accounts · 1 deals`; Mantu Intelligence → Meetings showed the meeting.
- Latest automatic-backfill proof profile `/private/tmp/metis-physical-qa-brain-auto6-20260714`: opening the Mantu Intelligence dashboard without clicking Index emitted `brain.backfill.start` with `automatic:true`, then one local `brain.ingest ok:true` entry; after refresh, Today showed one open deal and Meetings showed `1 total` with the extracted meeting.

### Physical evidence

- The final packaged app's accessibility tree exposes `Spotlight Ref · Connect Dust in Settings` on the main bar. Clicking it renders the managed-agent recovery message.
- The final packaged app's History view contains the synthetic release-review meeting and the imported `en.wav` meeting with `Summary needs attention`, `Transcript saved`, and an **Open** recovery action.
- No transient Computer Use `-10005` or stale-index responses were counted as product findings; re-querying produced the expected UI and the behavior was not reproducible in the app.

### Remaining external gates

- Native Windows execution still requires a Windows x64 device or a working CI runner.
- GitHub Actions run `29355952492` for commit `6e7edf7` was not started: both required jobs were rejected by the repository Actions budget before any step ran, and package jobs were skipped. This is an infrastructure/billing gate, not a source-test failure; the same gates passed locally on the exact pushed source state.
- Developer ID signing/notarization and trusted Windows Authenticode certificate validation require release credentials. The current macOS artifact is ad-hoc signed for local QA.
- Authenticated Anthropic/Claude and Dust success paths require user-controlled credentials; only safe missing-provider and managed-agent recovery paths were exercised here.
- Screen and microphone positive permission paths require a human to approve the OS prompts; prompts were intentionally not accepted during this QA run.
