# AskToto for iOS

A native **SwiftUI** app — the iOS adaptation of AskToto. Same brain (14 AI providers, modes,
markdown notes), reshaped for what iOS actually allows.

> **Why it's not a 1:1 of the desktop app:** iOS sandboxes every app. No app can float over *other*
> apps, and none can tap *other* apps' audio (Zoom/Teams calls). So there's no invisible overlay and
> no system-audio capture. AskToto for iOS is a proper app: ask the AI, capture **in-person** meetings
> via the microphone, read photos, and keep everything as markdown.

## Features
- **Ask** — streaming answers from 12 providers (Claude, GPT, NVIDIA, DeepSeek, Qwen, MiniMax, Kimi,
  OpenRouter, Groq, Together, Fireworks, Mistral). Paste a key — it auto-detects the provider. Attach
  a photo (slide/whiteboard/doc) for vision on Claude/GPT/OpenRouter.
- **Listen** — on-device live transcription (Speech framework) of an in-person meeting → "Take notes"
  / "What to say next", then save the whole thing.
- **Notes** — every answer and meeting saved as a `.md` file in **Files → On My iPhone → AskToto**
  (frontmatter + markdown). Search, read, share, delete. Hand them to your Dust agents.
- **Modes** — General / Interview / Sales / Meeting, each with an editable, pre-filled prompt.
- **Keychain** — API keys live in the iOS Keychain, never in plaintext.
- **Mantu brand** — purple, the M mark, "Built by Tony Walteur".

## Build & run
Requires **Xcode 15+** and **iOS 17+**.

```bash
brew install xcodegen        # once
cd ios
xcodegen generate            # creates AskToto.xcodeproj
open AskToto.xcodeproj
```
In Xcode: select the **AskToto** target → **Signing & Capabilities** → set your **Team**, then
**Run** (⌘R) on a simulator or device. Add an API key in **Settings** (or onboarding) and Ask.

> No XcodeGen? Create a new Xcode "App" project named `AskToto`, delete its `ContentView`/`App` file,
> drag every file in `ios/AskToto/` into it, and set the Info.plist usage strings (already in
> `AskToto/Info.plist`).

## Layout
```
ios/
  project.yml            XcodeGen spec
  AskToto/
    AskTotoApp.swift      @main, tabs, streaming view-model
    Theme.swift           Mantu palette, M mark, wordmark
    Providers.swift       provider registry + key auto-detect + mode prompts
    AppState.swift        settings + Keychain
    LLMClient.swift       streaming (OpenAI-compatible + Anthropic), vision
    NoteStore.swift       markdown note backend (Documents)
    SpeechTranscriber.swift  on-device transcription
    Components.swift      markdown render, answer card, mode chips
    AskView / ListenView / NotesView / SettingsView / OnboardingView
    Info.plist · Assets.xcassets
```
