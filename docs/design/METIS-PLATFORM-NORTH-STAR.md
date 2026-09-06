---
project: Métis
type: platform-north-star
owns:
  - one product story across overlay + Operator + native
  - install-to-first-ask path
  - trust boundary (Access, seat APPROVAL, vault last4, HMAC)
  - desktop-agent vs Operator-agent sequencing (board R01–R22)
  - Apple Private Cloud Compute seam (design now, implement last)
does-not-own:
  - overlay chrome paint (Hide 8×2, Island 132×15, Bar 880)
  - thinking-orbs renderer internals
  - Fly license-server payments
  - leftover Intelligence PR 61
  - installer packing / version bump
  - Goldberg Aria
ready-to-merge: no
audience: Tony Walteur
accent: "#7C8CF8"
pass-accent: "#7F00DA"
iron-law: subtract before you add. Intent first. No overengineering. Evidence-grounded.
---

# Métis platform north star

Tony's challenge: make this very beautiful, scalable, solidly secure, and user-friendly.

This file is the one platform story. Slice contracts stay the law for their pixels. This file is the law for how those slices become one product a stranger can install and a fleet of ten thousand can later join.

**READY TO MERGE: no.** Design only. No product code in the change that lands this file.

---

## 1. Intent

Métis is the wisdom before the moment. A person opens a meeting. The overlay is already there, quiet, Apple-grade. They press Listen and tell the room. They Ask. The answer lands. Nothing was configured that they did not already own.

Tony holds the platform. Seats do not hold his cloud keys. Operator is how he sees the fleet, funds Asks, and approves who may spend. Native Apple is how a Mac Ask can later cost ~zero. Electron stays the Windows and cross-platform path.

Three feelings, in this order:

1. **It just works.** Install → first Ask. Defaults friendly. Power lives in Settings.
2. **It never lies.** Connected means a live session. last4 is all the UI ever sees. Latest is a QA+Ultron fact, not a CI hope.
3. **It recedes.** Hide until the camera square. Island until the camera square. Bar if they asked for a bar. Settings never crushed into the menu-bar. No white flash. No leftover 880×133 at Y=39.

If a change serves none of those three, subtract it.

---

## 2. One product, two planes

```
                    Tony (two emails)
                            │
                            │  Cloudflare Access
                            ▼
                 ┌─────────────────────┐
                 │  Operator           │
                 │  metis-operator     │
                 │  keys · seats · map │
                 │  skills · CRM board │
                 └──────────┬──────────┘
                            │
              HMAC ingest / heartbeat / manifest
              (not Access; never a password page)
                            │
          ┌─────────────────┴─────────────────┐
          │                                   │
          ▼                                   ▼
   Electron overlay                    Native (LAST)
   macOS DMG + Windows EXE             SwiftUI App Store
   Hide / Island / Bar                 on-device FM + PCC seam
   CLI-first when licensed             ~zero API cost path
```

| Plane | Job | Who sees it |
| --- | --- | --- |
| Overlay | Daily product. Ask, Listen, Capture, Review, Brain. | Every seat. |
| Operator | Control plane. Keys, approval, cost, skills, CRM retry. | Tony only. |
| Native | Apple flagship. Foundation Models now, PCC later. | Apple-device seats, after Electron is honest. |

There is no third plane. Intelligence is a local dashboard a seat already has. `license-server` on Fly is seats and leases, not prompts. `cloudflare-proxy` is the AI token proxy, not the ops console. Do not merge them.

Evidence: `docs/PLATFORM-MAP.md`, `docs/design/OPERATOR.md`, `docs/design/DESIGN.md`, `native-app/README.md`.

---

## 3. Beauty — the overlay a stranger cannot unsee

The overlay is not a website with a floating bar. It is a being that lives at the top of the display and stays out of the way.

### 3.1 Three chrome layouts, one picker

Layouts stay `hide | island | bar`. Default is **Hide**. Fresh install: invisible until the camera / Dynamic Island square. Island is a 132×15 peek at the same Y. Bar is the 880 glass bar plus the Jakub circle.

