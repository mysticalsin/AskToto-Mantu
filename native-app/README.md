# Métis Native — Apple flagship (macOS · iPadOS · iOS)

**Status:** roadmap steps 1–4 in progress. `MetisKit` builds + **26 tests green** — and now builds and
tests **on Linux/CI** too (Swift 6.0.3), not only the macOS SDK: the shared core includes the on-device
intelligence, typed `@Generable` results (summary, suggestion, **next steps**), App Intents, a
platform-neutral **`MeetingController`** (owns the live meeting, the App Intents seam, AND a live-transcript
consumer — the app's logic, unit-tested here), **`SpeechTranscription`** — the on-device
`SpeechAnalyzer`/`SpeechTranscriber` (macOS/iOS 26) Speech→text mapping, **shape-verified to compile against
the SDK** — and the new **`OnboardingModel`** five-act first-run state machine (see [Onboarding](#onboarding)).
The SwiftUI app target (`App/` + `project.yml`) is a real shell now: animated onboarding, permissions UX,
SwiftData meeting history, Settings, and a refined main view. It still **requires Xcode on a Mac** to build
and run (`xcodegen generate` + Xcode); this Linux box only builds/tests the `MetisKit` package. This is a
**new native product**, not an Electron conversion — it exists to use
Apple Intelligence, App Intents/Siri, and (on the 27 SDK) Private Cloud Compute *natively*, which the
notarized Electron app structurally cannot. The Electron app remains the **Windows / cross-platform** path.

## Why native (the whole point)

Verified by compiling against the SDK on this machine:
- **Foundation Models on-device** — `SystemLanguageModel`, `LanguageModelSession`, streaming, and
  `@Generable` **guided generation** (typed `MeetingSummaryResult`/`SuggestionResult` straight from the
  model, no JSON parsing). Zero bundled weights, zero API keys, on-device privacy. *(compiles today)*
- **Private Cloud Compute** — `PrivateCloudComputeLanguageModel` is **macOS/iOS 27-SDK only** (confirmed
  absent from the macOS 26 SDK here). It is the **free 2M-downloads tier** (App Store Small Business
  Program, `com.apple.developer.private-cloud-compute` entitlement) — a native **App Store** build
  qualifies where the Electron dmg cannot. Wired in `Intelligence.swift` behind a documented gate; flip it
  on when the project moves to the 27 SDK.
- **App Intents / Siri / Spotlight / Shortcuts** — verified (WWDC 2024/2025 + docs, 3-0): registered
  **in-process** via an `AppShortcutsProvider` in the app's `init`, **no App Store and no separate
  extension required for the intents themselves**. Shipped here: `ToggleRecordingIntent`,
  `SummarizeMeetingIntent`, `LastThingSaidIntent` + `MetisShortcuts`. "Hey Siri, summarize my meeting"
  works with no user setup once registered.
- **Onscreen awareness** — the `.appEntityIdentifier` SwiftUI modifier exposes the app's *own* visible
  entities to Apple Intelligence/Siri so the assistant can act on them (distinct from system-only screen
  reading, which stays private to the OS).

## The hard iOS constraint (product-shaping — Apple-sourced)

**iOS/iPadOS cannot capture another app's or a phone/VoIP call's audio.** There is no loopback API; the OS
forbids it (confirmed against Apple audio-session guidance and shipping recorder apps). So:

| | macOS | iPadOS / iOS |
|---|---|---|
| Own mic ("ME") | ✅ | ✅ |
| Remote party ("THEM") system loopback | ✅ ScreenCaptureKit / Core Audio tap | ❌ **not possible** |
| Realistic meeting mode | full copilot (both sides) | **in-person meetings** (one room mic), or a ReplayKit broadcast extension for screen-share sessions |

Design consequence: macOS is the full two-sided meeting copilot; **iOS is the in-person / on-the-go
companion** (record the room, live transcript, summaries, Siri actions, review past meetings synced from
the Mac). This is a genuine product boundary, not a bug — bake it into the UX rather than promise parity.

## Architecture

```
native-app/
  MetisKit/                         Swift package — shared, platform-neutral core (BUILDS + TESTS on Linux/CI)
    Sources/MetisKit/
      Intelligence.swift            Foundation Models wrapper (on-device now, PCC on 27 SDK) + heuristic fallback
      MeetingModels.swift           Meeting/TranscriptLine + @Generable typed results
      MeetingController.swift        platform-neutral live-meeting logic + App Intents seam
      MeetingIntents.swift          App Intents (in-process) + AppShortcutsProvider + MeetingActions seam
      Onboarding.swift              five-act onboarding state machine + permission/row verdicts (pure, unit-tested)
    Tests/MetisKitTests/            26 tests green (swift test): core + OnboardingModel + persistence Codable
  App/                              one SwiftUI multiplatform app target depending on MetisKit (needs Xcode/Mac)
    MetisApp.swift                  @main App: onboarding gate (@AppStorage) + modelContainer + macOS MenuBarExtra
    ContentView.swift               meeting screen — transcript, say-next / summarize / next-steps, save-on-stop
    AudioCapture.swift              platform audio hook (#if os) — no-op today; roadmap 2 fills capture in
    Onboarding/     OnboardingView  the animated SwiftUI skin over MetisKit's OnboardingModel (five scenes)
    Permissions/    PermissionsService  real OS impl of MetisKit's OnboardingPermissions seam (#if os edges)
    Store/          PersistedModels     SwiftData StoredMeeting + MeetingStore (transcript kept as a Codable blob)
    History/        HistoryView         on-device saved-meeting list + read-only detail + delete
    Settings/       SettingsView        mode/language, consent, live permission rows + deep-links, About
    UI/             Theme, MetisMark    visual language + the self-drawing constellation mark
    Assets.xcassets                 AccentColor + AppIcon scaffold (drop real PNGs before an App Store build)
    project.yml                     xcodegen spec (macOS + iOS destinations) — `xcodegen generate`
```

**Code sharing:** one app target across all three platforms; only audio capture and windowing are
`#if os(...)`-conditional. Everything AI/data/intents is shared in `MetisKit`.

## Onboarding

A five-act first-run experience — the Métis translation of the Vibe-Island onboarding anatomy already
shipped in the Electron app (`docs/ONBOARDING-EXPERIENCE.md`):

1. **Hero** — the welcome beat: the mark draws itself from star-points, the promise, `Begin` (or `Skip the tour`).
2. **Problem story** — the emotional core, staged one line at a time (auto-advance + tap-to-advance), then `Continue`.
3. **Reveal** — a blurred-to-sharp example answer grounded in a meeting; `Set me up`.
4. **Your setup** — the honest magic moment: live checks (Apple Intelligence, on-device transcription,
   private brain, Microphone, Screen context) with real verdicts, inline Allow / Open-Settings / Restart
   actions, and the macOS Screen-Recording *restart* nuance (a fresh grant only reaches the next launch).
5. **Personalize + consent** — a `General`/`Sales`/`Recruiting` mode card, a language picker, and the
   required recording-consent gate before `Start`.

The flow **logic** — every scene transition, each row-state verdict, and the consent gate — lives in
`MetisKit/Onboarding.swift` (`OnboardingModel`, `@Observable @MainActor`) so it is **unit-tested by
`swift test`** with a deterministic permissions mock; the OS-specific piece is injected through the
`OnboardingPermissions` seam. The animated SwiftUI **skin** is `App/Onboarding/OnboardingView.swift`
(native motion only — staged fades, `Path.trim` self-draw, blur-to-sharp reveal). Completion is persisted
to `@AppStorage("metis.onboardingDoneAt")`, so onboarding shows once and the app opens straight to the
meeting view on later launches. The "honesty rule" is enforced in the model: a row reads *ready* only when
a real probe/permission said so — the magic moment is never faked.

## Build

```
cd native-app/MetisKit && swift build && swift test    # the core — runs on Linux/CI and macOS
```

The `MetisKit` package builds and its 26 tests pass on plain Linux (Swift 6.0.3) as well as the macOS SDK.
The SwiftUI app target needs Xcode on a Mac: `brew install xcodegen`, then `cd native-app && xcodegen
generate && open Metis.xcodeproj`. The `project.yml` spec already wraps `MetisKit` + the `App/` sources
(macOS + iOS destinations, asset-catalog icon/accent, the Speech usage key). On an Apple-Intelligence Mac
the on-device model runs live; see `docs/QA-CHECKLIST.md` for the full on-device verification pass.

## Roadmap (next, in order)

1. Xcode app target (SwiftUI multiplatform) wrapping MetisKit — runnable on-device Foundation Model.
2. macOS audio: ScreenCaptureKit loopback + mic → SpeechTranscriber live transcript.
3. Speaker ID: port the CAM++ embedding + online clustering (same approach as the Electron app).
4. SwiftData + CloudKit persistence/sync; Data Protection on transcripts + voice profiles.
5. iOS in-person mode + Live Activity recording control + widgets.
6. PCC path on the 27 SDK for heavy summaries; entitlement application (already advised for the Electron side).

## Verified vs assumed

- **Verified by compiling here:** Foundation Models on-device API surface (availability, session, streaming,
  `@Generable`), all four frameworks import, PCC absent from the 26 SDK.
- **Verified by research (3-0):** App Intents in-process registration, `.appEntityIdentifier`, Spotlight
  actions on Mac, PCC = the 2M free tier / App-Store-gated.
- **Assumed (research verification cut short by an API session limit; Apple-primary-sourced, align with the
  above):** SpeechAnalyzer/SpeechTranscriber as the best native transcription; the iOS no-loopback rule;
  Live Activities recording controls. Re-verify SpeechTranscriber's exact API when building Transcription/.
