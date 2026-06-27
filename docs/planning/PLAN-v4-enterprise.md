# PLAN v4 — AskToto Enterprise (managers package)

Goal: full installable package for managers. macOS first (built), Windows next (electron-builder win).
NOT iOS — an always-on-top overlay capturing live system audio is impossible on iOS (sandbox). If an
iOS companion is wanted later it's a separate, limited app (record/import → transcript only).

## Enterprise capabilities (the /loop target)
1. **Transcripts → OneDrive folder** [THIS ITERATION] — every meeting auto-saved to a clear folder in
   the manager's OneDrive (`<OneDrive>/AskToto Meetings/`), in Dust-readable markdown + frontmatter so
   Dust agents read them and generate follow-ups. Configurable path (auto-detects OneDrive), auto-save toggle.
2. **Auto-trigger on any meeting** — detect Teams / Zoom / Meet / Webex (and generic calls) starting →
   auto-start Listen. macOS: poll for meeting apps + mic-in-use. Setting to enable + per-app allow.
3. **Enterprise packaging** — signed/notarized macOS .dmg + (later) Windows NSIS installer; auto-update;
   per-org config (managed defaults: folder, provider, hotkeys). LSUIElement menubar app.
4. **Dust handoff** — transcript files carry SBAP-style frontmatter (type, date, participants, source)
   so the vault's Dust agents ingest + follow-up. Optional drop into `00_Inbox/from-dust/` shape.
5. **Cluely-grade settings** — all of: AI provider, About-you, Audio, In-meeting toggles, Shortcuts,
   PLUS Meetings folder, Auto-start-on-meeting, Launch-at-login. User-friendly.
6. **Polish + verify** — typecheck/build green each iteration; screenshot surfaces; honest gaps.

## Definition of Done (enterprise)
- [ ] Meeting → transcript+notes file lands in OneDrive folder automatically (Dust-readable). ← iter 1
- [ ] Auto-detect + auto-start on Teams/Zoom/any meeting (opt-in).
- [ ] Settings: folder picker (OneDrive default) · auto-save · auto-start · launch-at-login.
- [ ] Packaged macOS app (dmg) installs clean for a non-dev manager; Windows target wired.
- [ ] Dust frontmatter validated; a Dust agent can read a saved transcript.
- [ ] typecheck+build green; surfaces screenshot-verified; known gaps stated.

## Iteration log
- iter1 DONE ✅ (verified): transcript export pipeline → `<OneDrive>/AskToto Meetings/<date>-<slug>.md`
  with Dust frontmatter (type/status/participants/duration) + notes + timestamped transcript.
  Settings "Meetings & transcripts": folder (OneDrive auto-detect) + Change/Open + auto-save +
  auto-start-on-meeting toggle + launch-at-login. Save fires on End & review. typecheck+build green;
  format verified by read-back. DoD #1 ✅.
- iter2 DONE ✅: auto-meeting-detection — `meeting-detect.ts` (AppleScript: Zoom/Teams/Webex window
  titles + Google Meet/Zoom-web/Teams-web via Chrome/Brave/Edge/Arc/Safari tab URLs). Main poller
  (7s, edge-triggered, respects `autoStartOnMeeting`) → `meeting:detected` → renderer auto-starts
  Listen if not already. Fail-open; needs macOS Accessibility + Automation perms (one-time grant).
  typecheck+build green; AppleScript syntax verified via osacompile. DoD #2 ✅ (mechanism; live-meeting
  end-to-end needs a real call + perms to fully confirm).
  KNOWN LIMIT: can't auto-detect every app (covers the big 5 + browser); mic-in-use native signal deferred.
- iter3 DONE ✅: enterprise packaging. electron-builder built `release/mac-arm64/AskToto.app`
  (id com.asktoto.app, LSUIElement menubar app) — PROVEN packages. Windows NSIS target + mac dmg/zip
  configured. Enterprise **managed-config** wired: IT drops `managed-config.json` in userData to preset
  org defaults (provider/folder/auto-start/launch-at-login); `build/managed-config.example.json` bundled
  as extraResource. typecheck+build green; .app verified (Info.plist id + LSUIElement true).
  KNOWN: unsigned (needs your Developer ID Application cert + notarization for distribution — Intune
  certs present but not a Dev-ID); Windows build needs a Windows/CI runner; bundle 762MB (trim wasm later).
  NOTE: `release/` left in place (gitignored) — it will OneDrive-sync; delete if unwanted.
- iter4 DONE ✅: adversarial review of new enterprise code (bg agent) + fixes applied & verified:
  HIGH — malformed managed-config no longer bricks app (per-key validation; base always valid).
  MED — managed-config now a LIVE default layer (sparse user overrides, no first-run full-bake);
  transcript filename collisions fixed (seconds + uniqueness loop); save-on-review hardened
  (in-flight guard, pin-on-success, error surfaced in Review); vision actions blocked on non-vision
  providers (Kimi/custom) with a friendly message. LOW — title YAML-sanitized; OpenAI token telemetry
  no longer fabricated; meeting timer cleared on quit; Teams new "MSTeams" + more apps detected.
  Review confirmed auto-start armAudio path is correct. typecheck+build green.
