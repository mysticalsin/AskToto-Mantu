# Sandbox acceptance of the QA-identity build (WP14)

Installed acceptance of `Metis QA.app` (`com.mantu.asktoto.qa`) and its 60-minute soak, run **only** inside
`_relay/goal-loop/sandbox-home/`, launched **only** through `_relay/goal-loop/isolate.sh`, with **synthetic audio only**.
Nothing here touches `/Applications`, the Keychain, the real brain, OneDrive or the installed Métis.

| Script | Does |
|---|---|
| `install.mjs` | Extracts the QA zip into `<sandbox>/Applications/`, proves bundle id and ad-hoc signature, records sha256 of zip and executable. |
| `run-acceptance.mjs` | Launch, meeting with synthetic speech, save, review, clean quit, relaunch, data preserved, quit. JSON report with a PASS/FAIL/NOT_SUPPORTED/SKIPPED per step. `--scenario settings-hig` runs the Apple HIG Settings acceptance instead (below). |
| `upgrade.mjs` | The opt-in `upgrade` scenario (update, single instance, rollback on one shared profile) and its pure judges. `install.mjs --apps-dir` installs beside the shared install. |
| `settings-hig.mjs` | The opt-in `settings-hig` scenario and its pure helpers (CDP key-event builders, observation classifiers). |
| `soak.mjs` | Idle, then synthetic meeting, then post-meeting; CPU/RSS every 30 s; growth verdict SOAK-ACCEPT-1; JSON and markdown. |
| `guard.mjs` | Pure refusal rules used by all three (see below). |

## Run order

Put the pinned Node first in `PATH` (as in AGENTS.md), then wrap every command in `isolate.sh`. Below, `ISO` is
`<repo>/_relay/goal-loop/isolate.sh` and the working directory is the checkout holding this folder.

```bash
export PATH=<repo>/_relay/goal-loop/toolchains/node-v22.22.3-darwin-arm64/bin:$PATH
ISO=<repo>/_relay/goal-loop/isolate.sh
REPO=<checkout containing scripts/qa/sandbox-acceptance>

# 1. Build the QA identity zip (the only package command isolate.sh allows). The zip lands in release/.
$ISO /bin/bash -c "cd $REPO && npm run dist:qa-identity"

# 2. Install it into the sandbox (replace an older install with --replace).
$ISO /bin/bash -c "cd $REPO && node scripts/qa/sandbox-acceptance/install.mjs --zip release/Metis-QA-<version>.zip --replace"
#    -> <sandbox>/Applications/Metis QA.app and install-receipt.json (zip sha256, executable sha256, codesign facts)

# 3. Validate configuration and every guard without launching anything.
$ISO /bin/bash -c "cd $REPO && node scripts/qa/sandbox-acceptance/run-acceptance.mjs --dry-run"
$ISO /bin/bash -c "cd $REPO && node scripts/qa/sandbox-acceptance/soak.mjs --dry-run"

# 4. Acceptance scenario (about 6-10 minutes).
$ISO /bin/bash -c "cd $REPO && node scripts/qa/sandbox-acceptance/run-acceptance.mjs"

# 5. The 60-minute soak. caffeinate keeps the Mac and display awake; it is not a launch route.
$ISO /bin/bash -c "cd $REPO && caffeinate -di node scripts/qa/sandbox-acceptance/soak.mjs --minutes 60"
```

Reports are written under `<sandbox>/acceptance/<run-id>/reports/` (`acceptance-<run-id>.json`, `soak-<run-id>.json`,
`soak-<run-id>.md`); the run directory is not under `run-*`, so `isolate.sh` never prunes it while a long run is going.

### Useful flags

- `--app <path>`: default `<sandbox>/Applications/Metis QA.app`. Must resolve inside the sandbox.
- `--sandbox-root <path>`: default derived from `HOME` (`.../sandbox-home/run-*`) or `METIS_SANDBOX_ROOT`.
- `--audio speech|tone|file` (`--wav <16-bit PCM wav>` with `file`): default `speech`, synthesised by macOS `say` and converted
  with `afconvert`. `tone` is a non-speech signal, so the transcript step reports NOT_SUPPORTED. There is no silent fallback.
