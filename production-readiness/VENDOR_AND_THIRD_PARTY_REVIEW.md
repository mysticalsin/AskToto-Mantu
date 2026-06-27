# AskToto — Vendor & Third-Party / Supply-Chain Review

Scope: every external party or component AskToto 0.1.0 depends on at runtime or build time. The app is a
local desktop binary; "vendors" are the APIs the user's key talks to, the CDNs/registries it fetches
from, and the npm dependency tree. Evidence = `file:line` and real command output.

Date: 2026-06-27.

---

## 1. Runtime third parties (data recipients)

| Vendor | What is sent | Personal data? | DPA needed? | Evidence |
|--------|--------------|:---:|:---:|----------|
| Chosen LLM provider (14 ids: Anthropic / OpenAI-compatible / Dust) | prompt = question + profile + context docs + transcript/screenshot | Yes | **Yes** | `providers.ts:37-243`, `llm.ts`, `index.ts:478-560` |
| Microsoft Entra (`login.microsoftonline.com`) | OAuth PKCE (only if SSO configured) | identity | covered by org M365 | `auth.ts:167,194-220` |
| Microsoft OneDrive | passive sync of the notes folder | Yes (transcripts) | covered by org M365 | `transcripts.ts:118-150` |
| Hugging Face CDN | model **download** only (no user data sent) | No | No (but integrity gap) | `whisper.worker.ts:2,19` |
| Dust (`dust.tt` / `eu.dust.tt`) | conversation + user identity context | Yes | **Yes** | `llm.ts:81-100,126-144` |
| Update host (`publish.url`) | update check | No | N/A (placeholder, self-skips) | `electron-builder.yml:67-69`, `updater.ts:12-21` |

The app ships **no provider credentials** — the user supplies their own key for whichever provider they
choose. The set of vendors actually contacted is determined entirely by the user's configuration.

## 2. Build-time / supply-chain components

| Component | Source | Risk | Evidence |
|-----------|--------|------|----------|
| npm dependencies | npm registry | CVE exposure (below) | `package.json`, `package-lock.json` (committed) |
| Whisper ONNX model | HF CDN | **no SRI / hash check** | `whisper.worker.ts:2,19` |
| `graphify_runner.py` | bundled resource; spawns python + local `claude` CLI | local code-exec scope | `graphify.ts`, `resources/graphify_runner.py` |
| Dust CLI keychain entry | OS keychain via `security` | triggers OS allow prompt | `dustcli.ts` |
| Code-signing certs | env-driven, **not configured** | unsigned artifacts | `electron-builder.yml:5-7`, `docs/SIGNING.md` |

## 3. npm audit — actual results

```
$ npm audit            → 27 vulnerabilities (11 moderate, 16 high, 0 critical)
$ npm audit --omit=dev →  9 vulnerabilities (4 moderate,  5 high, 0 critical)
```

**Production (shipped) vulnerabilities** are all transitive under `@dust-tt/client`'s bundled Express
server stack, and are **ReDoS / DoS** classes — not RCE, not data exposure:

| Package | Sev | Class | Reachable in AskToto? |
|---------|:---:|-------|-----------------------|
| `@modelcontextprotocol/sdk` (under @dust-tt/client) | high | ReDoS / DNS-rebind / shared-transport | Low — app uses Dust client for HTTPS calls, not as an MCP server |
| `path-to-regexp` | high | ReDoS (route parsing) | Low — no Express router run in-app; `npm audit fix` available |
| `tar` | high | path traversal on extract | Low — not used to extract untrusted archives at runtime |
| `ajv`, `body-parser`, `qs`, `postcss`, `esbuild` | moderate | ReDoS / DoS | Low — server/build-time deps |
| `electron` | high | (build advisory) | tracked via Electron upgrades |

No **critical** advisories. Dev-only items (esbuild/postcss/electron toolchain) do not ship in the asar.

## 4. Findings

| Sev | Title | Evidence | Fix |
|-----|-------|----------|-----|
| MEDIUM | 16 high / 11 moderate npm advisories (9 ship in prod, transitive under @dust-tt/client) | `npm audit` output above | Run `npm audit fix` (clears path-to-regexp/qs/body-parser); track @dust-tt/client upgrade for the MCP-SDK chain; re-audit in CI |
| MEDIUM | Whisper model has no integrity verification (no-SRI) | `whisper.worker.ts:2,19` | Pin a model revision + verify a SHA before first use, or bundle the model |
| MEDIUM | Code signing / notarization not configured → unsigned artifacts | `electron-builder.yml:5-7,32,47`; `docs/SIGNING.md` | Provision certs as CI secrets; verify signed+notarized build (see DEPLOYMENT_RUNBOOK) |
| LOW | No automated dependency CVE gate in CI | `.github/workflows/build.yml` (no `npm audit` step) | Add `npm audit --omit=dev --audit-level=high` (non-blocking or thresholded) to the quality job |
| LOW | No formal approved-vendor register / DPA tracking | §1 | Maintain a subprocessor register; enforce via managed-config provider allowlist |

## 5. Justified N/A

- **Vendor SLA / uptime monitoring**: N/A — AskToto operates no service; provider uptime is the
  provider's and the user falls back to another provider or manual work.
- **Cloud IAM / least-privilege roles**: N/A — no cloud infrastructure; "IAM" is local OS permissions
  plus optional Entra SSO (see ACCESS_REVIEW).
