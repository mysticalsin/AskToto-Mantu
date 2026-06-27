# AskToto — Threat Model

Method: STRIDE per asset + trust-boundary analysis. Scope: AskToto v0.1.0, a local Electron desktop overlay (macOS + Windows). Single user, local-first. No server, DB, multi-tenant backend, container, cloud IAM, or load balancer — those attacker surfaces do not exist and are marked N/A with justification.

Date: 2026-06-27. Cross-references RELEASE_GATE_MATRIX.md, RISK_REGISTER.md, SECURITY_REVIEW.md and the 45 domain reports in this folder.

## 1. System overview

AskToto is a glass overlay that lets a single user:
- Ask an LLM (Anthropic / OpenAI / Dust / custom HTTPS provider) with optional screen-capture context.
- Listen to a meeting: audio captured locally, transcribed on-device by Whisper (Xenova/whisper-tiny ONNX), notes saved as markdown.
- Recall / Review past transcripts; build a local knowledge graph via a spawned python runner + the local `claude` CLI (graphify).

Processes and the trust boundary:
- Main process (TRUSTED) — `src/main/`: IPC handlers (index.ts), encrypted store (store.ts), auth (auth.ts), LLM client (llm.ts), transcripts (transcripts.ts), recall (recall.ts), graphify (graphify.ts), dustcli (dustcli.ts), meeting-detect/. Holds all secrets; performs all privileged I/O and network egress.
- Preload (BRIDGE) — `src/preload/index.ts`: exposes only `window.toto` over contextBridge.
- Renderer (UNTRUSTED-by-design) — `src/renderer/`: React glass UI, sandboxed, contextIsolation on, nodeIntegration off, webSecurity on. Receives only non-secret PublicSettings (hasKeys booleans). The Whisper worker also runs in renderer space.

The security architecture treats the renderer as if it could be compromised (e.g. by malicious markdown/model content) and keeps every secret and privileged capability behind the main-process IPC boundary, gated by `assertMainWindow()` + `requireAuth()`.

## 2. Trust boundaries

1. Renderer ↔ Main (IPC) — the primary boundary. Crossing requires a registered `ipcMain.handle` that calls `assertMainWindow()` (sender must be the main window top frame; subframes/devtools/foreign webContents rejected — index.ts:83-92) and, for data/privileged channels, `requireAuth()` (index.ts:422-646).
2. App ↔ Local filesystem — userData (encrypted settings, session, graph JSON) + notes folder (markdown transcripts, default under OneDrive-synced path).
3. App ↔ Remote services — HTTPS egress to chosen LLM provider, Dust, Microsoft Entra, Hugging Face / jsDelivr CDN (Whisper model), OneDrive (via OS sync), graphify backend.
4. App ↔ Spawned child processes — python runner, local `claude` CLI, `security`/`osascript`/`powershell` (meeting detection, keychain, graphify). Inherits whatever resolves on PATH (host trust).
5. OS account boundary — by default the only identity gate is the logged-in OS user (Entra SSO is optional and fail-open when unconfigured).

## 3. Assets

| Asset | Location | Sensitivity | Primary control |
|-------|----------|-------------|-----------------|
| Provider API keys | userData settings (safeStorage, 0o600) | Critical | Encrypted at rest; never crosses to renderer |
| Meeting transcripts / notes | notes folder (markdown), default OneDrive-synced | High (client-confidential) | Optional encryption (OFF by default) — gap R-08 |
| Profile PII (resume / JD / notes) | userData / notes | High | safeStorage settings; folder choice |
| Azure identity / session token | auth-session.bin (safeStorage) | High | Encrypted; PKCE; tenant+domain lock |
| Derived knowledge graph | userData graph JSON | Medium | Local only; orphan-deletion gap R-11 |
| Screen captures (Ask context) | in-memory, sent to LLM | High | Not persisted; zod size/charset bound |
| The signed app binary / update channel | installers + update host | Critical (integrity) | UNSIGNED today — gap R-13/R-16 |

## 4. Adversaries

