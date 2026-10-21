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