This is frozen law. `overlayAllowsMinimize`, `overlayShowsBarOrb`, `overlayDocksBarCircle` live in `src/shared/overlay-chrome.ts`. Hide and Island never grow a minimize control, never show a circle, never jump to Bar to display an orb.

Hover hit is the camera square only (`notchWidth` ~180–250, housing height, not 44, not 560). Left menu-bar items miss. Teams mute / camera / share at Y≈40 and `TEAMS_MEETING_CHROME_Y` 48 miss. Main cursor-watch on darwin and Windows top-edge is the reveal; renderer `mouseenter` is not enough.

Park Hide at 8×2 and Island at peek, both at `display.bounds.y` (0 on the built-in Retina). Never park at `workArea.y` (~39). An 880×133 leftover at Y=39 is a fat hover trigger (`isFatHoverTrigger` in `src/shared/settings-bounds.ts`). MQA-289.

### 3.2 Bar rest is a power choice

A second picker, Settings → Appearance → **Bar rest**, only applies when chrome is Bar.

| Card | Persist | Feel |
| --- | --- | --- |
| Full bar | `overlayOrbStyle: 'bar'` | Default. 880 bar. Jakub orb docked. |
| Circle | `'jakub'` | Jakub `solving` idle, 41 visible, canvas 64, 2× backing. Minimize-to-circle is this circle. |
| Obsidian | `'obsidian'` | Dark disc, electric-cyan spark, purple rings. Same 41 host. CSS + optional 2D canvas. No WebGL. |

Unknown / missing / locked-absent → `'bar'`. Hide and Island ignore the key. No reinstall. Change applies immediately.

Obsidian matches the Obsidian Graph View reference. Not Fit Studio magenta. Not Jarvis `#4CA8E8`. First paint is CSS. Reduced-motion is a static representative frame. No caption.

Contracts: `docs/design/BAR-PILL.md`, `docs/design/ORB-SELECTION.md`, `docs/design/THINKING-ORB.md`, `docs/design/QUALITY.md`.

### 3.3 Settings is a surface, not a leftover

Opening Settings from tray, dock, hotkey, or IPC applies `applySettingsSurface` first: **880×560** minimum at `islandSafeTop`, background `#120022`. Never Hide 8×2. Never Island peek. Never a crushed Modes & Display strip (MQA-286).

Closing Settings `leaveSettingsSurface` then parks. Hide/Island force-park on became-idle (`shouldForceParkOnBecameIdle`). Forbidden flash colors: `#fff`, `#ffffff`, `#000`, `#000000` (MQA-288). Rest stays `#00000000`.

The Identity pass lives here (`docs/design/IDENTITY-CARD.md`). One Settings accent for the pass: Mantu Bright Purple `#7F00DA`. Overlay chrome keeps indigo `#7C8CF8`. Do not wash the bar in pass purple.

### 3.4 Defaults friendly, power in Settings

| Default | Why |
| --- | --- |
| Overlay Hide | Invisible until intent. |
| Bar rest Full bar | Circle and Obsidian are opt-in. |
| Provider Cloudflare | One operator endpoint. Embedded proxy key when the pack seeds it. |
| `providerPriority: 'api'` | CLI-first is a live promotion when a CLI session is actually connected, not a Settings trap. |
| `localLlm.enabled: false` | Local is power. Weights may warm; they do not preempt. |
| `encryptTranscripts: true` | Fail closed on disk. |
| Listen off until press | Tell the room. Nothing captured before that. |
| Operator URL empty | No phone-home until Tony points the seat. |

Onboarding already names the ready provider (MQA-263, MQA-279). Do not invent a seventh Act. Do not restyle starfield, Aria, or portal video in a platform PR.

### 3.5 What beauty is not