- `run-acceptance.mjs`: `--meeting-seconds 90`, `--transcript-wait-seconds 150`, `--save-wait-seconds 180`, `--out`.
- `soak.mjs`: `--minutes 60` (minimum 4), `--idle-minutes`, `--meeting-minutes` (defaults 40% / 50% / remaining post),
  `--interval-seconds 30`, `--footprint` (adds phys_footprint via vmmap, several seconds per process), `--no-poll-queue`.
- Exit codes: `0` PASS or PASS_WITH_GAPS (acceptance) / PASS (soak), `1` FAIL or INCOMPLETE, `2` a guard refused or bad arguments.

## What the guards refuse (`guard.mjs`)

The run does not start unless all hold; `--dry-run` prints each check.

- The sandbox root ends in `_relay/goal-loop/sandbox-home`.
- The app path resolves (symlinks followed) inside the sandbox; anything under `/Applications` is refused by name.
- `CFBundleIdentifier` is exactly `com.mantu.asktoto.qa` (`com.mantu.asktoto` is refused explicitly).
- The child environment's `HOME`, `TMPDIR`, `ASKTOTO_USERDATA` (and any `TMP`, `TEMP`, `XDG_*`, `CFFIXED_USER_HOME`) resolve inside
  the sandbox; no credential-shaped variable; no OneDrive variable; `ASKTOTO_LOCAL_KEYSTORE=1` (no Keychain).
- The meetings folder resolves inside the sandbox.
- The harness itself was started through `isolate.sh` (`METIS_LOOP_ISOLATED=1`) with a sandboxed `HOME`/`TMPDIR`/`ASKTOTO_USERDATA`.
- No `open`, `launchctl` or `osascript`, directly or inside a shell wrapper. The app is started by **direct spawn** of
  `Contents/MacOS/<exe>` with an explicit environment, so nothing is set through launchd and nothing reaches the real Métis session.
- `TMPDIR` plus Chromium's single-instance socket path fits the 103-byte unix socket limit, otherwise the app would fail
  `requestSingleInstanceLock` and quit. TMPDIR is therefore `<sandbox>/t/<4 hex>`.

Do **not** reuse `scripts/qa/packaged-smoke.mjs` (uses `open -a` and a `launchctl setenv ASKTOTO_USERDATA` fallback),
`scripts/qa/fault-fatal-relaunch.mjs` (osascript, `open -n`) or `scripts/qa/census/run.mjs` without `--app`
(defaults to `/Applications/Metis.app`) for this work.

## How synthetic audio gets in

The QA-identity build already supports a file-fed microphone (`src/main/qa-capture-source.ts`): when the app is packaged, QA
identity, `ASKTOTO_USERDATA` is set and `METIS_QA_CAPTURE_FILE` names a `.wav` **inside that profile**, it appends Chromium's
`--use-fake-device-for-media-stream` and `--use-file-for-fake-audio-capture=<wav>` (the file loops) and audits
`qa.capture.file_source`. The harness writes the WAV to `<userdata>/qa-capture/synthetic.wav`, sets the variable in the child
environment and **refuses to start a meeting unless that audit record exists**, so a real microphone can never be opened by mistake.
The meeting is started by clicking the overlay's own "Start listening" button over loopback CDP (a trusted input event, which is what
the preload requires). No QA-only hook is needed in app source.

## What each acceptance step observes

