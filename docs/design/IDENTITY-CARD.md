---
project: Métis
type: identity-member-pass-contract
product: Métis member pass + license foundation
status: binding — implement to this file only
accent: "#7F00DA"
accent-name: Mantu Bright Purple
---

# Métis Member Pass

This is the design and architecture contract for the Settings identity surface.
UI code implements this file. It does not invent a second visual language.

Taste references (not clones): Apple Wallet pass, Apple Card, Apple Account
device card, and a 3D interactive identity card that turns in the hand.
Never clone Vibe Island wording, pixel art, 8-bit type, or layout.

## Managed activation amendment — 2026-09-12

MQA-304 supersedes the phase-one activation-unavailable copy and key/import controls below.
Settings → Identity now uses the same verified Operator licence activation as Settings → Privacy.
The member pass receives only the confirmed tier and device identity, never the raw licence token.
An activated managed seat displays Métis or Métis Light instead of the unrelated legacy Personal state.
Do not restore the unavailable legacy activation form. Offline licence parsing remains a separate
backend capability; file presence alone must never imply a verified managed seat or funded AI readiness.

## One accent

The only chromatic accent is **Mantu Bright Purple** `#7F00DA`.

| Token | Value | Use |
|---|---|---|
| `--pass-accent` | `#7F00DA` | Primary fill, focus ring wash, chip, Activate |
| `--pass-accent-bright` | `#A64DFF` | Specular kiss on the metal edge only |
| `--pass-accent-text` | `#B388F0` | Small labels on dark glass (AA) |
| `--pass-accent-soft` | `rgba(127, 0, 218, 0.18)` | Soft wells, focus wash |
| `--pass-ink` | `#FFFFFF` | Primary type on the card |
| `--pass-ink-2` | `rgba(255, 255, 255, 0.78)` | Secondary type |
| `--pass-ink-3` | `rgba(255, 255, 255, 0.56)` | Captions, pending |
| `--pass-metal` | `#C4B8D4` | Thin edge highlight |
| `--pass-metal-dark` | `#2A1840` | Edge shade |
| `--pass-glass` | `#1A0033` | Card body (Mantu Dark) |
| `--pass-glass-lift` | `#291050` | Raised inner well |
| `--pass-danger` | existing `--cl-destructive` | Activation errors only |
| `--pass-ok` | existing `--cl-success` | Licensed state only |

Do not introduce a second accent. No cyan, no gold, no rainbow foil, no
generic AI purple-to-pink gradient wash across the card face.

## Type

| Role | Face | Size | Weight | Features |
|---|---|---|---|---|
| Wordmark | Geist | 15px | 600 | tracking `-0.02em` |
| Eyebrow | Geist | 10px | 500 | uppercase, tracking `0.16em` |
| Member number | Geist Mono | 28px | 500 | `font-variant-numeric: tabular-nums` |
| Serial | Geist Mono | 12px | 500 | tabular-nums, grouped |
| Device / date | Inter | 12px | 500 | regular body |
| Caption | Inter | 11px | 400 | `--pass-ink-3` |
| License state | Geist | 13px | 600 | |

Never use pixel, 8-bit, or display novelty faces. Numbers that identify
(serial, member number, seats) are always tabular.

## Surfaces

The pass is a physical object on a dark Settings pane.

- Ratio: ISO ID-1, **1.586 : 1** (width / height). Width 100% of the
  content column, max **360px**. Centered.
- Radius: **18px** outer. Inner content inset **18px**.
- Body: Mantu Dark `#1A0033` with a *single* faint purple lift toward
  the top-left (not a gradient hero). Opacity stays high enough to read.
- Edge: 1.5px metal rim. Light at top (`--pass-metal`), shade at bottom
  (`--pass-metal-dark`). This is the "machined plate" cue.
- Chip: a 22px constellation-M mark, top-left, not a payment-chip clone.
- Sheen: one specular ellipse that **tracks the pointer**. White at 18%
  over the accent at 10%. Never a looping rainbow.
- Shadow: `0 18px 40px rgba(0, 0, 0, 0.45), 0 2px 12px rgba(127, 0, 218, 0.16)`.

Settings chrome around the pass stays the existing `.cl-*` system.
Do not restyle the tab bar, About you, or shortcuts in this change.

## Anatomy

### Front (identity)

```
[ mark ]                         MEMBER
Métis

Nº  1284                         or  Nº  pending

THIS DEVICE
MacBook Pro · C02X · 1841 · KQ8L
Installed 19 Mar 2026
```

- Front is identity only. No Activate control on the front.
- Member number is the hero. If the register has not assigned one,
  show the word **pending**. Never invent a number. Never show `0`,
  `#1`, or a random count.
- Serial is grouped in fours with a middle dot (` · `). If the OS
  cannot supply a hardware serial, label the row **Install ID** and
  show the stable local install id grouped the same way. Never label
  a fallback as a serial.