No purple-gradient hero. No emoji UI. No fourth overlay layout. No WebGL marble. No floating orb on Hide. No Settings that opens as a menu-bar sliver. No flash. Would Apple ship this overlay? Only if every hat in `QUALITY.md` still PASSes.

---

## 4. User-friendly — install, then it answers

The product promise is one sentence: **a licensed person installs Métis and Asks without pasting Tony's keys.**

### 4.1 The path

```
Download (Metis-Releases, not the private source repo)
        │
        ▼
Install (dmg / Install Metis.command / NSIS / portable)
        │
        ▼
Onboarding (six acts, skippable; Listen consent is explicit)
        │
        ▼
First Ask
   1. Connected Claude CLI or Codex CLI, if they already have a license
   2. Operator-funded cloud (NIM / Anthropic / DeepSeek / Cloudflare) if the seat is APPROVED
   3. Manual key the user pasted (power fallback)
   4. Métis Local / Apple FM if they turned it on
   5. Honest empty: Connect an AI provider in Settings → AI
```

Dust is never step 2 for general chat. Dust is retrieval: Spotlight Ref, second brain, published wiki. `--with-tools` stays off. Never auto-send.

### 4.2 Operator holds the platform keys

Tony pastes NIM, Anthropic, DeepSeek, and the Cloudflare account token on Operator `#keys`. UI shows **last4 only**. AES-GCM at rest (`OPERATOR_VAULT_KEY`). Allowlist:

- `tony.walteur@gmail.com`
- `twalteur@amaris.com`

Heartbeat returns `fundedProviders` to an **APPROVED** seat. The seat keeps that list in memory. The renderer never sees a raw key. `hasKeys` booleans and last4 are the only public facts.

Forbidden in the vault: `claude-cli`, `codex-cli`, `dust`, `local`. Those are seat sessions, not Tony's spend.

Manual keys remain the power fallback in Settings → AI. Paste, Save, encrypted via `safeStorage` / DPAPI. `setApiKey` / `clearApiKey` / `testApiKey`. No `getApiKey` on preload.

### 4.3 CLI-first when the user already paid

If Claude Code or Codex is installed and the session probe is live, every user question routes there first. Subscription, not Tony's meter.

- Probe is zero-token (`missing` / `signed-out` / `weekly-limit` / `live`). A Claude weekly cap is signed-in, not disconnected. Codex `login status` = Logged in is connected.
- Both CLIs connected: last-clicked is primary, the other is next, then Operator keys.
- Fallback to Operator keys only after quota or rate limit from that CLI.
- Settings CLI Integration stays `installCli` / `loginCli` / `testCli` / `cliConnected`. Kind `cli`. Do not fold CLI tokens into the vault. Strip `ANTHROPIC_API_KEY` when streaming CLI.

### 4.4 CLI install never fakes Connected

`installManagedCli` fetches a pinned npm tarball, checks sha512, unpacks zip-slip-safe into `userData/managed-cli`. Dust then installs production deps with **managed Node + `npm-cli.js`**, never `bin/npm` (Electron PATH has no `node`; that was exit 127, MQA-287).

Fail loud. Human message. Half a tmp package is not Connected. `ManagedNpmMissingError` stays an error. Spawn env drops secrets.

Spotlight Ref invoke: `dust chat --sId GOr913Zr5V -m <prompt>` (or `-a "Spotlight Ref"`). Never `--with-tools`. Agent absent: "The Spotlight Ref agent is not in this workspace." A `view:list` omission is not proof the agent is gone.

### 4.5 Cloudflare is a Worker, not a token on the seat

The account token never ships. Seats talk to `metis-cloudflare-proxy` with a proxy key. Operator may hold the account token for Overview analytics. No CF tokens on seats. Fail loud if the token is missing on Operator: "Cloudflare token missing. Connect it on Keys."

Evidence: `docs/CLOUDFLARE.md`, `docs/design/DESIGN.md` CLI / Dust section, PR 95 / 96 routing law.

---

## 5. Security — subtract the ways to leak