| Step | Evidence (never a placeholder) |
|---|---|
| `launch-and-renderer-ready` | child pid; `app.renderer.ready` and `qa.capture.file_source` records in the profile's `audit.log`; CDP page exposing `window.toto` |
| `meeting-live` | "Stop and end meeting" control visible after the Start click |
| `transcript-observed` | an `.autosave-draft-*.md` appears in the sandbox meetings folder (the renderer writes it every 60 s once it holds transcript lines). NOT_SUPPORTED with the reason for `--audio tone` |
| `stop-and-save` | a new saved meeting `.md` (not README/index/draft/note) in the sandbox meetings folder, its size, seconds to save |
| `review-opens-meeting` | `recallList()` lists it and `recallRead()` decodes it (line count only; `recallOpen` is not used because it hands the file to the OS) |
| `clean-quit` | exit code 0 after `window.toto.quit()`, an `app.shutdown.clean` record, no surviving owned process |
| `relaunch` / `meeting-preserved-after-relaunch` | second renderer-ready; the file is still on disk and still listed and readable; `prevShutdown` from `app.started` |
| `final-quit` | as `clean-quit` |

A step is recorded PASS only when it returns evidence; a step whose prerequisite did not PASS is SKIPPED, never PASS. Reports carry
counts, flags, hashes and file names, never transcript text or titles.

## Settings HIG scenario (`--scenario settings-hig`, C28)

Opt-in; the default `--scenario meeting` is unchanged. It needs no speech, so `--audio` defaults to `tone` here (pass `--audio` to
override). The profile is seeded once with `provider: custom` and a valid `https://` endpoint (`example.invalid`) so the Custom
endpoint field renders. Keyboard input is real CDP `Input.dispatchKeyEvent`; clicks are trusted Playwright clicks.

```bash
$ISO /bin/bash -c "cd $REPO && node scripts/qa/sandbox-acceptance/run-acceptance.mjs --scenario settings-hig --dry-run"
$ISO /bin/bash -c "cd $REPO && node scripts/qa/sandbox-acceptance/run-acceptance.mjs --scenario settings-hig"
```

| Step | What it observes (PASS only on this) |
|---|---|
| `settings-shortcut-opens` | Command-Comma (Control-Comma on Windows) as a CDP key event; `role=tablist` "Settings sections" becomes visible (it was not before). |
| `settings-toggle-applies-without-save` | Settings > Privacy switch "Carry context into follow-up questions": `aria-checked` flips, `window.toto.getSettings()` reports the new value, and `.cl-root` holds no Save/Apply/OK button. NOT_SUPPORTED if the switch is absent or managed. |
| `settings-confirm-escape-cancels` | "Replay onboarding" opens an `alertdialog` titled "Replay onboarding?" with buttons Cancel, Replay; focus is on Replay; a CDP Escape closes it; Settings stays open and `onboardingDone` is still true. |
| `settings-audio-no-mic-request` | A `getUserMedia` counter is installed, then Settings > Speech opens: zero calls, no mic-capture audit record, and with the permission unknown the "Test Microphone" button is visible (denied: "Open System Settings" and no Test button). NOT_SUPPORTED when the sandbox profile already has the microphone granted. This build writes no dedicated mic-capture audit event, so the call count is the primary observation. |
| `settings-endpoint-inline-validation` | `http://` typed into "Custom endpoint URL", then blur: the field is `aria-invalid`, its `aria-describedby` id is a visible `role=alert` with text, no `alertdialog` appears, and `getSettings().customBaseUrl` is unchanged. NOT_SUPPORTED if the field has no label (build predates it). |
| `clean-quit`, `relaunch` | As in the meeting scenario. |
| `settings-last-pane-restored` | After relaunch, Command-Comma opens Settings on the AI tab (last viewed, not the default Modes & Display). |
| `settings-endpoint-unchanged-after-relaunch` | The field and the stored setting still hold the pre-input endpoint; the `http://` value was never saved. |
| `settings-toggle-persisted-after-relaunch` | The toggled value survived the relaunch in both the switch and `getSettings()`. |
| `final-quit` | As `clean-quit`. |

A post-relaunch step whose pre-quit step was NOT_SUPPORTED is NOT_SUPPORTED too; if that step FAILED it is SKIPPED. The toggle is left
in its new value (the profile is a throwaway sandbox). "Replay onboarding" is used for the confirmation, so a build without the
confirmation sheet would start onboarding and the later steps would fail visibly rather than pass.

