# AskToto — Operations Runbook

Audience: the end user and (for managed rollouts) IT. AskToto 0.1.0 is a local desktop app — "operations"
is endpoint/day-2 support, not server ops. Evidence = `file:line`.

Date: 2026-06-27.

---

## 1. Install & first-run

1. Install the signed artifact (see DEPLOYMENT_RUNBOOK): macOS `.dmg`/`.zip`, Windows NSIS `.exe` /
   portable `.exe` / AppX (`electron-builder.yml:33-64`).
2. Launch — menubar/tray-only app (`app.dock.hide()`, `skipTaskbar`, `LSUIElement:true`).
3. Grant OS permissions when prompted: **Microphone**, **Screen Recording** (mac: also for system audio),
   **Accessibility** (mac, for meeting detection) (`platform-perms.ts`).
4. Settings → **Your AI** → paste a provider API key → Save (stored encrypted, `store.ts:186-202`).
5. (Optional) Set the **notes folder** — defaults to OneDrive `AskToto Meetings/` (`transcripts.ts:146-150`).
6. (Optional, enterprise) Deploy `managed-config.json` to the machine-wide admin path to preset/lock
   provider, enforce SSO, set notes folder (`store.ts:78-98`, `build/managed-config.example.json`).

## 2. Key operational settings (managed-config keys)

`provider`, `providerModels`, `meetingsFolder`, `autoSaveTranscripts`, `autoStartOnMeeting`,
`launchAtLogin`, `contentProtection`, `audioSource`, `encryptTranscripts`, plus a `locked` array and the
`azure` SSO block. Machine path wins over per-user (`store.ts:85-98`, `auth.ts:48-58`).

## 3. Routine operations

| Task | How |
|------|-----|
| Rotate a provider key | Settings → clear → paste new (`store.ts:204-207`) |
| Change LLM provider | Settings → Your AI (unless `provider` is locked) |
| Enable at-rest transcript encryption | Settings toggle `encryptTranscripts` (note: disables index.md + graph auto-rebuild) (`transcripts.ts:204`, `Settings.tsx:1529`) |
| Move notes folder | Settings → folder picker (`folder:pick`, `index.ts:622`) |
| Import existing Dust session | Settings → Connect Dust → Import CLI (mac keychain prompt) (`dustcli.ts`) |
| Rebuild notes knowledge graph | Settings → graphify rebuild (`graphify:rebuild`, auto-debounced 20 s) |
| Sign out | Settings → About → Sign out (`auth.ts:247-254`) |

## 4. Health checks

- **Self-test**: the app runs `runSelfTest` and writes pass/fail JSON (`selftest.ts`, `index.ts:694`).
- **Test key** button does a live provider round-trip (`store.ts:214-263`).
- **Build verification** (CI / pre-release): `npm run typecheck && npm test` —
  current local run: **56/59 pass**; the 3 failures are `dustcli.test.ts` real-keychain tests blocked by
  the sandbox (`security: UNIX[Operation not permitted]`) and **pass 4/4 with keychain access**. The
  suite is effectively green.

## 5. Common issues & resolution

| Symptom | Likely cause | Resolution |
|---------|--------------|-----------|
| "Encryption is unavailable… cannot store your API key" | OS keychain locked / unavailable | Unlock keychain / login keyring, or set the key via env var (`store.ts:195-200`) |
| "No API key for <provider>" | key not set or wrong provider selected | Settings → add key / pick the provider whose key is set (`index.ts:497-503`) |
| Listen produces no text | mic/screen permission denied, or model download blocked | Grant permissions; ensure HF CDN reachable on first Listen (`whisper.worker.ts`) |
| Provider says "can't read screenshots" | provider lacks vision | Switch to a vision provider (`index.ts:520-524`) |
| Auto-update never runs | placeholder update host | Expected until a real `publish.url` is set (`updater.ts:14-18`) |
| Settings seem reset | undecryptable settings (OS account / keychain changed) → safe fallback to defaults | Re-enter settings; data fails safe, never bricks (`store.ts:114-127`) |
| Meeting auto-start not firing | Accessibility/UIA permission, or app not installed | Grant Accessibility (mac); verify Zoom/Teams/Meet running (`meeting-detect/`) |

## 6. Logs

- Location: `electron-log` default path (`~/Library/Logs/AskToto/` on macOS, `%USERPROFILE%\AppData\Roaming\AskToto\logs\` on Windows). Used by the updater and (recommended) for support diagnostics.
- Logs stay **local**; nothing is shipped to a vendor.

## 7. N/A

- Server scaling / capacity / runbooks for fleets of instances — **N/A** (one binary per machine).