The attack surface that exists: packaged Electron, optional Fly license-server, optional `cloudflare-proxy`, Operator Worker, outbound Graph / MCP / Dust / LLM. There is no cloud notes database. Do not invent one.

### 5.1 Admin is Access only

`/` and `/v1/admin/*` require Cloudflare Access. The Worker also verifies `ctx.access.getIdentity()` and/or `Cf-Access-Jwt-Assertion` JWKS. If Access did not run, admin returns 401 even with a valid ingest HMAC.

No homemade password page as the product gate. No `LICENSE_ADMIN_TOKEN` for this UI. Do not enable "Protect this Worker" for all traffic: ingest must stay HMAC-only.

### 5.2 Seat APPROVAL before platform keys

A heartbeat is not a grant.

```
seat checks in (HMAC)
        │
        ▼
Operator row: pending
        │
        ▼
Tony APPROVE (Access, two emails)
        │
        ▼
heartbeat may return fundedProviders
```

Unapproved seats still run. They use CLI, local, or a key they pasted. They do not spend Tony's vault. Revoke returns the seat to pending-or-blocked and stops `fundedProviders`.

Approval is a column and a button, not a new product. Do not build SSO for every Mantu employee to reach Operator.

### 5.3 Vault last4

Write / rotate / revoke on `#keys`. Events and UI show last4. Ciphertext in D1. Decrypt only on Access-authenticated admin paths. Every reveal is audit-logged (who, when, which key id). Never log the secret. Never put it in a PR body.

### 5.4 HMAC ingest

`POST /v1/ingest`, `POST /v1/heartbeat`, `GET /v1/skills/manifest`:

- Canonical: `${ts}.${nonce}.${deviceId}.${sha256Hex(body)}`
- Headers: `x-metis-ts`, `x-metis-nonce`, `x-metis-device`, `x-metis-sig`
- Skew > 5 minutes rejected
- Nonce one-shot inside a 10 minute window
- 90 requests / device / minute

Same bytes on the Worker (WebCrypto) and Electron (`src/shared/operator-hmac.ts`). Never ingest Listen transcripts, screen captures, audio, or API keys. Ask text only if the Ask-text toggle is on. CRM ingest is id, connector, meeting hash, status, attempt, lastError, latency. Never the recap body. Never a filesystem path. Confidential actions stay unsent.

Geo is `request.cf` only. The Worker ignores client `lat`, `lon`, `country`, `city`, `ip`.

### 5.5 No secrets in the UI

| Fact the renderer may hold | Fact it must not |
| --- | --- |
| `hasKeys[provider]` boolean | The key |
| last4 (Operator admin) | The vault blob |
| `cliConnected` + probe verdict | CLI tokens |
| `fundedProviders` list | A use-token that outlives the ask |
| Operator URL | Ingest secret in a log / screenshot |

`publicSettings` already redacts. Keep it that way. Embedded `METIS_PROXY_KEY` and Cahê Kimi remain documented residuals (`docs/security/AUDIT-20.md`). Do not add new live secrets to the package.

### 5.6 Update / Latest only after QA + Ultron

`electron-updater` reads `latest.yml` / `latest-mac.yml` from `mysticalsin/Metis-Releases`. That feed is a loaded gun.

A tag may build. A build may sit. **Latest advances only after:**

1. QA on the target OS (Devon Mac-show for overlay; Windows pack for EXE).
2. Ultron adversarial pass (the FAIL Worker / QA-file path already in the fleet). Ultron is a veto, not a cheerleader.
3. Tony's explicit publish.

CI does not wrangler-deploy Operator with secrets. CI does not flip Latest because tests are green. Portable EXE never auto-updates; do not pretend it does.

### 5.7 Existing gates we keep

`requireAuth` on privileged IPC. `safeMeetingBasename`. `ATKENC2` transcripts. `encryptSecret` for keys. `redactSecrets` including `nvapi-`, `gsk_`, `xai-`. Content-protection stays a user toggle, not a marketing undetectability claim. License activate stays ungated so SSO cannot deadlock the gate.