## Voice actions scenario (`--scenario voice-actions`, V08)

Opt-in; needs a QA-identity build that carries the voice hooks (`src/main/qa-voice-hooks.ts`, proven by `scripts/lib/qa-fault-hook.mjs`
in both directions: a shipping package must carry none of them, a QA package all of them). Nothing real is touched: no keyboard,
microphone, Notes, browser or camera.

- **Keyboard.** `METIS_QA_CHORD_FIFO` names a FIFO inside the profile (`<userdata>/qa-voice/chord.fifo`, made with `mkfifo`). The
  app's chord watcher reads it instead of the helper's stdout, so the recognizer, voice session, lease and capture are the real ones.
  The harness writes the helper's own `m <mask> <seq>` lines. If the env asks for the FIFO and any check fails (outside the profile, a
  symlink escape, not a FIFO) the watcher gets no source at all; it never falls back to the real keyboard helper.
- **Microphone.** One WAV per utterance (`open Notes`, `create a note called ...`, a question), made at run time with macOS `say`
  (through a phrase file, never argv) and `afconvert`, 1 s of leading silence and 3 s of trailing silence, in `<userdata>/qa-voice/`.
  Before each hold the harness swaps the file Chromium's fake microphone reads (ASSUMED: it reads the file when the capture stream
  opens; the first spoken step proves it). `--va-relaunch-per-utterance` relaunches before each utterance instead.
- **Desktop.** `METIS_QA_DESKTOP_SINK=1` makes the durable task bridge dispatch into a recording sink that audits
  `qa.desktop_action.dispatched` (action id, outcome, args hash, never an argument). `create_note` is scripted `unknown` (the
  uncertain path); everything else returns `verified` with a receipt bound to the dispatch.
- **Brain.** The custom provider points at `scripts/qa/mock-llm-server.mjs`, started in-process with a throwaway certificate
  (`openssl`), whose request log answers "how many requests carried the question" without printing it.

```bash
$ISO /bin/bash -c "cd $REPO && node scripts/qa/sandbox-acceptance/run-acceptance.mjs --scenario voice-actions --dry-run"
$ISO /bin/bash -c "cd $REPO && node scripts/qa/sandbox-acceptance/run-acceptance.mjs --scenario voice-actions"
# with the 10 minute idle-cost soak of the REAL chord helper (relaunches without the FIFO):
$ISO /bin/bash -c "cd $REPO && node scripts/qa/sandbox-acceptance/run-acceptance.mjs --scenario voice-actions --va-idle-cost-minutes 10"
```

Flags: `--va-idle-seconds 60`, `--va-runs 3` (read-only runs for the release-to-done p50), `--va-idle-cost-minutes 0`,
`--va-relaunch-per-utterance`. The report is withheld, and the run fails, if it contains any spoken word.

