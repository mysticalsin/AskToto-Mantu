# Network egress: every host Métis can reach, and how to restrict it

The question a bank asks first. This page is generated from a code audit of `src/main/**` (2026-09-05) and
is the contract the `egressAllowlist` policy enforces. Update it in the same change that adds a host.

## What never leaves the device

- Listen audio, live transcripts, screen captures and API keys are never sent to Mantu. They go only to the
  provider the user or IT selected (`allowedProviders`), redacted first when `redactSensitive` is on.
- Crash reporting is local only (`crashReporter.start({ uploadToServer: false })`). There is no analytics SDK.
- The Operator fleet dashboard receives metrics (mode, timing, token counts, a question-type label) and, only
  when the seat opts in, the Ask text. Never transcripts or screens. See `operator/README.md`.

## Hosts by purpose

| Purpose | Host(s) | When | Off switch |
| --- | --- | --- | --- |
| Microsoft sign-in (SSO) | `login.microsoftonline.com` | Sign-in, token refresh | Only with Azure SSO configured |
| Outlook calendar, mail drafts, Teams transcripts | `graph.microsoft.com` | Agenda open, notifier poll, draft, import | Sign out of Microsoft |
| Dust (workspace AI) | `dust.tt`, `eu.dust.tt`, `signin.dust.tt` | Provider = Dust | Remove Dust from `allowedProviders` |
| Dust device sign-in | `api.workos.com` | Dust automatic sign-in | Same |
| Anthropic | `api.anthropic.com` | Provider = Anthropic | `allowedProviders` |
| OpenAI | `api.openai.com` | Provider = OpenAI | `allowedProviders` |
| Google Gemini | `generativelanguage.googleapis.com` | Provider = Gemini | `allowedProviders` |
| Kimi / Moonshot | `api.kimi.com` | Provider = Kimi | `allowedProviders` |
| DeepSeek | `api.deepseek.com` | Provider = DeepSeek | `allowedProviders` |
| NVIDIA NIM | `integrate.api.nvidia.com` | Provider = NVIDIA | `allowedProviders` |
| Alibaba Qwen | `dashscope-intl.aliyuncs.com` | Provider = Qwen | `allowedProviders` |
| MiniMax | `api.minimax.io` | Provider = MiniMax | `allowedProviders` |
| OpenRouter | `openrouter.ai` | Provider = OpenRouter | `allowedProviders` |
| Groq | `api.groq.com` | Provider = Groq | `allowedProviders` |
| Mistral | `api.mistral.ai` | Provider = Mistral | `allowedProviders` |
| xAI | `api.x.ai` | Provider = xAI | `allowedProviders` |
| Custom OpenAI-compatible endpoint | `customBaseUrl` (IT or user) | Provider = Custom | Lock `customBaseUrl` |
| Cloudflare AI proxy (default zero-key path) | `metis-cloudflare-proxy.tony-walteur.workers.dev` | Provider = Cloudflare | `allowedProviders` |
| Cloudflare key restore | `api.cloudflare.com` | Restoring the shipped key | Only on that button |
| Operator fleet dashboard | `operatorUrl` (IT or user) | Heartbeat 60 s, after each Ask | Clear `operatorUrl` |
| License server | `licenseServerUrl` (IT) | Activation, heartbeat | Compiled off in shipped builds (MQA-068) |
| Auto-update check | `api.github.com`, `github.com`, `objects.githubusercontent.com` | Launch, then periodic | `updateFeedUrl` (private feed) or `disableAutoUpdate: true` |
| On-device model weights | `huggingface.co` (and its CDN redirect targets) | First enable of Local AI / Best transcription | Do not enable Local AI; or pre-seed the model folder |
| CLI provider install | `registry.npmjs.org`, `nodejs.org` | "Install" for Claude Code / Codex CLI | Do not use CLI providers |
| Sherpa ASR bundle | `github.com` (k2-fsa/sherpa-onnx), `huggingface.co` | Bundled ASR missing | Ship the bundle |
| Plane (tasks) | `mcp.plane.so` or the IT-set URL | Connect + Book next steps | Do not connect |
| ClickUp (tasks) | `mcp.clickup.com` | Connect + Book next steps | Do not connect |
| Local model servers | `127.0.0.1`, `localhost` | Local AI, Apple FM bridge | Always allowed by policy |

The CLI providers (`claude`, `codex`) and the Dust CLI are child processes with their own network behavior;
no in-process hook sees their sockets. Under `egressAllowlist` they are not spawned at all (see the transport
matrix below). Without a policy they run as before.

### MCP connections through a proxy

Before connecting to an MCP endpoint (Plane, ClickUp), the app resolves it on the device and refuses the
connection if any answer is a cloud-metadata address. It then asks the proxy for a tunnel to that resolved
address (for example `CONNECT 203.0.113.7:443`), never to the endpoint's name, and TLS inside the tunnel
still presents and verifies the endpoint's host name (SNI). So the device must be able to resolve the MCP
endpoint, and the proxy must allow `CONNECT` to its addresses, not only to its name. SOCKS proxies are not
used for MCP connections.

## Enforcing it: `egressAllowlist`

Managed config (machine-wide `managed-config.json`, see `docs/ENTERPRISE_RELEASE.md`):

```json
{
  "egressAllowlist": [
    "login.microsoftonline.com",
    "graph.microsoft.com",
    "*.dust.tt",
    "api.workos.com",
    "api.anthropic.com",
    "api.github.com",
    "objects.githubusercontent.com"
  ]
}
```

