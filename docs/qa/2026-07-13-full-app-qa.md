# Métis full physical QA ledger

**Date:** 2026-07-14

## Test boundary

Physical testing uses the final packaged Apple Silicon macOS app with synthetic data and an isolated profile. The final DMG, ZIP, and app are under `/private/tmp/metis-release-final-20260714-mac`. Windows x64 Setup and Portable EXEs are under `/private/tmp/metis-release-final-20260714-win`; they pass payload, ASAR extraction, architecture, and runtime checks, but there is no Windows device or runner available for native execution. Provider-authenticated paths and OS permission approval are intentionally not performed with real credentials or captured user content.

## Workflow matrix

| ID | Workflow | Test method | Status |
| --- | --- | --- | --- |
| WF-01 | First launch and onboarding | Clean-profile packaged-app UI at `/private/tmp/Metis-QA-Onboarding-20260714.app`: consent, all onboarding pages, **Decide later**, and **Get started** | Passed |
| WF-02 | Overlay window, keyboard controls, minimize, restore, quit | Final packaged app: main bar, Spotlight Ref, Interview mode, minimize/pill/expand, hide invocation, quit/relaunch | Passed |
| WF-03 | Settings persistence and privacy controls | Final packaged app: mode persisted as Interview after relaunch; Privacy and AI tabs; About shows `Métis 1.0.2 · Mantu` | Passed |
| WF-04 | Offline audio import and transcription | Final packaged app native picker selected `en.wav`; UI showed `Transcribing`, then `Summary needs attention` and saved transcript; smoke import also passed | Passed |
| WF-05 | Saved meeting, history, recall, and recovery | Synthetic six-line meeting opened from History with transcript; imported meeting produced a recoverable summary notice and Open action | Passed |
| WF-06 | Métis Local text routing, summary, vision, warm restart | AI tab showed bundled Qwen3.5 0.8B and enabled local features; model hashes and packaged warm-suggest proof passed; denied screen permission exercised safe fallback | Passed |
| WF-07 | Mantu Intelligence, indexing, read views, and guarded backfill | Intelligence screen showed saved-meeting count; Index meetings displayed the no-provider recovery guard; dashboard/read views navigated without a crash | Passed |
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

## Verification record

### Source and build gates

- `npm test`: **101 test files, 1,284 tests passed**.
- `npm run typecheck`: **passed** for both Node and web projects.
- `npm run build:intelligence`: **passed**.
- `npm run build`: **passed**, including offline-package and bytecode checks.
- Targeted regressions for Spotlight Ref, Answer notice handling, Settings version, Dust messaging, and LLM behavior: **5 files, 39 tests passed**.
- `npx vitest run scripts/fetch-llama-server.test.ts`: **3 tests passed**.

### Runtime and artifact gates

- Sidecar checks passed for macOS and Windows llama-server, FFmpeg, and platform-specific Sherpa.
- Bundled model check passed: exactly one Qwen3.5-0.8B model with verified model, mmproj, and license hashes.
- Branding check passed: `/Users/tony/Downloads/Métis.png` and `build/icon-metis-source.png` have the same SHA-256; both final platform payloads contain the derived `build/icon.png` resource, the macOS app has `icon.icns`, and both builder targets point at that same icon. The macOS bundle metadata reports display name `Métis` and executable `Metis`, not Electron.
- macOS `check-packaged-runtime.mjs ... --post-sign`: **passed**; deep strict codesign verification passed.
- Windows `check-packaged-runtime.mjs ... --post-sign`: **passed** for the final unpacked payload.
- ASAR extraction passed for both final platform payloads. The Windows Setup and Portable SHA-256 values are recorded in the release handoff:
  - Setup: `d6a4def7bd5e29d291d32416714466e1015a9b26a40f6ab1f821e78734854031`
  - Portable: `03a97b5762b586e5fbbb981d7be358c19f4095fa3759d30f95a62550329d5fc6`
- Exact final macOS bundled-model warm-suggest proof passed: sidecar healthy after 2,432 ms, warm TTFT 1,311 ms, decode 26.2 tok/s. The command exited 0; timing is machine-load dependent.
- Exact final macOS smoke import passed with one transcript line saved.

### Physical evidence

- The final packaged app's accessibility tree exposes `Spotlight Ref · Connect Dust in Settings` on the main bar. Clicking it renders the managed-agent recovery message.
- The final packaged app's History view contains the synthetic release-review meeting and the imported `en.wav` meeting with `Summary needs attention`, `Transcript saved`, and an **Open** recovery action.
- No transient Computer Use `-10005` or stale-index responses were counted as product findings; re-querying produced the expected UI and the behavior was not reproducible in the app.

### Remaining external gates

- Native Windows execution still requires a Windows x64 device or a working CI runner.
- GitHub Actions run `29347116698` for commit `b579732` was not started: both required jobs were rejected by the repository Actions budget before any step ran. This is an infrastructure/billing gate, not a source-test failure; the same gates passed locally on the exact commit.
- Developer ID signing/notarization and trusted Windows Authenticode certificate validation require release credentials. The current macOS artifact is ad-hoc signed for local QA.
- Authenticated Anthropic/Claude and Dust success paths require user-controlled credentials; only safe missing-provider and managed-agent recovery paths were exercised here.
- Screen and microphone positive permission paths require a human to approve the OS prompts; prompts were intentionally not accepted during this QA run.
