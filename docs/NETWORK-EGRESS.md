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

The CLI providers (`claude`, `codex`) and `ffmpeg` are child processes with their own network behavior;
the policy below does not see their sockets. A bank that needs a hard guarantee should not enable CLI
providers, or should pin them at the proxy.

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
- Enforced at boot by `src/main/net/egress-guard.ts` on every stack the app uses: the main-process `fetch`
  (every provider, Graph, Operator, npm, WorkOS), Node `http` / `https` `request` and `get` (MSAL's token
  client for Microsoft sign-in), and the Chromium session (`net.fetch`, the renderer, the Intelligence
  window). A refused request fails like a dead network (fetch `TypeError`, http `ENOTFOUND`, Chromium
  `ERR_BLOCKED_BY_CLIENT`), so the existing offline handling and error copy apply. Each refused host is
  written once per session to the audit log as `net.egress.blocked` (hostname only). The policy itself is
  recorded at boot as `net.egress.policy`.
- Redirects are checked hop by hop. A host on the list cannot bounce a request to a host that is not: the
  fetch guard follows 3xx itself (same 20-hop ceiling as the fetch spec, auth headers dropped across
  origins) and refuses the first hop that leaves the list; Chromium re-runs the hook on each redirect. So a
  model download from `huggingface.co` also needs its CDN targets (`*.hf.co`) on the list.
- A refused `http` / `https` request never reaches DNS: the guard hands Node a `lookup` that fails, so
  the hostname itself does not leave the device.
- Known gap, stated rather than hidden: child processes (the CLI providers, ffmpeg) open their own sockets
  and are not seen by the guard. Put those on the proxy allowlist.
- Precedence matches `allowedProviders`: the admin (machine) file wins over the per-user file.

## Proof

- `src/main/net/egress-policy.test.ts`: parsing, wildcard and loopback rules.
- `src/main/net/egress-guard.test.ts`: fetch rejection, redirect hop checks (allowed chain, off-list hop,
  303/307 method and header rules, 20-hop ceiling), http/https lookup refusal against the real `node:https`
  module, Chromium cancel, once-per-host audit, no-policy no-op.
- `src/main/bank-grade-hardening.contract.test.ts`: the guard is armed at boot, after the proxy, in a
  try/catch so it can never block startup.

## Cloudflare Worker endpoint pin (`cloudflareBaseUrl`)

Packaged builds (and installs with an admin machine-wide `managed-config.json`) refuse a user-writable
`cloudflareBaseUrl` that is not on the pin. The bearer `METIS_PROXY_KEY` and every prompt would otherwise
follow a malicious host written into per-user `settings.json` or per-user `managed-config.json`.

Allowed hosts:

- `*.workers.dev` (the default Worker proxy shape, including the shipped default)
- Hosts listed in the **admin** managed-config key `cloudflareBaseUrlAllowlist` (hostname or `*.` wildcard)
- The host of an admin-managed `cloudflareBaseUrl` itself (self-host via admin policy)

Dev / unpackaged builds without admin policy stay unrestricted beyond the existing `https://` schema check.
Self-host is an admin decision, never a user-writable one. See `docs/CLOUDFLARE.md` and
`src/main/cloudflare-base-url.ts`.

Example admin snippet:

```json
{
  "cloudflareBaseUrl": "https://metis-proxy.corp.example/v1",
  "cloudflareBaseUrlAllowlist": ["metis-proxy.corp.example"],
  "locked": ["cloudflareBaseUrl"]
}
```

