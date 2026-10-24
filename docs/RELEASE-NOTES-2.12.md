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

## Availability
Every 2.12 capability has one disposition in [`docs/release-2.12/dispositions.json`](release-2.12/dispositions.json):
Available, Preview (off), Not in 2.12 (with a reason), or Pending qualification while its exact-artifact checks are
still to run. A `Not run:` line marks a check that needs hardware or an account and has not been run.

<!-- availability:begin -->
| Capability | Availability | Notes |
| --- | --- | --- |
| CAP-01 Release baseline and integration reconciliation | Pending qualification |  |
| CAP-02 Trusted session context and output freshness | Pending qualification |  |
| CAP-03 Canonical transcript ledger and correction propagation | Available |  |
| CAP-04 Licensed cloud speech and provider identity | Pending qualification |  |
| CAP-05 Meeting capture resilience and per-source readiness | Pending qualification |  |
| CAP-06 Meeting durability and saved-meeting integrity | Pending qualification |  |
| CAP-07 Notes, recap, structured decisions, follow-up drafts | Pending qualification |  |
| CAP-08 Multilingual meetings and translation | Pending qualification |  |
| CAP-09 Live copilot intervention | Pending qualification |  |
| CAP-10 Screen context authorization and lifecycle | Available |  |
| CAP-11 Overlay surface, placement, loader and transitions | Available |  |
| CAP-12 Permissions and the guided grant helper (macOS and Windows) | Pending qualification |  |
| CAP-13 Onboarding, teaching and role interview | Pending qualification |  |
| CAP-14 Settings, settings registry and config migrations | Pending qualification |  |
| CAP-15 Hold-to-talk gestures and voice turn | Available |  |
| CAP-16 Voice actions: intent, catalog, confirmation, readback | Available |  |
| CAP-17 "Hey Métis" wake word | Pending qualification |  |
| CAP-18 Spoken replies and continuous conversation | Pending qualification |  |
| CAP-19 Interactive voice robustness and model routing | Available |  |
| CAP-20 Dictation sessions and target-bound insertion | Pending qualification |  |
| CAP-21 Dictation quality, cleanup, drafting, dictionary, recovery | Available |  |
| CAP-22 Durable tasks, grants, queues, steering | Available |  |
| CAP-23 Scoped external handoff | Pending qualification |  |
| CAP-24 Native computer control | Pending qualification |  |
| CAP-25 Visual marks, annotations and walkthroughs | Available |  |
| CAP-26 Persistent assistants and conversations | Pending qualification |  |
| CAP-27 Home workspace, notch peek and indicators | Pending qualification |  |
| CAP-28 Artifacts, attachments, previews and export | Pending qualification |  |
| CAP-29 Memory and enterprise knowledge | Pending qualification |  |
| CAP-30 Account-aware connectors and governed MCP | Pending qualification |  |
| CAP-31 Routines | Pending qualification |  |
| CAP-32 Read-only suggestions and quiet mode | Pending qualification |  |
| CAP-33 Entitlements, meters and usage ledger | Pending qualification |  |
| CAP-34 Operator zero-config and team admin | Pending qualification |  |
| CAP-35 Privacy, data rights, credentials and diagnostics | Pending qualification |  |
| CAP-36 Teams auto-join | Not in 2.12 | Needs a Teams tenant and an app registration. Unblock: Provide a Teams test tenant and app registration, and record the auto-join decision. |
| CAP-37 Lean core and optional components | Pending qualification |  |
| CAP-38 Updates, rollback, single instance, platform support | Pending qualification |  |
| CAP-39 Performance, accessibility and quality budgets | Pending qualification |  |
| CAP-40 Release qualification, disposition and audit | Pending qualification |  |
| NB-01 Approved mode skills | Available |  |
| NB-02 Team skill sharing | Not in 2.12 | Not in 2.12. |
| NB-03 Application teaching packs | Not in 2.12 | Walkthroughs fall back safely without packs. |
| NB-04 Typed questions never capture the screen | Available |  |
| NB-05 Voice memory | Not in 2.12 | Follows the memory capability. |
| NB-06 In-app purchase and commerce | Not in 2.12 | Billing provider not chosen. Unblock: Choose the billing provider. |
| NB-07 Native Swift client | Not in 2.12 | Deferred after 2.12. |
| NB-08 Public meeting projection | Not in 2.12 | Planned for 2.13. |

- Not run: CAP-04 Licensed cloud-speech session on staging
- Not run: CAP-05 Physical microphone, system audio, Bluetooth and sleep checklist on a Mac
- Not run: CAP-10 Screen Recording revoke and grant on a Mac
- Not run: CAP-11 Display scaling and sleep on real displays
- Not run: CAP-12 Permission grant checklist on an installed build
- Not run: CAP-15 Physical key chord check
- Not run: CAP-16 Real Notes and Photo Booth actions
- Not run: CAP-17 Wake-word accuracy and CPU on reference hardware
- Not run: CAP-18 Barge-in on real speakers and headphones
- Not run: CAP-19 Bluetooth device loss
- Not run: CAP-20 Insertion into other apps with Accessibility granted
- Not run: CAP-20 Installed Windows run
- Not run: CAP-24 Native control in real target apps
- Not run: CAP-25 Multi-display and screen sharing
- Not run: CAP-27 Display hot-unplug
- Not run: CAP-29 Server memory rows
- Not run: CAP-30 Controlled Microsoft 365 test accounts
- Not run: CAP-31 Real sleep and wake cycles
- Not run: CAP-34 Operator deployment and SSO sign-in
- Not run: CAP-35 Live Entra consent and refresh
- Not run: CAP-38 Installed Windows runs
- Not run: CAP-39 Reference-hardware measurements
<!-- availability:end -->
