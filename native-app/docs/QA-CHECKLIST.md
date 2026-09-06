# Métis Native — On-Device QA Checklist

The `MetisKit` package is verified by `swift test` (26 tests, runs on Linux/CI and macOS). The SwiftUI
**app target** can only be built and run with Xcode on a Mac, so this checklist is the manual verification
pass for everything that lives above the package: the animated onboarding, permissions UX, SwiftData
history, Settings, and the refined main view.

Work top-to-bottom. Check each box on both **macOS** and, where noted, **iOS/iPadOS** (the screen-recording
row and the macOS restart/menu-bar paths are macOS-only by design).

## 0. Build & generate

- [ ] `brew install xcodegen` (if not already installed).
- [ ] `cd native-app && xcodegen generate` succeeds and writes `Metis.xcodeproj`.
- [ ] `open Metis.xcodeproj`; the project resolves the local `MetisKit` package with no errors.
- [ ] **macOS:** select the "My Mac" destination → Build (⌘B) succeeds → Run (⌘R) launches.
- [ ] **iOS/iPadOS:** select an iOS Simulator (or device) destination → Build succeeds → Run launches.
- [ ] Warnings are reviewed; there are no strict-concurrency errors (target is `SWIFT_STRICT_CONCURRENCY: complete`).

## 1. First-run onboarding (five acts)

Reset first-run state before each full pass: delete the app's `UserDefaults` (delete/reinstall the app, or
run `defaults delete com.mantu.metis.native` on macOS) so `metis.onboardingDoneAt` is cleared.

### Scene 1 — Hero
- [ ] Launch on a clean install → the Hero scene shows first (not the main view).
- [ ] The Métis mark **draws itself** from star-points (constellation lines sweep on, stars fade in).
- [ ] The three promise bullets fade/slide in staggered.
- [ ] `Begin` advances to the Problem story.
- [ ] `Skip the tour` jumps straight to Personalize (Scene 5) — and still lands on the consent gate (see §1.5).
- [ ] Progress dots are hidden on Hero (Hero is not a guided act).

### Scene 2 — Problem story
- [ ] Lines reveal **one at a time**, auto-advancing (~1.2s each); the current line is brightest, prior lines dim.
- [ ] **Tapping anywhere** advances to the next line immediately (does not overshoot past the last line).
- [ ] After the last line, `Continue` appears and advances to Reveal.
- [ ] Progress dots now show act 1 of 4 active.

### Scene 3 — Reveal
- [ ] The example answer card animates **blur-to-sharp** shortly after the scene appears.
- [ ] The "grounded in your meeting / on your device" copy is present.
- [ ] `Set me up` advances to the Setup scene.

### Scene 4 — Your setup (live checks)
- [ ] Rows appear in `checking` state, then resolve to **real** verdicts (nothing is hardcoded to ready):
  - [ ] **Apple Intelligence** — `ready` on an Apple-Intelligence-capable Mac with the model present;
        otherwise a non-blocking "basic mode — works without it" (skipped, still counts as ready).
  - [ ] **On-device transcription** — `ready` when Speech is authorized; otherwise "downloads on first use" (skipped).
  - [ ] **Private meeting brain** — always `ready` ("stays on this Mac").
  - [ ] **Microphone** — reflects the true OS status (see the permission paths below).
  - [ ] **Screen context** (macOS only) — reflects the true Screen Recording status; **absent on iOS**.
- [ ] **Mic not-determined:** the OS mic prompt fires automatically; granting flips the row to `ready` without a click.
- [ ] **Mic action path:** if the row shows `needed`, the inline `Allow Microphone` button triggers the OS prompt.
- [ ] **Mic denied/blocked:** the row shows `blocked`; the inline button becomes `Open Microphone Settings` and
      deep-links to the Privacy → Microphone pane (no dead-end prompt).
- [ ] **Screen action (macOS):** `Open Screen Recording Settings` deep-links to Privacy → Screen Recording.
- [ ] **Screen restart nuance (macOS):** toggle Screen Recording ON in System Settings while the scene is
      open → the row flips to `restart` (not `ready`), because the grant only reaches the next launch.
- [ ] **Restart button (macOS):** `Restart Métis` relaunches the app; after relaunch the row reads `ready`.
- [ ] Live refresh: flipping a permission in System Settings (split-screen) updates the row **without** clicking.
- [ ] When every row is ready/skipped, "Everything's ready. Nothing to configure." appears.
- [ ] `Continue` is de-emphasized while a permission still needs attention, but is **never blocked** by it
      (permissions can be granted later); it advances to Personalize.