- A1 Malicious model / web content rendered in the renderer (markdown, code blocks, a tampered Whisper model). Goal: XSS → secret exfiltration or RCE.
- A2 Local malware / another local user on a shared machine. Goal: read keys/transcripts at rest, or impersonate the user.
- A3 Network MITM / hostile CDN. Goal: tamper the Whisper model or update payload, downgrade TLS.
- A4 Supply-chain attacker (npm dep, transitive). Goal: code execution inside the shipped app.
- A5 Cloud/replication exposure (OneDrive sync, LLM provider retention). Goal: read client-confidential transcripts off the user's premises.
- A6 Insider / casual access to an unlocked machine. Goal: use the app without authenticating as the legitimate user.

## 5. STRIDE analysis

### 5.1 Spoofing
- IPC sender spoofing (A1): a compromised subframe/iframe or devtools tries to invoke privileged IPC. MITIGATED — `assertMainWindow()` on 32/32 handlers rejects any non-main-window-top-frame sender (index.ts:83-92).
- User spoofing / unauthenticated use (A6): default build does NOT enforce identity — `requireAuth()` returns true when Entra SSO is unconfigured (auth.ts:152-154). RESIDUAL HIGH (R-01): only the OS account gates access. When Entra is configured, tenant+domain lock + PKCE S256 mitigate strongly (auth.ts:167,227-232).
- Update-server spoofing (A3): UNRESOLVED (R-13/R-16) — artifacts are unsigned/adhoc, win.verifyUpdateCodeSignature:false; if an update host were wired today, a spoofed server would be defeated only by TLS+sha512, not signature. Updater is currently disabled by the placeholder host, which contains the risk until signing is fixed.

### 5.2 Tampering
- Renderer DOM injection (A1): MITIGATED — CSP blocks inline/eval script; single HTML sink (CodeBlock.tsx:115) is fed by shiki `codeToHtml` which escapes text; markdown via streamdown AST with no raw-HTML passthrough.
- Whisper model tampering (A3/A4): UNRESOLVED (R-05) — model fetched from HF/jsDelivr with no revision pin or SRI. Impact bounded by sandboxed renderer + TLS + CSP, but a tampered model is loaded without integrity proof.
- Dependency tampering (A4): PARTIAL — package-lock pins the tree and CI uses `npm ci`, but no SCA/SBOM/secret-scan gate exists (R-14) and shipped Electron 33.4.11 carries RCE-class advisories (R-15).
- At-rest data tampering (A2): config/keys written atomically with 0o600 + safeStorage; transcripts are plaintext markdown by default (no integrity/encryption) — R-08.
- Installer tampering (A3): UNRESOLVED — unsigned/unnotarized installers (R-13) cannot prove integrity to Gatekeeper/SmartScreen.

### 5.3 Repudiation
- No multi-user audit requirement (single local user). Local electron-log captures update/stream errors. No security audit log of privileged IPC calls — acceptable for a single-user local app (LOW). N/A for server-side non-repudiation (no server).