---

## 6. Scale — posture for 10k, built for the seats we have

Operator is the control plane for ten thousand seats **later**. The posture is designed now. The machinery is parked until pack.

What "posture" means (mention, do not build):

| Concern | Now | Later (after pack, when seats are real) |
| --- | --- | --- |
| Auth | Access allowlist of two. HMAC devices. | Same split. Per-tenant ingest secrets if a second company exists. |
| Queues | Heartbeat ~60s. Skill poll 6h. CRM `pushQueue` on the seat. | Worker's existing rate limit + nonce window. No Kafka. |
| Caching | Prompt cache always on for supported cloud APIs. Prefix byte-stable. | Same. Cost charts read cache hit rate. Missing usage is "not reported", never fake $0. |
| Observability | Packed Overview: live seats, DAU/WAU, versions, cache, estimated cost, map from `cf`. | Indexes on D1 `deviceId` / `lastSeen`. Honest empty map. |
| Skills | Draft / Approve / Push. ed25519. Never auto-apply a draft. | Same. Push is the scale lever, not a new CMS. |

10k is a capacity story, not a rewrite. D1 + Worker + HMAC already has a shape. Do not add Redis, do not add a second console, do not build a seat SSO so Tony can "delegate." Subtract until pack proves the current plane is the bottleneck.

Prompt caching law (already shipped in spirit):

- Anthropic: last stable system block `cache_control: { type: 'ephemeral', ttl: '1h' }`. On 400, retry default ephemeral.
- OpenAI cloud: `prompt_cache_key = metis:${mode}:${skillLockHash}`. On 400, retry once without.
- Local / llama / Dust / CLI: `cache: 'n/a'`.

---

## 7. Native last — design the PCC seam, do not implement it

Electron cannot honestly ship Private Cloud Compute. Apple gates production PCC to App Store–distributed apps, Swift surface, entitlement `com.apple.developer.private-cloud-compute`, Small Business Program, <2M first-time downloads. The notarized DMG is the wrong channel. Proxying PCC through a companion App Store app into the DMG is off-limits.

So native is last, and the seam is now.

### 7.1 The seam

One interface both products already almost have: **Ask → stream of tokens, with an honest availability reason.**

```
MeetingIntelligence
  availability: available | unavailable(reason)
  suggestStream / summarize / nextSteps
```

Electron today: `createStream` → `wrapEnterpriseStream` (timeout, cancel, retry, redact). Local path already dispatches Apple `fm serve` on macOS 27+ (`src/main/llm/fm-runtime.ts`) and falls back to llama-server. Native today: `MetisKit` `FoundationModelsIntelligence` + `HeuristicIntelligence` (`native-app/MetisKit/Sources/MetisKit/Intelligence.swift`).

The missing piece is a named provider kind `apple-pcc` that:

- Exists only in the native App Store target.
- Is compiled behind `#if canImport` + the entitlement.
- Routes heavier summarize / deep-reason (32k, reasoning levels) when on-device AFM is too small.
- Surfaces quota via `model.quotaUsage` as an honest chip, never a fake $0.
- Never appears in the Electron renderer as a toggle that does nothing.

Electron keeps `fm serve` / llama as the Mac local path. Windows stays llama + Parakeet. Do not promise PCC on the DMG.

### 7.2 Cost story (the reason this exists)

| Path | Who pays |
| --- | --- |
| Claude / Codex CLI | The user's subscription |
| Operator vault (NIM / Anthropic / DeepSeek / CF) | Tony, after APPROVAL |
| Métis Local / on-device AFM | Electricity |
| Native PCC | ~zero API cost, Apple quota |

Native last means: make Electron install→works and Operator keys honest first. Then turn the seam on when the 27 SDK and the entitlement are real. Until then the comment in `Intelligence.swift` is the implementation.

Evidence: `docs/APPLE-INTELLIGENCE-PLAN.md` §3, `native-app/README.md`, `docs/PROVIDER-ROUTING-POLICY.md`.