### Scene 5 — Personalize + consent
- [ ] The three mode cards (**General / Sales / Recruiting**) render with blurbs; selecting one highlights it.
- [ ] The Language picker offers Match-the-speaker / English / Français / Español / Deutsch and persists the choice.
- [ ] `Start` is **disabled** until the consent toggle is on (the required gate).
- [ ] Enabling consent enables `Start`; pressing it finishes onboarding and routes to the main view.
- [ ] The selected mode and consent are persisted (verify later in Settings, §4).

### 1.5 Persistence across relaunch
- [ ] After finishing onboarding, fully quit and relaunch → the app opens **straight to the main view**
      (onboarding does not show again; `metis.onboardingDoneAt` is set).
- [ ] Re-clearing first-run state (see top of §1) makes onboarding show again.

## 2. Permissions (grant / deny / restart)

- [ ] Fresh grant: mic/speech granted during onboarding are reflected in Settings and the main view (no mic banner).
- [ ] Denied mic: the main view shows the "Microphone is off" banner with a working `Open Settings` deep-link.
- [ ] macOS screen-recording restart: after granting + relaunch, screen-context features are usable (no lingering `restart`).
- [ ] iOS: no screen-recording row/permission anywhere (mic + speech only).

## 3. Main view

- [ ] Header shows the mark, meeting title, and "On-device AI" vs "Basic mode" per real availability.
- [ ] **Record** starts a session; the transcript empty state changes from "No transcript yet" to "Listening…".
- [ ] **Manual add line:** type a line, choose You/Them, press Add (or Return) → the line appears with the right speaker label.
- [ ] Actions are disabled while the transcript is empty and while an action is in flight (spinner shows).
- [ ] **What to say next** returns a suggestion into the "Say next" card (or a graceful error line on failure).
- [ ] **Summarize** returns a headline + action items into the "Summary" card (working + error states both handled).
- [ ] **Next steps** returns an ordered list into the "Next steps" card (working + error states both handled).
- [ ] Error path: force a failure (e.g. run on a machine without the on-device model in a way that throws) →
      a "That didn't work: …" line shows instead of a crash.
- [ ] **Mic banner** appears only when mic is denied/restricted and its `Open Settings` deep-link works.
- [ ] **Save-to-history on stop:** press Stop with a non-empty transcript → the meeting is saved (verify in History);
      an empty meeting (Record then Stop with no lines) is **not** saved (no blank rows).
- [ ] After stop, the transcript and result cards reset for the next meeting.

## 4. History

- [ ] Opening History (clock button) shows saved meetings **newest-first**.
- [ ] Empty state: with no saved meetings, the "No meetings yet" unavailable-view shows.
- [ ] Each row shows title, summary headline (when present), date, and line count.
- [ ] Tapping a row opens a read-only detail with the headline and the full transcript (correct speaker labels).
- [ ] Swipe/Delete removes a meeting from the list and it stays gone after relaunch (SwiftData persisted).
- [ ] `Done` dismisses the sheet.

## 5. Settings

- [ ] Opening Settings (gear button) shows Personalize / Privacy / Permissions / About sections.
- [ ] **Mode** picker reflects the onboarding choice and updates `metis.mode` when changed.
- [ ] **Language** picker reflects/updates `metis.language`.
- [ ] **Consent** toggle reflects/updates `metis.consent`.
- [ ] **Permission rows** show live status (Granted/Denied/Restricted/Not requested); each non-granted row's
      `Open` button deep-links to the correct Privacy pane.
- [ ] The screen-recording row appears on macOS only.
- [ ] **About** shows the app version (from `CFBundleShortVersionString`) and the on-device tagline.
- [ ] `Done` dismisses the sheet.

## 6. macOS extras

- [ ] **MenuBarExtra:** the Métis menu-bar item toggles recording (Start/Stop) and reflects AI-ready vs Basic mode.
- [ ] `Quit Métis` from the menu bar terminates the app.
- [ ] Window resizability behaves (`.contentSize`) and the dark theme/background reads as one cohesive surface.

## 7. App Intents / Siri (macOS + iOS, on-device)

- [ ] After first launch, "Hey Siri, summarize my meeting with Métis" runs `SummarizeMeetingIntent` against the live meeting.
- [ ] "Start recording in Métis" toggles recording via `ToggleRecordingIntent`.
- [ ] "What did they just say in Métis" reads back the last remote line.
- [ ] Running an intent before opening the app once returns the "Métis isn't ready yet" guidance (registry not set).
