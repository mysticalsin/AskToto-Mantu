# AskToto — Unknown / Unverifiable Items

Items that cannot be confirmed by static reading of the code alone — they need an external decision,
a credential, a live run, a packaged build, or a runtime environment. Each is marked with what would
resolve it. None of these are claimed PASS/FAIL here; they are open inputs for later phases.

## Signing, distribution, updates

| # | Item | Why unknown | Resolve by |
|---|------|-------------|-----------|
| 1 | Code signing (mac + win) | Env-driven (`CSC_LINK`/`CSC_KEY_PASSWORD`/`APPLE_ID`/`APPLE_TEAM_ID`/`WIN_CSC_*`), none set; `gatekeeperAssess:false`, `verifyUpdateCodeSignature:false` (`electron-builder.yml:5-7,32,47`) | Provision certs as CI secrets; verify a signed+notarized artifact |
| 2 | Notarization (macOS) | Apple creds not present | Run `npm run dist` with Apple secrets; staple + `spctl` check |
| 3 | Auto-update host | `publish.url` is `https://REPLACE-WITH-YOUR-UPDATE-HOST/asktoto`; updater self-skips placeholder (`updater.ts:14-18`) | Stand up HTTPS update host; confirm signed `latest-*.yml` flow |
| 4 | Update channel integrity | `verifyUpdateCodeSignature:false` on win (`:47`) | Decide whether to require signed-update verification |
| 5 | AppX identity | `publisher: CN=Mantu`, `identityName: Mantu.AskToto` (`:58-63`) — needs real Store/enterprise identity | Confirm with MS Partner Center / enterprise sideload policy |

## Runtime behaviors not observable statically

| # | Item | Why unknown | Resolve by |
|---|------|-------------|-----------|
| 6 | Real Listen flow end-to-end | Whisper model loads from HF CDN at runtime; ASR quality/latency/permission prompts not testable from source | Live run with mic + system audio on mac & win |
| 7 | System-audio loopback grant | `setDisplayMediaRequestHandler` logic present (`index.ts:706-746`) but actual OS grant per platform unverified | Live capture on macOS (Screen Recording) + Windows |
| 8 | Whisper model SRI / integrity | `env.allowLocalModels=false`; model fetched from HF CDN with no subresource/hash check (`whisper.worker.ts:2`) | Decide on pinned/bundled model or hash verification |
| 9 | Meeting detection accuracy | `osascript`/`powershell` scripts depend on installed apps, OS perms (Accessibility/UIA), locale | Live test across Zoom/Teams/Meet on both OSes |
| 10 | macOS keychain prompt for Dust import | `security find-generic-password` triggers a one-time allow dialog (`dustcli.ts:13`) | Live import with a real Dust CLI session |
| 11 | graphify availability | Requires python that can `import graphify` + optional local `claude` CLI; absent → degrades (`graphify.ts:202-206`) | Confirm target machines have graphify/claude or accept graceful-off |
| 12 | electron-log secret hygiene | Logger writes updater/errors; whether any secret/PII is ever logged not provable statically | Inspect live log files after a session |

## Security / policy decisions (require an owner's call)

| # | Item | Why unknown | Resolve by |
|---|------|-------------|-----------|
| 13 | Auth posture for "production with sensitive data" | When Azure SSO unconfigured, `requireAuth()` returns true → all gates open (single-user dev default) (`auth.ts:152-159`) | Decide whether SSO is mandatory for prod; deploy managed-config tenant lock |
| 14 | Entra app registration | Needs a real client/tenant ("Mobile & desktop", redirect `http://localhost`) — not in repo (`auth.ts:13-22`) | IT provisions; validate domain lock + tenant lock live |
| 15 | OneDrive sync of sensitive data | Notes folder + `.env` sit under OneDrive sync; gitignore doesn't stop sync (`.env:1-3`) | Decide acceptable storage location / encryption requirement |
| 16 | Transcript encryption default OFF | Off by default so Dust/recall/graph can read notes (`ipc.ts:186-188`) | Decide org default; trade-off readability vs at-rest protection |
| 17 | Provider data-handling / DPA | Prompts (PII, transcripts, screenshots) leave to whichever provider key is set | Confirm approved providers + data processing agreements |
| 18 | npm dependency CVEs | `npm audit` not run in this inventory pass | Run `npm audit` / `npm test` in a trusted clean checkout |
| 19 | `latest` / floating dep versions | Several devDeps pinned to `latest` (`package.json:29-47`) → non-reproducible builds | Pin versions; commit a verified lockfile under git |
| 20 | No git repository | Repo not initialized → no integrity baseline, history, or signed commits | `git init`, establish baseline, enable CI on real remote |
| 21 | Custom / OpenAI-compatible endpoints | Users may point `customBaseUrl` at arbitrary https hosts (validated https-only, `ipc.ts:152-158`) | Decide allowlist/policy for non-approved endpoints |

## Not applicable (justified) — no cloud/server surface

- **Server / API gateway / load balancer**: N/A — app talks directly from the user's machine to
  provider APIs via SDKs; there is no AskToto-operated server.
- **Database**: N/A — persistence is local files (`userData/*`, markdown notes); no DB engine.
- **Container / Kubernetes / cloud IAM**: N/A — desktop binary, no orchestration; "IAM" is local OS
  permissions + optional Entra SSO only.
- **Multi-tenant isolation**: N/A — single user, single machine; the only multi-user concept is the
  enterprise managed-config policy file (`store.ts:78-98`).