- Absent key: no restriction (today's behavior for every install).
- Present: every other host is refused. `*.example.com` matches `example.com` and its subdomains. Loopback is
  always allowed. An explicit `[]` is deny-all except loopback.
- Enforced at boot by `src/main/net/egress-guard.ts` on both stacks the app uses: the main-process `fetch`
  (every provider, Graph, Operator, npm, WorkOS) and the Chromium session (`net.fetch`, the renderer, the
  Intelligence window). A refused request fails like a dead network, so the existing offline handling and
  error copy apply. Each refused host is written once per session to the audit log as `net.egress.blocked`
  (hostname only). The policy itself is recorded at boot as `net.egress.policy`.
- Precedence matches `allowedProviders`: the admin (machine) file wins over the per-user file.
- Known gap, stated rather than hidden: a library added later that opens its own raw `https.request` socket is
  not seen by the guard. Every such transport must be added to the matrix below, with a test, in the same change.

### Transport matrix

Every way the app can put bytes on the network, the point that enforces `egressAllowlist` for it, and the test
that proves a disallowed host is refused (or that the transport is disabled). "Policy" = `egressAllowlist` is
present in managed config; without it nothing is restricted.

| Transport | Used by | Enforcement point under a policy | Negative test |
| --- | --- | --- | --- |
| Renderer `fetch`, XHR, images, Chromium `net.fetch` | Renderer, Intelligence window | Chromium session `webRequest.onBeforeRequest` cancels the request (`egress-guard.ts`) | `net/transport-matrix.test.ts` (renderer fetch), `net/egress-guard.test.ts` |
| Renderer WebSocket | Renderer | Same `onBeforeRequest` hook (it receives `ws:`/`wss:` URLs) | `net/transport-matrix.test.ts` (renderer WebSocket) |
| Main-process `fetch` (providers, Graph, Operator, npm, WorkOS, model downloads) | `src/main/**` | `globalThis.fetch` replaced by the guarded fetch, which also re-checks every redirect hop (`egress-guard.ts`) | `net/transport-matrix.test.ts` (main-process fetch), `net/egress-guard.test.ts` (incl. redirect hop) |
| Raw `https.request` sockets in libraries (MSAL token client) | Microsoft sign-in | MSAL is configured with a network client that sends through the guarded `fetch` (`net/guarded-network-client.ts`, wired in `auth.ts`) | `net/transport-matrix.test.ts` (MSAL token client) |
| Main-process WebSocket (`ws`) | Cloud speech-to-text live session | The session checks the host against the policy before it constructs the socket (`cloud-stt/live-session.ts`, audited as `cloud-stt-ws`) | `cloud-stt/live-session.test.ts` (refuses WebSocket egress outside an explicit managed allowlist) |
| Child process: CLI providers (`claude`, `codex`), CLI install, Dust CLI chat and session refresh | Provider = CLI, Settings → CLI Integration, Dust | **Disabled**: not spawned (`childNetworkBlocked()` in `cli.ts`, `dust-cli-chat.ts`, `dustcli.ts`). A child opens its own sockets, so refusing the spawn is the only hard guarantee. Probes that still run (`cliEnv`) get the pinned proxy environment below | `net/child-egress.test.ts` |
| Child process: managed `npm install` for the Dust CLI | CLI install | Proxy environment pinned to an unresolvable proxy (`pinChildEnv()`); the tarball download itself goes through the guarded `fetch` | `net/transport-matrix.test.ts` (pinChildEnv) |
| Child process: `ffmpeg` | Recording import | Reads local files only; spawned with the pinned proxy environment (`pinChildEnv()` in `ffmpeg-decoder.ts`) | `net/child-egress.test.ts` (ffmpeg) |
| Native helpers (macOS helper, Apple speech, Apple Foundation Models probe, foreground watcher) | On-device OCR, speech, window tracking | On-device; contain no network code paths (code audit, not a test). Spawned with the pinned proxy environment as defense in depth (`pinChildEnv()`) | `net/transport-matrix.test.ts` (pinChildEnv); no per-helper socket test |
| Loopback (local model servers, sidecars) | Local AI, Apple FM bridge | Always allowed by policy | `net/egress-policy.test.ts` |

How child processes are pinned: `pinChildEnv()` (`net/egress-policy.ts`) sets `HTTP_PROXY`, `HTTPS_PROXY`,
`ALL_PROXY` (both cases) to a proxy on a reserved `.invalid` name and empties `NO_PROXY`, so a child that honors
proxy variables fails closed instead of connecting directly or through the machine proxy. A binary that ignores
proxy variables is not stopped by this, which is why the CLI providers are refused at spawn instead. Consequence
for admins: under `egressAllowlist` the CLI providers and the Dust CLI are unavailable; use API providers.

## Proof

- `src/main/net/egress-policy.test.ts`: parsing, wildcard and loopback rules.
- `src/main/net/egress-guard.test.ts`: fetch rejection, Chromium cancel, once-per-host audit, no-policy no-op.
- `src/main/net/transport-matrix.test.ts`: one negative test per in-process transport row, and the child-process
  policy helpers.
- `src/main/net/child-egress.test.ts`: CLI providers and Dust CLI are refused without a spawn, `cliEnv` and
  ffmpeg get the pinned environment.
- `src/main/bank-grade-hardening.contract.test.ts`: the guard is armed at boot, after the proxy, in a
  try/catch so it can never block startup.