### 5.4 Information disclosure
- Secret leak to renderer (A1): MITIGATED — PublicSettings exposes only hasKeys/hasEncryption booleans; getApiKey/safeStorage are main-only (grep clean); renderer is write-only.
- Error/stack leak (A1): MITIGATED — handlers forward `e.message` only. LOW caveat: a provider error may echo a fragment of the user's OWN key (single-user, local).
- Plaintext transcripts replicated to cloud (A5): UNRESOLVED HIGH (R-08) — encryptTranscripts defaults false and the default save folder is OneDrive-synced (transcripts.ts:146-150); client-confidential content is cloud-replicated AND egresses to a third-party LLM with no enforced DPA.
- Decrypted-temp leak (A2): UNRESOLVED (R-09) — decryptToTemp writes plaintext to OS temp with a predictable name, no 0o600, no cleanup (transcripts.ts:64-69).
- At-rest read by local malware/other user (A2): keys/session/settings encrypted via safeStorage (OS-keychain-bound); transcripts are the exposed surface (see R-08). Keychain ACL strength is weakened by unconfigured code signing (an unsigned app's keychain entitlement is less trustworthy) — R-13 has a data-protection knock-on.
- Source-map disclosure: app maps not shipped; 3rd-party node_modules .map leak into asar (LOW, F3).

### 5.5 Denial of service
- Hung LLM stream (A1/A3): UNRESOLVED (R-06) — OpenAI/Dust branches set no timeout; a hung provider leaks a streams-Map entry + open AbortController + a stuck spinner (llm.ts:123-263).
- Main-thread blocking (A5 large folder): UNRESOLVED (R-07) — recall.ts reads every transcript synchronously on the IPC thread; a large OneDrive folder freezes the UI.
- Audio queue growth: MITIGATED — MAX_QUEUE=24 drop-oldest (listen.ts:136-138) + full teardown on stop.
- Server-side DoS / rate-limit / WAF: N/A — no inbound server. The only listener is a transient 127.0.0.1 OAuth loopback (random port, single request, 300s timeout, PKCE).

### 5.6 Elevation of privilege
- Renderer → main RCE (A1): MITIGATED by design — sandbox + contextIsolation + nodeIntegration off + webSecurity on; navigation hardening denies window.open and non-current-URL navigation; openExternal https-only.
- Command/arg injection via child processes (A4): MITIGATED — all spawns use `execFile` with argv arrays (no shell): static osascript/powershell scripts, constant `security` args, python args array (graphify.ts:211, dustcli.ts:31, mac.ts:143, win.ts:44). customMeetingApps are matched in JS, never injected into the shell.
- Path traversal (A1): MITIGATED — recall:open / graphify use `basename()`; selftest asserts ProviderIdSchema rejects `../../etc/passwd`.
- Privileged IPC without authz (A1/A6): assertMainWindow on all handlers + requireAuth on data channels — but requireAuth is fail-open by default (R-01), so EoP to data actions reduces to "be the OS user".
- Shipped-Electron RCE (A4): UNRESOLVED (R-15) — Electron 33.4.11 carries RCE-class + ASAR-integrity advisories; mis-classed as devDependency so hidden by `--omit=dev`.

## 6. Attack-tree highlights (top exploitable paths)

1. Read client-confidential transcripts without touching the app → OneDrive sync / LLM provider retention (R-08). No app-level control once content leaves; the only defenses are encrypt-on-disk (off by default) + folder choice + a DPA. Most likely real-world exposure.
2. Tampered Whisper model or update payload (R-05 / R-13 / R-16) → code/content integrity break. Bounded today by the disabled update channel + sandboxed renderer, but a latent HIGH the moment an update host is wired before signing.
3. Unauthenticated use on a shared/unlocked machine (R-01) → full app capability as the OS user, no Entra challenge.
4. Supply-chain RCE via shipped Electron 33.4.11 (R-15) → reachable if a malicious page/model can trigger a known Electron sink; reduced by sandbox but the runtime itself is vulnerable.

## 7. N/A surfaces (justified)

- Inbound API auth / CORS / rate-limit / WAF — no inbound HTTP/REST/gRPC server exists.
- Database / SQL injection — no DB/ORM/KV anywhere (grep clean).
- Container / orchestration / image registry — no Dockerfile/compose/k8s; native installers only.
- Cloud IAM / load balancer / multi-tenant isolation — no cloud backend.
- Server TLS termination / HSTS / cookie flags — no inbound server; framing/navigation locked at the window layer.

## 8. Residual-risk summary

The architecture is genuinely strong at the renderer↔main boundary (sandbox, contextIsolation, assertMainWindow, zod, execFile, no secrets to renderer). The exploitable residual risk is concentrated in four places, all tracked in RISK_REGISTER.md: data-at-rest/replication (R-08/R-09), supply-chain & runtime integrity (R-05/R-13/R-15/R-16), default fail-open auth (R-01), and a couple of DoS/robustness gaps (R-06/R-07). None is a confirmed remote-RCE-without-precondition, but several block a trusted, distributable, sensitive-data release until remediated or formally risk-accepted in a DPIA.