- iter5 DONE ✅: app icon (glasses squircle → build/icon.png; electron-builder generates icon.icns,
  warning gone, verified). Cross-platform OneDrive detection (macOS + Windows env vars + Linux).
  Bundle trim: renderer deps → devDependencies → packaged .app 762MB → **284MB** (verified). README
  refreshed (enterprise section; stale system-audio claim fixed). typecheck+build green.

- iter6 DONE ✅: self-documenting OneDrive folder. On first app launch `ensureMeetingsFolder` creates
  `<OneDrive>/AskToto Meetings/` with **README.md** (explains it, for managers + Dust) + **index.md**
  (running table of every meeting with links). Each save appends an index row; folder/README/index
  collision-safe. Behavior test 6/6 PASS; typecheck+build green. Matches "install a folder clear for
  us to read." DoD #1 hardened.
- iter7 DONE ✅: auto-update (`src/main/updater.ts` — electron-updater, packaged-only, autoDownload +
  install-on-quit; `publish:` placeholder in electron-builder.yml for your update host). Meeting detector
  now CROSS-PLATFORM: macOS osascript + Windows PowerShell (Zoom/Teams/Webex/GoTo window titles).
  typecheck+build green. (Auto-update needs your HTTPS update host to actually serve updates.)
- iter8 NEXT: final full-repo adversarial review + fixes → then converge (rest is Tony-only).

- iter8 DONE ✅: FULL QA (4 lenses/60 agents, each finding verified) + physical test (5 surfaces
  screenshotted, pipelines run) → see **QA-REPORT.md** (numbered Q01-Q26 + P1-P11). Fixed & verified
  18 issues incl HIGH auto-meeting auto-save (data loss), global-Cmd+Enter hijack, multilingual Whisper,
  capture-queue cap, provider path-traversal validation, dev-only dotenv, CSP hardening, single-instance
  lock, tray icon (Windows), screenshot downscale, onboarding provider-aware, injection guard on all
  transcript prompts, auto-update placeholder skip, admin managed-config path, empty-review state, poller
  overlap guard, aria/clipboard. typecheck+build+launch green. TONY-only remain: signing/notarize,
  update host, third-party-consent legal posture, cloud-PII default policy.

## LEGAL DECISION (2026-06-26) — Natively repo NOT used
Asked to integrate github.com/Natively-AI-assistant/natively-cluely-ai-assistant. Its LICENSE is
"Natively Personal Use Source License v1.0 — All rights reserved": non-commercial only; forbids using
its code/ARCHITECTURE/prompts/implementation to build a competing commercial product (§6.10-6.11);
any copy/derivative must keep THEIR license + attribution (§4.4/§7); no relicensing or claiming-as-own
(§4.6/§6.7-6.9). AskToto = enterprise app for Mantu managers = commercial. DECLINED copying it (even
reframed as non-commercial, "strip license + my app" violates §4.4/§4.6/§6.7-6.9). Clone deleted, not
read for replication. Backend strengthened INDEPENDENTLY instead (own code + permissive OSS). If their
actual code is wanted: obtain a written commercial license from Natively AI.

## INDEPENDENT BACKEND (lawful "complete app")
- iter9 DONE ✅: Recall backend (`src/main/recall.ts`, own impl) — list + keyword-search the saved
  meeting markdown history; IPC recall:list/recall:search + preload; types in @shared. typecheck+build green.
- iter10 DONE ✅: Recall UI — History button (clock) in the bar → searchable meeting-history view
  (list + keyword search + open file; path-traversal-safe recall:open). Physically verified: renders
  "MEETING HISTORY · 2" with seeded meetings, search box, click-to-open. typecheck+build green.
- iter11 DONE ✅: conversation memory — Ask keeps last 12 turns (history wired to AskStart.history),
  follow-ups now have context; cleared on reset. typecheck+build green. Closes prior Q24.
- next: semantic recall (embeddings over transcripts) · export/share. All independent + OSS.

## REMAINING BUILDABLE (looping)
DoD status: #1 transcripts→OneDrive ✅ · #2 auto-detect/auto-start ✅ (mechanism) · #3 settings ✅ ·
#4 packaged macOS app ✅ (Windows target wired) · #5 Dust frontmatter ✅ (format verified) ·
typecheck+build green ✅ · two adversarial reviews + fixes ✅.
REMAINING = Tony-only (cannot build further): Developer-ID signing + notarization (Apple cert);
Windows build (Windows/CI runner) + Windows meeting-detector; point a Dust agent at the folder;
one real meeting end-to-end (real call + mic/screen/Accessibility/Automation grants). Loop stopped
honestly rather than churn.