---

## 8. Failure modes

Every surface fails closed and speaks in a human sentence. No "Something went wrong."

### Overlay chrome

| Failure | What the user sees | What must not happen |
| --- | --- | --- |
| Settings from tray while Hide | Full 880×560 glass | Crushed 8×2 / Island peek |
| Close Settings onto Hide | Park 8×2 at Y=0 | 880×133 at Y=39; Teams mute reveals Métis |
| Pointer crosses menu-bar | Nothing | Flash open/shut |
| White/black window color | Dark glass `#120022` or transparent | `#fff` / `#000` flash |
| Hide + orb style Obsidian | Hide hairline only | Floating circle in the notch |
| Reduced-motion | Static orb frame | Throw |

### Ask / routing

| Failure | What the user sees | What must not happen |
| --- | --- | --- |
| No provider, no CLI, no approval | Connect an AI provider in Settings → AI | Silent hang; fake Connected |
| CLI weekly limit | Still connected; Operator keys if approved | "Disconnected" |
| CLI install exit 127 / missing Node | Loud install error | Connected on a half package |
| Dust used as general chat | Route refuses; retrieval-only | `--with-tools` auto-approve |
| Unapproved seat + no personal key | Same honest empty as no provider | Vault spend |
| Operator URL set, HMAC bad | Ingest 401 in logs; Ask still works locally | Renderer crash; secret in the toast |
| Hung provider | Enterprise timeout, then failover | Forever spinner |

### Operator

| Failure | What Tony sees | What must not happen |
| --- | --- | --- |
| Access missing | 401 | Password page as the product |
| HMAC on `/v1/admin` | 401 | Admin via device secret |
| Vault token missing (CF) | "Cloudflare token missing. Connect it on Keys." | Empty $0 charts pretending to be live |
| No heartbeats | Honestly empty map | Sample visitors |
| Skill draft | Draft stays draft | Auto-push |
| CRM Failed | Retry button | Auto-send from index |

### Updates

| Failure | What happens | What must not happen |
| --- | --- | --- |
| CI green, QA not done | Feed stays | Latest.yml advances |
| Ultron FAIL | Feed stays | "Ship anyway, we can hotfix" |
| Portable EXE | Download a new file | Fake Restart & install |

### Native / PCC

| Failure | What happens | What must not happen |
| --- | --- | --- |
| No Apple Intelligence | Heuristic / llama fallback | Dead Ask |
| PCC quota | Honest chip | Silent cloud spend |
| Electron user on macOS 27 | `fm serve` / llama, not PCC | A Settings toggle that claims PCC |

---

## 9. Acceptance tests per surface

These are the tests a later PR must keep green or add. This file does not add them.

### Overlay (desktop agent)

- `overlayLayout` default `'hide'`. Garbage → `'hide'`.
- `overlayOrbStyle` default `'bar'`. Garbage → `'bar'`.
- Hide/Island: `overlayAllowsMinimize` false; `overlayShowsBarOrb` false; minimize is a no-op.
- Settings from tray / hotkey / IPC: bounds ≥ 880×560 before first paint (`settings-surface.contract.test.ts`).
- Park after Settings: `bounds.y` = display top; `isFatHoverTrigger` catches 880×133 at workArea.y.
- Forbidden flash colors unit-tested.
- Hover hit is the camera square; left menu-bar and Teams Y miss (`hover-hit-band.test.ts`, `mac-hide-island.proof.test.ts`).
- Obsidian markup has disc + spark + rings; reduced-motion freezes.
- Listening toolbar at 880: no intersecting `getBoundingClientRect`; no "+ New meeting" on that row.
- Click expands Bar circle; drag does not.

### Install → works (desktop agent)

