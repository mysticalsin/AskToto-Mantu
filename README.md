# AskToto

A macOS and Windows **AI desktop overlay**: a frameless, transparent, always-on-top glass assistant
that floats over every app. Look and feel modeled on Cluely, rebuilt from scratch with Mantu branding
and wired to many AI providers (Claude, GPT, Dust, and more).

Built by **Tony Walteur** · Mantu.

Three core actions:
- **Ask** — type a question, get a streamed answer (rich markdown, code, tables).
- **Capture** — screenshot the screen, send to a vision model.
- **Listen** — live mic + system-audio transcription (on-device Whisper), real-time suggestions.

Plus one-click **Fact-check**, **Hide from screen capture**, a visible recording indicator, a
**knowledge graph** of your notes (graphify), and an optional **encrypt-transcripts** mode.

## Quick start

```bash
npm install
npm run dev          # launch the overlay (dev)
npm run typecheck    # tsc, both projects
npm test             # vitest (unit + integration)
npm run build        # bundle main + preload + renderer → out/
npm run dist         # package a signed-runtime app → release/ (electron-builder)
```

Set a provider key in-app: gear → **Your AI** → paste your key → Save (stored encrypted on-device via
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
│   │   ├── llm.ts           streaming to Anthropic / OpenAI-compatible / Dust
│   │   ├── personas.ts      mode + language system prompts
│   │   ├── transcripts.ts   meeting/note markdown, optional at-rest encryption
│   │   ├── recall.ts        list/search saved meetings (decrypt-aware)
│   │   ├── graphify.ts      knowledge-graph bridge (spawns the runner)
│   │   ├── dustcli.ts       import the local Dust CLI keychain session (macOS)
│   │   └── meeting-detect/  Zoom/Teams/Meet detection (mac.ts / win.ts)
│   ├── preload/index.ts     contextBridge `window.toto` API (contextIsolation on)
│   ├── renderer/src/        glass UI (React + Tailwind v4)
│   │   ├── components/       Bar, Settings, RecallView, Answer, CodeBlock, …
│   │   ├── state.ts          hooks (useAsk rAF-batched stream, useSettings, useAuth)
│   │   └── lib/whisper*      on-device Whisper STT (Web Worker)
│   └── shared/              cross-process contract
│       ├── ipc.ts            IPC channels + zod schemas + settings schema
│       ├── providers.ts      14-provider registry + model-tier routing
│       ├── routing.ts        thinking-mode router (base vs think tier)
│       └── prompts.ts        default mode prompts
├── resources/graphify_runner.py   graphify pipeline (bundled via extraResources)
├── ios/                     SwiftUI companion app (XcodeGen)
├── build/                   app icon, entitlements, managed-config example
├── electron-builder.yml     packaging (dmg/zip/nsis/appx), signing via env
├── docs/                    design, planning history, prior audits, SIGNING.md
└── production-readiness/    production-readiness audit package (gates + evidence)
```

## Features

- **14 providers + Dust.** Claude, GPT, NVIDIA, DeepSeek, Qwen, MiniMax, Kimi, OpenRouter, Groq,
  Together, Fireworks, Mistral, custom OpenAI-compatible, and **Dust** (your own agents, the primary
  brain). Keys auto-detected from prefix; each stored encrypted.
- **Thinking mode.** `auto` routes simple questions to a fast model (Haiku) and coding/engineering to a
  deeper one (Sonnet); a Bar toggle forces deep mode. For Dust: a base agent + a thinking agent.
- **Knowledge graph.** graphify turns the notes folder into a connected graph; per-note "Related"
  panel + an interactive graph. Reuses your Claude Code (no extra key).
- **Multilingual.** Transcribes any spoken language, assists in the speaker's language, writes the
  recap in the language you pick (Settings → Personalize → Language).
- **Azure SSO.** Optional, domain-locked Microsoft sign-in; `requireAuth()` guards every privileged IPC.
- **Encryption at rest.** Settings/keys always encrypted (keychain); transcripts encryptable on demand.

## Hotkeys (global)

| Shortcut | Action |
|---|---|
| `⌘\` | Show / hide the overlay |
| `⌘⇧Return` | Ask (global) |
| `⌘⇧S` | Capture screen, then ask |
| `⌘⇧F` | Fact-check (input text, or the screen if empty) |
| `⌘⇧L` | Toggle Listen |
| `⌘⌥ + arrows` | Move the overlay |

## Security & privacy

- **Trust boundary is the main process.** `requireAuth()` + `assertMainWindow()` guard every
  privileged IPC; the renderer runs with `contextIsolation`, `sandbox`, `nodeIntegration: false`.
- **Keys never reach the renderer** (only `hasKeys` booleans). Settings + keys encrypted at rest.
- **Content protection** hides the window from screen capture (on by default in packaged builds).
- **What leaves the device:** prompts go to the provider you choose; transcripts save to your notes
  folder (which may sync to OneDrive unless you enable encrypt-transcripts); Dust/graph read those notes.

## Docs

- `docs/design/` — design spec
- `docs/planning/` — plan + roadmap history
- `docs/audits/` — prior audit + QA reports
- `docs/SIGNING.md` — code-signing / notarization setup
- `production-readiness/` — the production-readiness audit (gate matrix, findings, evidence)

## Known gaps (honest)

- Real answers need a provider key (or Dust). Pipelines reach the APIs; a bad key returns a clean UI error.
- Code signing / notarization needs an Apple Developer ID cert; Windows signing needs a Windows runner.
- Whisper model (~40 MB) downloads from the HF hub on first Listen (needs internet once).
- Not a git repository yet; no branch protection / CI gating on commits.

## Provenance

Built by **Tony Walteur** · Mantu. Look and feel inspired by Cluely; an independent reimplementation
with its own name, mark, and source. No Cluely code, logo, or assets are used.
