# AUTO-START MEETINGS — DESIGN (Tony 2026-09-06)

Goal: auto Listen on join for Teams/Zoom/Google Meet only. Foreground watcher. No calendar. No Accessibility.

Settings: autoStartMeetings { enabled, zoom, teams, meet } all default true. Runtime gate: onboardingDone && recordingConsent. Master off or platform off = no start.

Detect: zoom=us.zoom.xos / Zoom title; teams=com.microsoft.teams2|teams; meet=browser + meet.google.com/Google Meet.

On match → IPC → renderer startListen(). Debounce per session. No auto-stop.

Settings UI: master + three toggles. Tests for matcher + gate. No pack. READY TO MERGE no.

## Implementation map

- Schema / defaults: `src/shared/ipc.ts` (`autoStartMeetings`, `IPC.meetingAutoStart`)
- Matcher + gate: `src/shared/meeting-auto-start.ts`
- Watcher owner: `src/main/meeting-auto-start.ts` (existing `foreground-watcher`, no AX)
- Renderer: `IPC.meetingAutoStart` → `startListen()` only
- Settings: Audio → In meetings → "Start Listen when I join" + Teams / Zoom / Google Meet

Mac proof: join Zoom and focus the Zoom app (`us.zoom.xos`). Meet on Mac only matches when the window title contains Google Meet or meet.google.com (helper is app-level).