| Step | PASS only on this evidence |
|---|---|
| `va-audio-prepared` | one valid 16 kHz WAV per utterance (sha256, duration), reported by id only |
| `va-default-on` | `voiceActions.enabled` is null or true (follows the build default), effective `enabled` true, `wakeWord` false, the Speech switch "Use voice actions" is checked, and no `getUserMedia` call and no lease or voice-turn audit before any hold |
| `va-idle-no-mic` | idle window with zero `getUserMedia`, no lease or turn audit, and a `qa.chord_fifo` open audit (the watcher source is the FIFO) |
| `va-short-hold-ignored` | a 120 ms hold: no `[data-voice-state]` element, no card, no lease |
| `va-read-only-immediate` | `open Notes`: pill sequence exactly `listening > thinking > executing > done`, no card, one `desktop.open_notes` in the sink, the task store changed; release-to-done p50 recorded against the assumed 1.5 s warm budget |
| `va-confirm-escape` | an `alertdialog` titled "Create a note in Notes" with the spoken title as its argument, focus on "Create"; Escape removes it, the pill reads the cancelled copy, the sink stays at 0, `command.revoked reason=cancelled` is audited. NOT_SUPPORTED if the build proposes but mounts no card |
| `va-return-guard` | Return about 100 ms after mount leaves the card up and the sink at 0 |
| `va-confirm-return-uncertain` | Return after 500 ms: one `desktop.create_note`, one `task.effect_uncertain`, the uncertain pill copy; after a relaunch recovery reports one uncertain task and the sink count stays 1 |
| `va-uncertain-reader-details` | NOT_SUPPORTED: the right-edge Reader details list takes no voice outcome in this build |
| `va-question` | the mock LLM got exactly one request carrying the question, the answer view shows the mock answer, no sink dispatch |
| `va-meeting-arbitration` | with a meeting live, a hold gets the refused-during-a-meeting pill, no lease or turn start, no capture disturbance audit, and the autosave draft keeps growing |
| `va-renderer-reset-revokes` | a reload mid-listening: the lease is revoked with reason renderer-reset, the turn is cancelled, no proposal, no sink dispatch |
| `va-toggle-off-instant` | the Settings switch off closes the FIFO source within 1 s, a hold shows no pill; on again reopens it |
| `va-reduced-motion` | with `prefers-reduced-motion: reduce` emulated, every pill animation is zero length except the liveness pulse |
| `va-idle-cost` | NOT_SUPPORTED unless `--va-idle-cost-minutes` is set; then the REAL chord helper's mean one-core CPU is at most 0.1 percent (the soak also reports it as `helperCpu`) |
| `va-no-utterance-at-rest` | after the app quit, a case-insensitive scan of the profile, sandbox home and TMPDIR finds none of the spoken marker words, and the operator queue holds only allowlisted `voice_action` keys |

Owner-run `LIVE_VERIFIED` items that this cannot do without touching the real session stay on the owner checklist: the physical
chord in another app, a real Notes note, the Photo Booth Accessibility flow, VoiceOver, AltGr on real hardware, focus restore.

## Upgrade scenario (`--scenario upgrade`, C29)

Opt-in. Needs `--previous-zip` and `--candidate-zip` (both `Metis-QA-*.zip`, QA identity) and optionally `--candidate-version` (default
`2.12.0`). It installs both builds itself into `<sandbox>/upgrade/<run-id>/Applications/` (never the shared `<sandbox>/Applications`
that a soak may be using) and runs every launch against ONE profile, `<sandbox>/acceptance/<run-id>/userdata`. `--run-id` is at most 16 characters.

```bash
$ISO /bin/bash -c "cd $REPO && node scripts/qa/sandbox-acceptance/run-acceptance.mjs --scenario upgrade --run-id upg-1 --previous-zip release/Metis-QA-1.9.7.zip --candidate-zip release/Metis-QA-2.12.0.zip"
```

