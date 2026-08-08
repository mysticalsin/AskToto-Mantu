# Metis Windows Cahe

This is a Windows-only Cahê pilot installer. It is intentionally separate from the standard Métis application.

## What is different

- The installed app and Start-menu shortcut are named `Metis Windows Cahe`.
- It uses a separate Windows application identity and user-data directory, so it does not reuse normal Métis settings, encrypted keys, transcripts, or update state.
- Kimi Code is the default active provider for live questions and screenshot analysis, seeded once on first run from a bundled key — it is not locked, and switching providers in Settings → AI sticks across restarts. Dust remains available for its workspace/agent connection.
- Meeting indexing (Mantu Intelligence extraction) automatically falls back to the on-device Métis Local model if Kimi (or whichever cloud provider is active) is unreachable or unconfigured, so meetings still get indexed instead of silently never being indexed. This install already enables Local AI for the background screen reader, so the fallback works out of the box; toggle it off under Settings → Local AI → Fallback if you'd rather a down/unconfigured provider leave meetings pending instead.
- The Cahê app does not use the shared Métis auto-update feed. New Cahê builds must be distributed as new Cahê installers.

## First-run setup

1. Install `Metis-Windows-Cahe-Setup-<version>.exe`.
2. In Métis Settings → AI, enter Cahê's Kimi Code key. When entered there, it is saved in the app's encrypted local profile. It is not included in this installer or source tree.
3. Complete the Windows microphone and screen-capture permissions prompts before testing live audio or screenshots.
4. In Settings → Dust, select **Set up Dust automatically**. The app opens a console that installs `@dust-tt/dust-cli`, runs `dust login`, and asks the user to select a workspace. Leave that console open until it confirms the workspace selection; then return to Métis. Métis verifies/imports the session with `dust status` and loads the workspace agents.

If Node.js/npm is missing, install a supported Node.js release first, then repeat the Dust setup. The manual equivalent is:

```text
npm install -g @dust-tt/dust-cli
dust login
dust status
```

## Build and verification

Run `npm run installers:win:cahe`. The build creates only an x64 NSIS setup EXE, verifies the packaged runtime and executable architecture, compares the package's main-process bytecode with the just-built source, and fails if a Kimi-shaped secret is found in the app archive or installer.

## Pilot boundary

Use this installer with non-sensitive test material until Kimi vendor security, data-processing, and compliance reviews are documented for the intended use. An organisation-managed provider allowlist remains authoritative; if it excludes Kimi, Cahê fails closed before sending cloud requests.
