# Métis 2.0 Computer Capability Map

**Status:** Proposed expansion. This is an implementation boundary, not a claim that every capability exists today.

## Product brief

Build Métis as a fast, cross-platform command companion for macOS and Windows. A person can summon it by a separate keybind, explicit push-to-talk, and later an opt-in local “Hey Métis” wake phrase. It understands requests such as “open Chrome,” “show my notes,” or “close that window,” resolves only locally known targets, shows a concise proposed plan, and performs no external action until the person visibly confirms it.

The interaction should feel immediate and calm: a compact top pill at Top Center and a fixed, left-opening sidecar at Right Edge. It must not re-use meeting audio, change the window size while streaming, upload ambient audio, or turn model text into unrestricted shell, AppleScript, PowerShell, browser debugging, or accessibility automation.

## The compositional model

Métis does not enumerate an unbounded list of commands. It resolves each request through:

```
intent × installed target × supported capability × permission × current state
  → bounded plan | clarification | unavailable explanation
```

The shared TypeScript core owns intent parsing, target identity, policy, proposal state, confirmation, outcome classification, and audit minimization. Platform adapters carry out only typed operations. They never accept model-produced commands, paths, scripts, selectors, or executable text.

## Action taxonomy

| Category | Examples | Authority |
| --- | --- | --- |
| Métis navigation | Show transcript, action items, Settings, local meeting notes | Immediate |
| Cancellation and privacy | Stop listening, dismiss, cancel plan, pause wake listening | Immediate |
| Local answers | Search already-authorized local Métis material | Immediate within existing data permissions |
| App lifecycle | Open, focus, or request normal quit for a resolved app | Visible confirmation |
| Window arrangement | Minimize, restore, maximize, place a resolved window | Visible confirmation |
| Browser navigation | Open an approved HTTPS location or search a selected provider | Visible confirmation |
| Drafting and notes | Create or append a note, draft an email, prepare an export | Exact destination/content preview and confirmation |
| Files and meeting operations | Open a selected file, start recording, capture screen, export/share | Confirmation plus applicable consent/permission |
| Browser/app interaction | Act on a fresh, reviewed control in a selected scope | Future, one reviewed step at a time |
| Transactions and sharing | Send, post, purchase, submit, upload, change account/security settings | Never automatic; retain human final step |
| Credentials and elevation | Passwords, OTP, password managers, UAC, grants, security bypass | Human-only |
| Unbounded execution | Arbitrary shell/AppleScript/PowerShell/JavaScript, unknown install, force quit fallback | Unsupported |

“Close Notes” must distinguish closing a window from gracefully requesting application quit. Métis never force-quits as a fallback and must let the operating system preserve Save/Discard decisions.

## Intent and target contracts

Initial intents are bounded and typed:

```ts
type Intent =
  | { kind: 'app.open'; app: AppReference }
  | { kind: 'app.focus'; app: AppReference; window?: WindowReference }
  | { kind: 'app.quit'; app: AppReference; mode: 'graceful' }
  | { kind: 'window.close'; window: WindowReference }
  | { kind: 'window.arrange'; window: WindowReference; position: 'left' | 'right' | 'maximize' | 'restore' }
  | { kind: 'web.search'; query: string; browser?: AppReference }
  | { kind: 'web.navigate'; url: string; browser?: AppReference }
  | { kind: 'note.create'; destination: NoteDestination; title: string; body: string }
  | { kind: 'note.append'; note: NoteReference; text: string }
  | { kind: 'metis.show'; view: 'notes' | 'transcript' | 'actions' }
  | { kind: 'command.cancel' }
```

`ApplicationCatalog` discovers registered applications locally and caches opaque stable identities. It supports user aliases such as “my browser” and “work chat,” but preserves ambiguity: two valid “Notes” targets require a clarification. A display name is untrusted text, never shell input. No implicit substitution is allowed, such as using Notepad when the person asked for Apple Notes.

## Execution architecture

