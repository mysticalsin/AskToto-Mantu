import type { ProviderId } from '@shared/providers'
import { pinChildEnv } from './net/egress-policy'

/** Env for spawning a CLI. For claude-cli, strip Claude-Code session + proxy vars so the spawned
 *  `claude` runs as a clean standalone invocation against the user's own keychain login (avoids a
 *  hang when Métis is itself launched from a Claude Code session, and ignores a proxy base URL).
 *  Also strips ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN so the spawned `claude -p` uses the
 *  interactive CLI login (honours the "no key required" contract) and not silent API-key billing.
 *  Under a managed egressAllowlist the proxy variables are then pinned to the policy (pinChildEnv). */
export function cliEnv(provider: ProviderId): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (provider === 'claude-cli') {
    for (const k of Object.keys(env)) {
      if (/^CLAUDE_CODE/i.test(k) || k === 'CLAUDECODE' || k === 'CLAUDE_AGENT_SDK_VERSION' || k === 'CLAUDE_TMPDIR') {
        delete env[k]
      }
    }
    delete env.ANTHROPIC_BASE_URL
    // Remove API-key vars so `claude -p` auths via the user's CLI login, not API-key billing.
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
  } else if (provider === 'codex-cli') {
    delete env.OPENAI_BASE_URL
  }
  return pinChildEnv(env)
}

/** What a CLI that reaches the network is told when a managed egressAllowlist forbids spawning it. */
export function cliEgressBlockedMessage(label: string): string {
  return `${label}: blocked by your organization's network policy (egressAllowlist). CLI providers open their own connections, which the policy cannot filter.`
}
