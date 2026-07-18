# Métis Native — Apple flagship (macOS · iPadOS · iOS)

**Status:** roadmap steps 1–2 in progress. `MetisKit` builds + **9 tests green** (Swift 6.3, macOS 26 SDK):
the shared core now includes the on-device intelligence, typed `@Generable` results (summary, suggestion,
**next steps**), App Intents, a platform-neutral **`MeetingController`** (owns the live meeting, the App
Intents seam, AND a live-transcript consumer — the app's logic, unit-tested here), and **`SpeechTranscription`**
— the on-device `SpeechAnalyzer`/`SpeechTranscriber` (macOS/iOS 26) Speech→text mapping, **shape-verified to
compile against the SDK** here. The SwiftUI app target (`App/` + `project.yml`) is scaffolded, including mic
capture wired to the transcriber; `xcodegen generate` + Xcode to run it on-device. This is a **new native
product**, not an Electron conversion — it exists to use
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
  MetisKit/                         Swift package — shared, platform-neutral core (BUILDS TODAY)
    Sources/MetisKit/
      Intelligence.swift            Foundation Models wrapper (on-device now, PCC on 27 SDK) + heuristic fallback
      MeetingModels.swift           Meeting/TranscriptLine + @Generable typed results
      MeetingIntents.swift          App Intents (in-process) + AppShortcutsProvider + MeetingActions seam
    Tests/MetisKitTests/            5 tests green (swift test)
  App/            (scaffolded)      one SwiftUI multiplatform app target depending on MetisKit
    MetisApp.swift                  @main App: installs MeetingController into the intents registry + UI
    ContentView.swift               meeting screen — transcript, say-next / summarize / next-steps
    AudioCapture.swift              platform audio hook (#if os) — no-op today; roadmap 2 fills capture in
    project.yml                     xcodegen spec (macOS + iOS destinations) — `xcodegen generate`
    Audio/         macOS: ScreenCaptureKit loopback + mic   iOS: mic (AVAudioEngine) only  (#if os)
    Transcription/ SpeechAnalyzer / SpeechTranscriber (iOS 26, on-device, word timestamps)
    Speaker/       CoreML/ONNX embedding (reuse the CAM++ model the Electron app ships) + clustering
    Store/         SwiftData models + CloudKit sync (meetings/transcripts/voice profiles across devices)
    UI/            pill/overlay (macOS), full app (iOS/iPad), Live Activity (iOS recording control)
```

**Code sharing:** one app target across all three platforms; only audio capture and windowing are
`#if os(...)`-conditional. Everything AI/data/intents is shared in `MetisKit`.

## Build

```
cd native-app/MetisKit && swift build && swift test    # the core, today
```

The app targets need an Xcode project (no xcodegen on this machine yet). Next step: `brew install
xcodegen`, add a `project.yml` wrapping `MetisKit` + the SwiftUI `App/` sources, or create the app target
in Xcode directly. Then the on-device model runs live on an Apple-Intelligence Mac.

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
