# Métis 2.12 release notes

2.12 hardens the meeting copilot that already ships: saving, recovering and owning meetings is more reliable, and
the Mac permission and Settings experience follows Apple's Human Interface Guidelines.

## Meetings
- Cloud-speech meetings save and autosave again. A trusted speech-metadata policy is installed at startup, with an
  inline fallback when the speech worker is unavailable (Settings key `meetingSpeechWorker`, on by default).
- A live meeting journal records each final cloud-speech line as it arrives, encrypted on disk. After a crash, the
  next launch adds any lines the last autosave missed, or recovers the meeting from the journal when no draft exists.
  Journals are removed after a verified save, on discard, and after 14 days (at most 10 kept). Settings key
  `liveMeetingJournal`, on by default.
- Restarting after an interrupted save no longer resumes into a different meeting with the same file name, and a
  draft whose saved copy cannot be verified is kept instead of deleted.

## Sessions and desktop commands
- Owner sessions end at sign-out, account changes, sleep, screen lock, quit and when a window's page is replaced.
- Confirmed desktop commands run as durable tasks: an action interrupted by a crash is reported as uncertain and is
  never repeated automatically.

## Mac permissions and Settings
- Métis asks for the microphone and Screen Recording only when you choose Continue on the row that needs it, and
  Settings → Audio no longer opens the microphone until access is granted ("Test Microphone").
- Purpose strings explain each request in one sentence, including Apple Events for desktop commands.
- Command-Comma opens Settings, which reopens on the last pane you used.
- Confirmation sheets put focus on the right button, Return confirms, Escape cancels. Signing out of Outlook,
  disconnecting Dust, removing a key, repairing Screen Recording and shortening retention (with the number of
  meetings it would delete) now ask first.
- Invalid endpoints and unwritable meeting folders are reported next to the field instead of failing silently;
  Launch at Login shows what macOS actually allows.

## Reliability
- Optional speech components report a full disk as a disk error and keep the previous working version.
- Security updates for bundled dependencies (MCP SDK 1.32.1 and others).
