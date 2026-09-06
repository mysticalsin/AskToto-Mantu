# Auto-start Listen on Teams / Zoom / Google Meet

Status: **Implemented.** Overlay chrome, Operator, Aria, signing, and pack stay frozen.

Métis starts Listen when a meeting app becomes the front window. No Accessibility permission. No auto-stop.

## Outcome

1. Settings default is ON for the master switch and for Teams, Zoom, and Google Meet.
2. Runtime never fires until `onboardingDone && recordingConsent`. Before consent: never.
3. Detection is a pure matcher on the existing foreground-watcher snapshot (mac bundle id / Windows title + process). No AX APIs, no restored `meeting-detect/` poller.
4. One start per meeting session. Leaving the meeting app (or switching platform) opens a new session. Already listening: do nothing.
5. Settings: "Start Listen when I join" plus three platform toggles. Friendly copy. No em dash.

## Settings

```
autoStartMeetings: { enabled: true, zoom: true, teams: true, meet: true }
```

Schema and `DEFAULT_SETTINGS` in `src/shared/ipc.ts`. A profile that never wrote the key inherits ON.

## Matcher

`src/shared/meeting-auto-start.ts` → `matchMeetingPlatform(ForegroundInfo) → 'zoom' | 'teams' | 'meet' | null`

| Platform | macOS | Windows |
|---|---|---|
| Zoom | bundle `us.zoom.xos` | title or process contains Zoom |
| Teams | `com.microsoft.teams2` / `com.microsoft.teams` | title `Microsoft Teams` or process Teams |
| Meet | browser + title has `meet.google.com` or `Google Meet` | same |

Browsers never match Zoom/Teams (a Chrome doc about Zoom must not start Listen). Finder and Slack return null.

macOS helper is app-level (NSWorkspace). A regular Chrome tab title is "Google Chrome", so Meet on Mac needs a title that actually contains Google Meet (PWA or a producer that later includes the tab). Zoom and Teams match by bundle. That is the Mac proof path: join Zoom, focus Zoom, Listen starts.

## Wiring

`src/main/meeting-auto-start.ts` owns a `startForegroundWatcher` instance (separate from screen-preprocess so it runs when background screen context is off). On change, `decideMeetingAutoStart` + settings gate → `IPC.meetingAutoStart` → renderer `startListen()`. Never `toggle-listen`.

Watcher process starts only when `enabled && onboardingDone && recordingConsent`.

## Out of scope

Operator, Aria, signing, pack, Accessibility restore, auto-stop, calendar-based start.