| Phase | Steps (PASS only on the observation named) |
|---|---|
| Previous build | `install-previous`; `previous-launch-and-ready`; `previous-settings-written` (setSettings, then getSettings and settings.json hold the value); meeting live, transcript draft, stop and save (the meeting scenario's own observations); `previous-clean-quit` (a hash snapshot of every meeting file is taken). |
| Upgrade | `install-candidate-over-previous` (new main-executable hash, profile files unchanged by the install); `candidate-launch-on-previous-profile`; `candidate-reports-version` (Info.plist, `getSettings().version` and the audit `app.started`/`app.renderer.ready` version all equal the expected version and differ from the previous build); `candidate-meeting-preserved` (listed, `recallRead` decodes it, byte-identical to the snapshot); `candidate-settings-preserved`; a second meeting. |
| Single instance | `single-instance`: a second process on the same profile (same env, no debug port) must exit 0 by itself within 15 s, the first must still be running and answer `getSettings()`, and no crash record may appear. The audit events written meanwhile are recorded by name. |
| Rollback | `install-previous-again`; `rollback-launch` (the older build on the profile the newer one wrote; recorded honestly as started or refused); `rollback-meetings-listed`; `rollback-clean-quit`; `rollback-data-integrity` (sha256 of every meeting file equals the pre-rollback snapshot). FAIL only on a crash, or a meeting that changed or vanished. A safe refusal is NOT_SUPPORTED with the reason. |
| Re-upgrade | `install-candidate-again`; `reupgrade-launch`; `reupgrade-meetings-present`; `reupgrade-clean-quit`. |
| Gap | `legacy-profile-migration` is NOT_SUPPORTED: the Metis/AskToto profile-dir adoption only runs when `ASKTOTO_USERDATA` is unset, where Electron would resolve the real Application Support folder, which this harness must never touch. |

The "previous" build is whatever zip is passed; a branch build labelled 1.9.7 is not the shipped public 1.9.7.

## Quiet mode scenario (`--scenario quiet-mode`, G88, CAP-32)

QA identity only; a synthetic meeting is live and the output gate (G68) is read through the real preload bridge. The gate is never
disabled. The direct request uses the local mock LLM (same mock and certificate handling as voice-actions) and the real Ask box
(`Ask Métis anything`, Return). The report carries actions, counts and booleans only; the typed question contains `quokka`, and a
report that contains that word is withheld and the run FAILS.

| Step | Observes |
|---|---|
| `qm-policy-default` | `getQuietPolicy()` is a valid policy and allows every channel when idle. NOT_SUPPORTED when the bridge is absent or the host is already quiet (an OS Focus mode). |
| `qm-meeting-live` | The synthetic meeting is live (the in-call signal main's gate reads). |
| `qm-unsolicited-held` | Every channel of the policy is `defer` or `drop`; `quietOutputOffer(channel)` never answers `allow` and agrees with the policy. |
| `qm-direct-request-answered` | A typed ask is answered while quiet: the answer view shows and the mock LLM saw exactly 1 request. NOT_SUPPORTED without the mock or the Ask box. |
| `qm-released-after-stop` | After Stop and save, one coalesced `onQuietOutputReleased` batch names every deferred channel. FAIL when the policy is allow again and nothing was released. |
| `clean-quit` | Clean shutdown, no owned process left. |

## Memory and assistants scenario (`--scenario memory-assistants`, G88, CAP-26 and CAP-29 local)

Defaults to the tone input (it never listens). Reports carry counts, revisions and booleans; the assistant name contains `marmoset` and
the corrected memory `zebrafinch`, both leak-checked in the report and scanned at rest after the quit.
At the integration tip the assistants bridge has no renderer consumer and `propose` is owner-command only, and the user-memory bridge
has no add call. So the creation and memory steps are NOT_SUPPORTED with that reason, not faked; no QA hook was added to `src/`.
A PASS needs a visible confirm card and a trusted click (the confirm IPC is never called by the harness).

| Step | Observes |
|---|---|
| `ma-assistant-propose-card` | A proposal mounts a visible confirm card; one click creates exactly one assistant. |
| `ma-assistant-idempotent` | Proposing and confirming the same draft again leaves the count unchanged. |
| `ma-memory-correct` | An existing memory keeps its id, its revision rises, the list holds the corrected text. |
| `ma-memory-delete-tombstone` | One fewer memory, one more tombstone, the id is gone. |
| `clean-quit`, `relaunch` | As the meeting scenario. |
| `ma-persisted-after-relaunch` | Exactly the assistants this profile created are listed, and a deleted memory has not come back. |
| `final-quit` | Clean shutdown. |
| `ma-no-marker-at-rest` | After the quit, neither marker is readable anywhere under the profile, home or TMPDIR. |

## Binding (every scenario, G88, CAP-40)

Every report carries `meta.binding`: `commit`, `run` (`hosted` with id, attempt and url, or `local` with the run id), `installerSha256`
(from `install-receipt.json`, never from a guessed path), `appHash` (sha256 of the installed `Contents/Resources/app.asar`),
`mainExecutableSha256`, `bundleVersion` and `bindingSource`.

- `provenance`: pass `--provenance <provenance.json>` from a `qa-candidate` run. It must pass `provenanceProblems` and the installer sha256
  must be one of its `builds[].assets[].sha256`.
- `local-asserted`: no provenance. The commit is `HEAD` of the harness checkout, which must have a clean `git status`. The label says
  the zip-to-commit link is asserted by whoever ran it, not proven.
- A binding problem is exit 2 before anything launches. Upgrade and stress install their own build, so the source is checked up front
  against the zip's own hash and the receipt is bound after the run (a receipt for a different zip fails the run).

## E2E map (`capability-map.json`, `e2e-report.mjs`)

`capability-map.json` lists all 40 capabilities and all 54 E2E-01..10 cases, each with rows of a kind: `sandbox` (a scenario and step ids,
target `LOCALLY_TESTED` or `DESIGNED`), `ci-only` (the unit or CI evidence), `owner-checklist` (hardware or owner; target
`LIVE_VERIFIED`, `ACCEPTED` or `MEASURED`; never names a scenario), `blocked-external` (decision id and the exact unblock step),
`pending-disposition` (G92 records E2E-04 and E2E-08) or `not-in-2.12`. `capability-map.test.ts` fails on a missing CAP or case, an unknown
scenario or step, an owner row that names a scenario, a sandbox row claiming a live or measured level, or a blocked row without an unblock.

```bash
node scripts/qa/sandbox-acceptance/e2e-report.mjs <acceptance-*.json>... [--json]
```

Joins the map with the latest report of each scenario. Statuses: `PASS`, `FAIL`, `NOT_RUN`, `NOT_SUPPORTED` (never upgraded),
`CI_ONLY`, `OWNER`, `BLOCKED_EXTERNAL`, `PENDING`. Exit 2 when a report has no valid binding or the reports disagree on commit, installer
or app hash; exit 1 when a row FAILED. Soak reports are not bound yet (soak.mjs is unchanged), so the soak rows stay `NOT_RUN`.

## Soak verdict SOAK-ACCEPT-1

Thresholds are fixed in `soak-verdict.mjs` and printed in every summary. This is a 60-minute acceptance rule, not the
pre-registered 5.5 h IDLE-GROWTH-1 / MEETING-GROWTH-1 (those need 300 min after settle).

- Validity: main alive at every sample (else FAIL); at least 95% of planned samples complete; at least 4 window samples per phase.
- Settle: first min(10 min, 25%) of each phase; reference = median of the last 2.5 min of settle.
- Idle: total RSS Theil-Sen slope projected to 60 min, and last-3 minus first-3 median, each at most max(64 MiB, 10% of reference);
  process count at most reference + 2; mean one-core CPU of the last third at most the first third + 0.5 points.
- Meeting: as idle with max(160 MiB, 20%), +4 processes, +5 CPU points.
- Post-meeting: median of the last 3 total-RSS samples at most the meeting reference + max(160 MiB, 20%); process count at most idle reference + 4.
- A run under 60 minutes is labelled "NOT A FULL 60-MINUTE SOAK".

CPU and RSS come from one `ps` call per sample over the owned process tree (main, descendants, residents of the install root; census
ownership rules, never by name); CPU uses the census one-core formula. Queue depth: `window.toto.brainStatus()` (`live.pending`, `backfill`)
is polled through a short-lived CDP connection; when the profile is signed out it returns null and the report says
`queue: NOT_INSTRUMENTED` with where an ASR queue metric would have to come from (`src/main/parakeet.ts`). Standing CDP is not held
during idle; `--remote-debugging-port` stays open for the whole run, which is a small constant observer effect.

## Tests

`scripts/qa/sandbox-acceptance/*.test.ts` need no app: guards, CLI parsing, layout and environment, WAV construction, step report
and verdict rules, soak verdict statistics, sampler parsing, and the launch path against a fake bundle script. Run through the wrapper:

```bash
$ISO /bin/bash -c "cd $REPO && npx --offline vitest run scripts/qa/sandbox-acceptance"
```