```
keybind / push-to-talk / gated local wake
  → command-only transcript
  → deterministic intent + slots
  → local catalog resolution
  → capability and policy check
  → visible proposed plan
  → main-owned confirmation nonce
  → typed platform adapter
  → observed postcondition
  → verified | uncertain | failed | cancelled outcome
```

- `CommandSession` owns source provenance, revision, cancellation, and deadlines.
- `CapabilityRegistry` defines supported operations and required permissions.
- `PlanBuilder` records preconditions, affected target, consequences, and expected postcondition.
- `PolicyEngine` enforces approval, enterprise restrictions, and sensitive scopes.
- `Executor` performs one bounded step at a time.
- `OutcomeVerifier` distinguishes dispatch from achieved outcome; an uncertain non-idempotent action never retries automatically.
- `AuditSink` records minimized metadata only: action kind, opaque target, outcome, and latency. It excludes raw voice, content, screenshots, DOM, credentials, and typed secrets by default.

Optional Jev-style model decisioning may rank already-valid candidates through the portal broker. It must receive bounded text and candidate IDs only. It cannot invent a target, capability, executable input, browser selector, permission, or action plan.

## Platform boundary

| Capability | macOS | Windows | Gate |
| --- | --- | --- | --- |
| Global summon | Electron shortcut | Electron shortcut | collision feedback |
| App launch and focus | registered bundle identity | Start-menu/AUMID or resolved app identity | target revalidation |
| Graceful quit | normal application termination | normal close path | preserve unsaved-work flow |
| Window control | permissioned accessibility helper | signed Win32/UIA helper | fresh target and OS permission |
| Note creation | selected provider integration | selected provider integration | no universal Notes assumption |
| Browser navigation | selected browser | selected browser | explicit browser/domain |
| Browser DOM interaction | scoped integration | scoped integration | selected tab, fresh observed control |
| Local wake | gated model worker | gated model worker | packaged acoustic and resource tests |
| Mobile control | not in this release | not in this release | separate authenticated companion design |

Native helpers, where Electron lacks a needed capability, are signed, run without elevation, authenticate a private typed request channel, and expose no arbitrary script facility.

## Permissions and privacy

Permissions are staged, not implied by a licence:

1. Microphone for explicit command input.
2. Optional local wake listener.
3. Installed-app catalog discovery.
4. Per-app execution consent.
5. Screen/accessibility only when a requested capability needs it.
6. Separate browser, tab, file, or folder consent.

Meeting, import, cloud-STT, screen/OCR, browser DOM, and Mantu Intelligence sources never become command authority. A wake phrase only opens a command session. It does not prove speaker identity or authorize execution.

## Delivery order and gates

1. **Microphone and transcript reliability** — physical internal/headset/Bluetooth tests at 16, 44.1, and 48 kHz; language, quiet speech, mute/unmute, device change, and app-name fixtures.
2. **Catalog and capability foundation** — Chrome, Notes, and Word plus unknown/duplicate names resolve honestly on both systems.
3. **Safe general app actions** — open, focus, graceful close, search, and navigation with observed outcome and no implicit substitutions.
4. **Notes and meeting workflows** — Métis notes first, then explicitly selected providers without duplicate creation.
5. **Permissioned window/app operations** — signed helpers, no elevation, fresh target checks, cancellation, and unavailable-state disclosure.
6. **Bounded multi-step plans** — one external step per approval with divergence stops.
7. **Browser Assist** — user-selected tab/domain, private-field exclusion, stale-target rejection, and no automatic submission.
8. **Local wake activation** — only after packaged macOS/Windows acoustic accuracy, false-wake/miss, CPU/RAM, meeting coexistence, and privacy gates pass.
9. **Mobile** — separate product and companion-client scope.

## Definition of done for expansion

No capability is called complete merely because an adapter dispatched an OS request. It needs typed unit tests, policy/confirmation tests, integration verification of its postcondition, signed packaged macOS and Windows tests, and an explicit unavailable path when the system cannot verify the result.
