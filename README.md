<div align="center">

# AskToto

**The invisible AI copilot for every meeting.**
A frameless, transparent, always-on-top glass overlay for macOS and Windows.

<img src="docs/media/asktoto-hero.png" alt="AskToto overlay — Ask anything bar with a syntax-highlighted answer on frosted purple glass" width="760">

`16 AI providers + Dust` · `thinking-mode routing` · `live transcription` · `knowledge graph` · `encrypted at rest`

Built by **[Tony Walteur](https://www.linkedin.com/in/tonywalteur/)** · Mantu

</div>

---

A macOS and Windows **AI desktop overlay**: a frameless, transparent, always-on-top glass assistant
that floats over every app. Look and feel modeled on Cluely, rebuilt from scratch with Mantu branding
and wired to many AI providers (Claude, GPT, Dust, and more).

Three core actions:
- **Ask** — type a question, get a streamed answer (rich markdown, code, tables).
- **Capture** — screenshot the screen, send to a vision model.
- **Listen** — live mic + system-audio transcription (on-device Whisper), real-time suggestions.

Plus one-click **Fact-check**, **Hide from screen capture**, a visible recording indicator, a
**knowledge graph** of your notes (graphify), and **transcripts encrypted at rest by default**.

## Install (v1.0.0)

Grab the installer for your OS from the [AskToto-Releases](https://github.com/mysticalsin/AskToto-Releases/releases) page:

- **macOS** — `AskToto-1.0.0.dmg` (Apple Silicon; macOS 12+). v1.0.0 is not yet notarized:
  first launch needs right-click → Open → Open (one time). Auto-update activates once builds
  are signed + notarized.
- **Windows** — `AskToto-Setup-1.0.0.exe` (installer) or `AskToto-Portable-1.0.0.exe`
  (no-install). v1.0.0 is not yet Authenticode-signed: SmartScreen will warn — More info →
  Run anyway.

All transcription runs on-device; models are bundled (no first-run download).

## Quick start (from source)

```bash
npm install
npm run dev          # launch the overlay (dev)
npm run typecheck    # tsc, both projects
npm test             # vitest (unit + integration)
npm run build        # bundle main + preload + renderer → out/
npm run dist         # package a signed-runtime app → release/ (electron-builder)
```

Set a provider key in-app: gear → **AI** → paste your key → Save (stored encrypted on-device via
Electron `safeStorage`). Or connect **Dust** (your own agents) with one click from the Dust CLI session.

## Repository map

```
AskToto/
├── README.md                ← you are here
├── src/
│   ├── main/                Electron main process (trust boundary)
│   │   ├── index.ts         windows, global hotkeys, IPC handlers (requireAuth + assertMainWindow)
│   │   ├── store.ts         settings + API keys, encrypted at rest (safeStorage)
│   │   ├── auth.ts          Azure AD (Entra) SSO, domain-locked; requireAuth() gate
│   │   ├── llm/             provider strategies — streaming to Anthropic SDK / OpenAI-compatible
│   │   │                    (incl. Gemini) / Dust / CLI (Claude Code, Codex); llm.ts is the dispatch shim
│   │   ├── personas.ts      mode + language system prompts
│   │   ├── transcripts.ts   meeting/note markdown, optional at-rest encryption
│   │   ├── recall.ts        list/search saved meetings (decrypt-aware)
│   │   ├── graphify.ts      knowledge-graph bridge (spawns the runner)
│   │   └── dustcli.ts       import the local Dust CLI keychain session (macOS)
│   ├── preload/index.ts     contextBridge `window.toto` API (contextIsolation on)
│   ├── renderer/src/        glass UI (React + Tailwind v4)
│   │   ├── components/       Bar, Settings, RecallView, Answer, CodeBlock, …
│   │   ├── state.ts          hooks (useAsk rAF-batched stream, useSettings, useAuth)
│   │   └── lib/whisper*      on-device Whisper STT (Web Worker)
│   └── shared/              cross-process contract
│       ├── ipc.ts            IPC channels + zod schemas + settings schema
│       ├── providers.ts      16-provider + Dust registry + model-tier routing
│       ├── routing.ts        thinking-mode router (base / think / deep tiers)
│       └── prompts.ts        default mode prompts
├── resources/graphify_runner.py   graphify pipeline (bundled via extraResources)
├── build/                   app icon, entitlements, managed-config example
├── electron-builder.yml     packaging (dmg/zip/nsis/appx), signing via env
└── docs/                    design spec, architecture, hardening backlog, SIGNING.md
```

## Features

- **16 providers + Dust.** Claude, GPT, Gemini, NVIDIA, DeepSeek, Qwen, MiniMax, Kimi, OpenRouter,
  Groq, Together, Fireworks, Mistral, custom OpenAI-compatible, keyless Claude Code / Codex CLI
  backends, and **Dust** (your own agents, the primary brain). Keys auto-detected from prefix; each
  stored encrypted.
- **Thinking mode.** `auto` routes simple questions to Haiku, heavier analytical questions to Sonnet,
  and coding/engineering/deep reasoning to Opus; the Bar toggle forces Opus. For Dust: a base agent +
  a thinking agent.
- **Knowledge graph.** graphify turns the notes folder into a connected graph; per-note "Related"
  panel + an interactive graph. Reuses your Claude Code (no extra key).
- **Multilingual.** Transcribes any spoken language, assists in the speaker's language, writes the
  recap in the language you pick (Settings → Personalize → Language).
- **Azure SSO.** Optional, domain-locked Microsoft sign-in; `requireAuth()` guards every privileged IPC.
- **Encryption at rest.** Settings/keys always encrypted (keychain); transcripts envelope-encrypted
  (AES-256-GCM) by default — can be disabled per user or locked on via managed config.

## Hotkeys (global)

| macOS | Windows | Action |
|---|---|---|
| `⌘\` | `Ctrl+\` | Show / hide the overlay |
| `⌘⇧Return` | `Ctrl+Shift+Enter` | Ask (global) |
| `⌘⇧S` | `Ctrl+Shift+S` | Capture screen, then ask |
| `⌘⇧F` | `Ctrl+Shift+F` | Fact-check (input text, or the screen if empty) |
| `⌘⇧L` | `Ctrl+Shift+L` | Toggle Listen |
| `⌘⌥ + arrows` | `Ctrl+Alt + arrows` | Move the overlay |

## Security & privacy

- **Trust boundary is the main process.** `requireAuth()` + `assertMainWindow()` guard every
  privileged IPC; the renderer runs with `contextIsolation`, `sandbox`, `nodeIntegration: false`.
- **Keys never reach the renderer** (only `hasKeys` booleans). Settings + keys encrypted at rest.
- **Content protection** hides the window from screen capture (on by default in packaged builds).
- **What leaves the device:** prompts go to the provider you choose; transcripts save to your notes
  folder (which may sync to OneDrive — envelope-encrypted by default); Dust/graph read those notes.

## Docs

- `docs/design/` — design spec
- `docs/SIGNING.md` — code-signing / notarization setup
- `docs/asktoto-architecture.md` — architecture reference
- `docs/asktoto-hardening-backlog.md` — deferred hardening items

## Known gaps (honest)

- Real answers need a provider key, a connected Claude Code / Codex CLI (keyless), or Dust. A bad key
  returns a clean UI error.
- Code signing / notarization needs an Apple Developer ID cert; Windows signing needs a Windows runner.
- ASR weights (Whisper base + large-v3-turbo + Parakeet) are bundled into the installer by
  `npm run fetch-models` (run automatically by `predist`) and load offline via the `asr-model://`
  protocol — no download on first Listen. Dev builds without fetched models fall back to a one-time
  CDN download.
- Git repo with a GitHub remote (mysticalsin/AskToto-Mantu) and CI on every push (typecheck, vitest,
  npm audit, SBOM, secret scan — `.github/workflows/build.yml`); branch protection on `main` is not
  yet configured.

## Provenance

Built by **Tony Walteur** · Mantu. Look and feel inspired by Cluely; an independent reimplementation
with its own name, mark, and source. No Cluely code, logo, or assets are used.