- Date is human: `Installed 19 Mar 2026`. Persist the first-seen
  timestamp forever. Never rewrite it.

### Back (license face)

```
LICENSE
Personal                         (or Pro / Enterprise)

Activation is not open yet.
A key you enter is checked,
then returned unused.

[ license key field ]
[ Activate ]

Air-gap file                     Not open yet
```

- Back is the license face of the same physical pass.
- State reads **Personal** when unlicensed. That is a finished state,
  not an empty hole.
- Activate is a real, finished control (accent fill, honest label).
  It is not a grey dead button. Pressing it runs the real client path.
- While `LICENSE_ACTIVATION_OPEN=false`, the honest result is
  `ActivationUnavailable`. The UI says so. It never pretends success.

### Below the pass (Settings · Identity)

A short caption under the card:

> This is your Métis member pass. Drag to turn it over. Arrow keys
> or Space also flip it.

Then the existing Profile sections, in this order:

1. The pass (hero, no Section chrome)
2. License (status + Activate, same finished control as the back)
3. About you (unchanged)
4. Keyboard shortcuts (unchanged)

The Profile tab is labeled **Identity**. Tab id stays `profile`.
Do not add a tenth tab.

## Motion

Spring only. No linear 3s infinite rotate as the hero.

| Gesture | Behaviour |
|---|---|
| Pointer over | Tilt `rotateX` ±8°, `rotateY` ±12°, spring (`stiffness 180`, `damping 22`) |
| Drag | Accumulate `rotateY` through 360°. Cross ±90° to show the back. |
| Release | Spring to the nearest face (0° or 180°) |
| Arrow / Space | Flip to the other face |
| Focus | Accent ring, 2px, offset 4px |
| Sheen | Specular ellipse follows pointer (same spring) |

Reduced motion (`prefers-reduced-motion: reduce`):

- No tilt, no sheen travel, no spring spin.
- The pass is static.
- Tap, click, Space, or Arrow flips instantly (or 160ms ease, no bounce).

Perspective: `1200px`. Transform origin: center.

## Copy

Original Métis. No em dashes in sentences. No "Activate your vibe".
No "island". No "edition card". Do not identify as AI.

| Situation | Copy |
|---|---|
| Caption | This is your Métis member pass. Drag to turn it over. |
| Reduced-motion caption | This is your Métis member pass. Tap the pass to turn it over. |
| Member pending | pending |
| Serial missing | Install ID (never "Serial") |
| Unlicensed | Personal |
| Licensed personal | Personal |
| Licensed pro | Pro |
| Licensed enterprise | Enterprise |
| Activation closed, idle | Activation is not open yet. A key you enter is checked, then returned unused. |
| Activation closed, after Activate | Activation is not open yet. Métis checked the key and did not apply it. |
| Empty key | Enter the license key you were given. |
| Tampered / invalid cache | Personal. The saved license could not be verified. |
| MDM file present | A managed license file is on this Mac. Activation is not open yet. |
| Air-gap picker | Choose a license.metis file. Activation is not open yet. |
| VoiceOver name | Métis member pass. Member {n or pending}. {device}. License {state}. |

## Light / dark

Settings is dark Mantu purple-black today. The pass matches that pane.
If a light Settings theme ships later, invert ink and keep the same
accent. Do not invent a light pass in this change.

## Accessibility

- The pass is a single `role="button"` with `tabIndex={0}`.
- `aria-label` names member number, device, and license state.
- `aria-pressed` reflects the back face.
- Focus ring uses `--pass-accent-text` (AA on the dark pane).
- Reduced motion is honored as specified above.
- The Activate field has a visible label. Errors are text, not color alone.

## Do

- Metal / glass. Thin edge. One accent. Tabular numbers.
- Honest pending. Honest ActivationUnavailable.
- Pointer-follow sheen. Spring tilt and spin.
- Read from local identity in well under 16ms (already on disk).

## Do not

- Clone Vibe Island art, type, layout, or words.
- Purple-to-pink hero gradients, emoji, or stacked card-in-card.
- Fake member counts, fake serials, or silent no-op Activate.
- Store a raw license key in `settings.json`.
- Send a raw serial, key, or member number anywhere in this change.
- Touch overlay chrome, ControlPill, island geometry, onboarding,
  MCP, ASR, portal, music, or CSP.

---

# Architecture (locked)

One license product. This extends `src/main/license.ts` and
`license-server/`. It does not create a second license system.

## Offline-first signed license

- Format: compact JWS, `alg: EdDSA` (Ed25519).
- Public key(s) live in the app, keyed by `kid`.
- Private key never ships in the client.
- Verify in the Electron **main** process only.
- Renderer receives identity snapshot + license status DTOs only.

### Claims

```
{
  "iss": "metis-license",
  "sub": "<deviceIdHash>",
  "edition": "personal" | "pro" | "enterprise",
  "seats": 1,
  "exp": 1775000000,
  "nbf": 1740000000,
  "iat": 1740000000,
  "features": ["overlay"],
  "orgId": "org_…",          // enterprise only
  "kid": "metis-2026-1",
  "graceDays": 14
}
```