- CLI session probe: `missing` / `signed-out` / `weekly-limit` / `live`. Weekly-limit `ok: true`.
- `npmInstallProductionSpawn` is node + `npm-cli.js`. Missing Node throws `ManagedNpmMissingError`. Never Connected.
- Dust chat never passes `--with-tools`.
- `publicSettings` has `hasKeys` booleans and no raw keys.
- Unapproved / no-URL seat: Ask still works with CLI or pasted key.
- Onboarding step 5 names the ready provider (MQA-263).

### Operator (Operator agent)

- Admin without Access: 401 on `/` and `/v1/admin/*`, even with valid HMAC.
- Ingest without HMAC: 401. Skew / replay / rate: rejected.
- `#keys` UI and events: last4 only. CLI / dust / local rejected as vault providers.
- Heartbeat: `fundedProviders` empty until APPROVE.
- Geo from `request.cf` only; client coordinates ignored.
- Empty map if no heartbeats.
- CRM Retry is Access + explicit. Never auto-send.
- Approve does not publish a skill. Push signs.

### Updates (process, both)

- A contract test or runbook step that Latest.yml is not written by the default release job without a QA+Ultron flag. Until that flag exists, humans publish. Do not "automate honesty."

### Native (parked)

- `swift test` keeps 26 green.
- PCC types stay behind the 27 SDK gate. No Electron import.

---

## 10. Board R01–R22 — desktop agent vs Operator agent

This is the sequence. One owner per row. Do not start a later row that needs an earlier one's law. Subtract: if a row is already green on `fix/settings-orb-stability-20260905`, mark it **held** and do not restyle it.

| ID | Slice | Agent | Status on this base | Depends |
| --- | --- | --- | --- | --- |
| **R01** | Overlay law frozen (Hide / Island / Bar predicates) | Desktop | Held — `overlay-chrome.ts` | — |
| **R02** | Settings never crushed from menu-bar (880×560, `#120022`) | Desktop | Held — MQA-286 | R01 |
| **R03** | No flash on launch / Settings open-close | Desktop | Held — MQA-288 | R02 |
| **R04** | Top-edge reveal; park at Y=0; no 880×133 at Y=39 | Desktop | Held — MQA-289 | R01 |
| **R05** | Bar rest picker (Full / Circle / Obsidian) | Desktop | Held on this branch — `ORB-SELECTION.md` | R01 |
| **R06** | CLI install fail-loud; never fake Connected | Desktop | Held — MQA-287 | — |
| **R07** | CLI session probe honesty (weekly-limit is connected) | Desktop | Held in spirit — tighten if any Connect path still bills | R06 |
| **R08** | Dust retrieval-only; Spotlight Ref CLI path | Desktop | Partial — lock routing so Dust cannot be general chat | R06 |
| **R09** | HMAC client (heartbeat / ingest / manifest) | Desktop | Held — `operator-hmac.ts` | — |
| **R10** | No secrets in renderer (`hasKeys`, no `getApiKey`) | Desktop | Held — AUDIT-20 | — |
| **R11** | CLI-first Ask when a live CLI session exists | Desktop | Open — promote live CLI ahead of vault; last-clicked wins | R07, R16 |
| **R12** | Consume `fundedProviders` only after approval; memory only | Desktop | Open | R16, R17 |
| **R13** | Manual keys remain power fallback | Desktop | Held | R10 |
| **R14** | Update / Latest stays human until QA+Ultron | Desktop | Open (process) | R22 |
| **R15** | Access-only admin; path split | Operator | Held — `operator/src/index.ts` | — |
| **R16** | Seat APPROVAL before `fundedProviders` | Operator | Open | R15, R18 |
| **R17** | Vault last4 for NIM / Anthropic / DeepSeek / CF | Operator | Open on this base (PR 95/96 law; not in this tree) | R15 |
| **R18** | HMAC Worker (skew, nonce, rate) | Operator | Held | — |
| **R19** | Scale posture only: queues, cache honesty, empty map | Operator | Held as posture — do not build 10k infra | — |
| **R20** | 10k seats parked until pack | Both | Parked | R19 |
| **R21** | Native PCC seam documented; no Electron toggle | Desktop (native tree only) | Seam exists as comment — do not implement | R11 |
| **R22** | Ultron + QA veto before Latest | Operator (process) + Tony | Open | — |

