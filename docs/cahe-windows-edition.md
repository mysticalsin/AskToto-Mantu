# Metis Windows Cahe

This is a Windows-only Cahê pilot installer. It is intentionally separate from the standard Métis application.

## What is different

- The installed app and Start-menu shortcut are named `Metis Windows Cahe`.
- It uses a separate Windows application identity and user-data directory, so it does not reuse normal Métis settings, encrypted keys, transcripts, or update state.
- Kimi Code is the default active provider for live questions and screenshot analysis, seeded once on first run from a bundled key — it is not locked, and switching providers in Settings → AI sticks across restarts. Dust remains available for its workspace/agent connection.
- Métis Local (the bundled on-device model) is enabled by default and acts as a safety net: if Kimi (or whichever cloud provider is active) is unreachable or unconfigured, meeting indexing (Mantu Intelligence extraction) and in-scope live asks (suggestions, summaries, screenshot analysis) run on-device as a last resort instead of failing — meetings still get indexed, and the assistant still answers. Cloud providers are always preferred when they work. Toggle this off under Settings → Local AI → Fallback if you'd rather a down/unconfigured provider leave that work pending instead.
- The Cahê app does not use the shared Métis auto-update feed. New Cahê builds must be distributed as new Cahê installers.

## First-run setup

1. Install `Metis-Windows-Cahe-Setup-<version>.exe`.
2. Nothing to enter for Kimi. The installer carries Cahê's Kimi Code key as an **encrypted** blob (`resources/cahe/kimi.json`, AES-256-GCM via `scripts/embed-cahe-kimi-key.mjs`), and the first launch copies it once into the app's encrypted local profile. Verify under Settings → AI that Kimi Code shows as saved; if the pilot was built keyless (see **Build and verification**), paste the key there instead. Changing or removing the key later sticks — the seed never runs a second time.
3. Complete the Windows microphone and screen-capture permissions prompts before testing live audio or screenshots.
4. In Settings → Dust, select **Set up Dust automatically**. The app opens a console that installs `@dust-tt/dust-cli`, runs `dust login`, and asks the user to select a workspace. Leave that console open until it confirms the workspace selection; then return to Métis. Métis verifies/imports the session with `dust status` and loads the workspace agents.

If Node.js/npm is missing, install a supported Node.js release first, then repeat the Dust setup. The manual equivalent is:

```text
npm install -g @dust-tt/dust-cli
dust login
dust status
```

## Build and verification

Run `npm run installers:win:cahe`. The build creates only an x64 NSIS setup EXE, verifies the packaged runtime and executable architecture, and compares the package's main-process bytecode with the just-built source.

The Kimi key comes from `build/cahe-kimi.local.json`, a gitignored file the operator provides locally (`{"kimiApiKey":"sk-kimi-…"}`) — it is not in the source tree. `scripts/embed-cahe-kimi-key.mjs` encrypts it into `build/cahe-embed/kimi.json` (same `encryptProxyKey` material as the Cloudflare embed); `electron-builder.cahe.win.yml` packs that ciphertext as `resources/cahe/kimi.json`. The build sets `METIS_CAHE_EMBED_KEY=1` so the packaging gate (`scripts/check-cahe-package.mjs`) allows the encrypted embed, refuses a plaintext `kimiApiKey` field, and proves the decrypted token appears nowhere in the package. **Obfuscation, not secrecy** — the decryption material ships in the app. To build without a key, set `METIS_CAHE_ALLOW_KEYLESS=1`.

## Pilot boundary

**The embedded key is not a secret once distributed.** Anyone holding a keyed `Metis-Windows-Cahe-Setup-<version>.exe` — or an installed copy — can recover a live Kimi Code key from the encrypted blob with effort (the obfuscation material ships in the app). A casual `strings` / plaintext JSON read no longer yields the key. Treat the installer itself as the credential: distribute it only to named pilot users, use a key scoped to this pilot's minimum plan and quota, and never reuse a key that guards anything else. To rotate or revoke, revoke the old key in the Kimi console, put the new one in `build/cahe-kimi.local.json`, and rebuild — an existing install keeps the key already seeded into its profile, so rotation also means replacing it under Settings → AI or reinstalling into a fresh profile.

Use this installer with non-sensitive test material until Kimi vendor security, data-processing, and compliance reviews are documented for the intended use. An organisation-managed provider allowlist remains authoritative; if it excludes Kimi, Cahê fails closed before sending cloud requests.