`graceDays` defaults to 14 when omitted. Heartbeat is specified now
(daily, non-blocking) and is not started in this change.

## Client API (main)

```
activate(key) -> MemberActivateResult
deactivate() -> MemberLicenseStatus
status() -> MemberLicenseStatus
verifyCached() -> MemberLicenseStatus
```

`LICENSE_ACTIVATION_OPEN=false` in this change. Server calls go through
a real `LicenseClient` interface. The closed implementation returns
`activation_unavailable` and does not write a licensed cache. Typing a
key and pressing Activate must hit this path. Never a silent no-op.
Never `{ ok: true }`.

When the flag later flips to true, the same interface POSTs
`/v1/licenses/activate`.

## Server contract

Documented in `docs/license-v1.openapi.yaml` and
`src/shared/license-types.ts`. Reserved on `license-server/` now.

`POST /v1/licenses/activate`

```
{ "licenseKey", "deviceIdHash", "appVersion", "os" }
→ compact JWS with the claims above
```

`POST /v1/installs/register`

```
{ "installId", "appVersion", "os" }
→ { "memberNumber": 1284 }
```

This change does not deploy a live license server. Existing
`/activate` `/heartbeat` `/deactivate` phone-home routes stay as they
are. Enforcement stays compiled off (`LICENSE_ENFORCEMENT=false`,
`LICENSE_UI_ENABLED=false`, MQA-068).

## Device identity (local)

| OS | Serial | Model |
|---|---|---|
| macOS | `IOPlatformSerialNumber` | `hw.model` |
| Windows | BIOS serial, else `MachineGuid` | `Win32_ComputerSystem.Model` |
| Linux | DMI product serial when real | DMI product name |

If serial is missing, empty, or a known placeholder (`None`, `To be
filled by O.E.M.`), show the stable install id. Never crash. Never
invent a serial.

Display: grouped serial, or last-4 when the value is a UUID-length
privacy-sensitive id. Full serial stays on device. Future activation
sends `SHA-256("metis-device-v1" || serialOrInstallId || platform)`
only. This change sends nothing.

`getMachineId()` (existing `machine-id.txt`) remains the phone-home
seat id. The member-pass install UUID is a sibling file
(`identity.json`) and is not a second seat counter.

## Install date

`identity.json` → `installedAt` ISO timestamp, written once, never
rewritten. Card shows `Installed D Mon YYYY`.

## Member number

1. Local install UUID immediately.
2. Reserved `POST /v1/installs/register` returns a sequential Métis
   number.
3. If the server is down or the endpoint is not live: show **pending**.
   Never invent a number. Last-write-wins of a fake counter is forbidden.
4. Cache the assigned number once received. Never overwrite a real
   number with pending.

## Storage

- Identity (install id, date, member number): `identity.json` in
  userData, mode `0o600`. Not a secret.
- License cache (compact JWS + metadata): OS secret store.
  Packaged: macOS Keychain / Windows DPAPI via `safeStorage`.
  Dev / Linux CI: existing file-backend (`encryptSecret`).
- Never persist a raw license key in `settings.json`.

## Air-gap and MDM

- Parser + Ed25519 verify for a `license.metis` file (compact JWS or
  `{ "jws": "..." }`) ship now.
- File picker may be present. While activation is closed it returns
  `ActivationUnavailable` after a real parse.
- MDM path (documented, optional):
  - macOS: `/Library/Application Support/Métis/license.metis`
  - Windows: `%ProgramData%\Métis\license.metis`
  - Linux: `/etc/metis/license.metis`
- If a file is present, the card says so. The file is not required.
  Presence is not a license.

## Enterprise (schema now, UI later-lite)

- Seats: N concurrent devices, deactivate-to-move.
- `edition` distinguishes personal keys from org licenses.
- No Lemon Squeezy or Stripe wiring.
- Seat UI beyond the number on the license face is out of scope.

## Security

- Renderer never sees private keys or raw cached JWS.
- Missing or invalid cache → `Personal` / Unlicensed. No crash.
- No telemetry of serial, key, or member number in this change.
- Existing phone-home `licenseKey` settings field is not used by the
  member-pass Activate path.

## Performance

The card renders from the identity snapshot already on disk. No
network on Settings open. Register-install is fire-and-forget and
never blocks first paint.

## Tests (required)

- Verify a valid Ed25519 JWS.
- Reject tampered payload / signature.
- Reject unknown `kid`.
- Honor the 14-day grace window; reject past grace.
- `activate()` returns `activation_unavailable` while the flag is false.
- Hashed device id is stable for the same inputs.
- Install date is immutable.
- Member number stays pending until a real assignment; assigned
  numbers are cached and not invented.
- Card flip / tilt respects reduced motion.
- Existing `license.test.ts` and MQA-068 stay green.