**Desktop agent** owns R01–R14 and the native comment in R21. Overlay chrome, Settings surface, CLI, Ask routing, HMAC client.

**Operator agent** owns R15–R19, R22, and the vault/approval half of R16–R17. Never restyles Hide/Island/Bar. Never packs.

R20 is a joint non-goal until pack. R14 and R22 are the same gate seen from feed and from veto.

Do not parallelize R11 with R16. A desktop that spends vault keys before approval is a security bug, not a race you can "fix later."

---

## 11. What not to do

- Do not ship product code in the PR that lands this file.
- Do not pack DMG/EXE from a design change.
- Do not flip READY TO MERGE to yes from this document.
- Do not add a fourth overlay layout, a Goldberg Aria retune, or a Hide orb.
- Do not restyle overlay chrome "for Operator density."
- Do not build 10k queues, a second database, seat SSO, or a public Operator.
- Do not put platform keys in the asar, the renderer, or a screenshot.
- Do not mark CLI Connected on a failed npm spawn.
- Do not use Dust as general chat.
- Do not auto-send CRM, Outlook, or MCP. Ever.
- Do not advance `latest.yml` because CI is green.
- Do not implement PCC in Electron. Do not fake a PCC Settings row.
- Do not merge Operator with `license-server` or `cloudflare-proxy`.
- Do not clone Bklit Studio, OpenPanel Pages/Funnels, or Cluely assets.
- Do not invent a cloud notes DB so "RLS" has somewhere to live.
- Do not write a second design system. `DESIGN.md` tokens stay.
- Do not add em dashes to user-facing copy.
- Do not identify as AI in anything the user will say.

---

## 12. Contracts this file does not replace

Implement overlay and Operator slices to those files, not to a paraphrase here.

| File | Owns |
| --- | --- |
| `docs/design/DESIGN.md` | Overlay tokens, surfaces, anti-slop |
| `docs/design/BAR-PILL.md` | Bar circle, no-squash M, 880 toolbar |
| `docs/design/ORB-SELECTION.md` | Bar rest picker + Obsidian |
| `docs/design/THINKING-ORB.md` | Caption then sphere |
| `docs/design/QUALITY.md` | Hats; one REJECT fails the slice |
| `docs/design/OPERATOR.md` | Access, HMAC, packed console, CRM |
| `docs/design/IDENTITY-CARD.md` | Member pass |
| `docs/design/ONBOARDING-STARFIELD.md` | Onboarding bed |
| `docs/PROVIDER-ROUTING-POLICY.md` | Local / API / Auto |
| `docs/APPLE-INTELLIGENCE-PLAN.md` | AFM / PCC facts |
| `docs/CLOUDFLARE.md` | Proxy, not account token |
| `docs/security/AUDIT-20.md` | 20-control gate |
| `docs/PLATFORM-MAP.md` | Three ship targets |

If this file and a slice contract disagree on pixels, the slice wins. If they disagree on platform law (approval, last4, CLI-first, Dust retrieval-only, Latest gate, native last), this file wins and the slice is updated in its own PR.

---

## 13. Subtract

The platform is already mostly built. The north star is not a rewrite. It is the order and the refusals.

What we keep: Hide/Island/Bar, Settings surface math, HMAC, Access, enterprise stream wrapper, CLI managed install, Dust Spotlight Ref, prompt cache, CRM explicit send, native `MeetingIntelligence` seam.

What we add later, one slice at a time: seat APPROVAL, vault last4 on this tree, CLI-first Ask promotion, Latest veto, PCC behind the 27 SDK.

What we never add: a third plane, a fake Connected, a crushed Settings, a flash, a Hide orb, a 10k rewrite before pack.

Intent first. Evidence over appetite. Beautiful because it recedes.

**READY TO MERGE: no.**
