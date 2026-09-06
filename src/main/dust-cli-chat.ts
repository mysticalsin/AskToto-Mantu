/**
 * Spotlight Ref → managed Dust CLI.
 *
 * Official non-interactive invoke (Dust CLI 0.4.5):
 *   dust chat --sId GOr913Zr5V -m "<prompt>"
 * Also -a "Spotlight Ref": 0.4.5's -m path selects by agent name, not --sId
 * (NonInteractiveChat.agentSearch = flags.agent). Headless auth is --key + --workspaceId
 * (or DUST_API_KEY + DUST_WORKSPACE_ID). Never --with-tools / -t.
 */

import { spawn } from 'node:child_process'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DUST_SPOTLIGHT_REF_AGENT_ID } from '@shared/ipc'
import { humanizeNpmInstallError } from '@shared/managed-npm'
import { dustAgentUnavailableMessage } from '@shared/quick-actions'
import { installManagedCli, managedCliEntry, type CliInstallProgress } from './cli-installer'
import { ensureManagedNode, resolveManagedNode, vcredistExePath, vcredistQuietArgs } from './managed-node'
import { killWindowsProcessTree } from './cli'

export const DUST_SPOTLIGHT_REF_AGENT_NAME = 'Spotlight Ref'
export const DUST_MANAGED_CLI_ID = 'dust' as const

export type DustChatKind = 'missing-cli' | 'missing-agent' | 'auth' | 'ok' | 'error'

export interface DustChatArgvOpts {
  sId?: string
  message: string
  agentName?: string
  projectName?: string
  /** When true, also put --key / --workspaceId on argv (in addition to env). Default false — env is safer. */
  passKeyOnArgv?: boolean
  apiKey?: string
  workspaceId?: string
}

/** Build the argv AFTER the entry script. Never includes --with-tools / -t. */
export function buildDustSpotlightChatArgv(opts: DustChatArgvOpts): string[] {
  const sId = (opts.sId || DUST_SPOTLIGHT_REF_AGENT_ID).trim()
  const args = ['chat', '--sId', sId, '-m', opts.message, '--noUpdateCheck']
  const name = (opts.agentName || DUST_SPOTLIGHT_REF_AGENT_NAME).trim()
  if (name) args.push('-a', name)
  const project = (opts.projectName || '').trim()
  if (project) args.push('--projectName', project)
  if (opts.passKeyOnArgv && opts.apiKey && opts.workspaceId) {
    args.push('--key', opts.apiKey, '--workspaceId', opts.workspaceId)
  }
  return args
}

export function dustChatEnv(opts: { apiKey?: string; workspaceId?: string }): Record<string, string> {
  const env: Record<string, string> = { CI: '1' }
  if (opts.apiKey) env.DUST_API_KEY = opts.apiKey
  if (opts.workspaceId) env.DUST_WORKSPACE_ID = opts.workspaceId
  return env
}

/** Forbidden flags — auto-approve every tool. Must never appear on the Spotlight Ref spawn. */
export function dustChatArgvHasWithTools(args: readonly string[]): boolean {
  return args.some((a) => a === '--with-tools' || a === '-t' || a === '--withTools')
}

export function classifyDustCliChatFailure(text: string, opts?: { cliInstalled?: boolean }): DustChatKind {
  const blob = text.toLowerCase()
  if (!opts?.cliInstalled || /cannot find|enoent|not installed|no such file.*dust|managed dust cli/i.test(text)) {
    if (/enoent|not installed|cannot find|no such file/i.test(blob)) return 'missing-cli'
  }
  if (
    /agent not found|no agent found matching|no agents available|agent with sid .* not found/i.test(blob)
  ) {
    return 'missing-agent'
  }
  if (/authentication required|run `dust login`|re-log/i.test(blob)) return 'auth'
  return 'error'
}

export function spotlightRefMissingCliMessage(): string {
  return 'The Dust CLI is not installed yet. Open Settings → AI and click Set up Dust to install it, or wait — Métis can install it now.'
}

export function spotlightRefMissingAgentMessage(): string {
  return 'The Spotlight Ref agent is not in this workspace.'
}

export function messageForDustCliKind(kind: DustChatKind, fallback: string): string {
  if (kind === 'missing-cli') return spotlightRefMissingCliMessage()
  if (kind === 'missing-agent') return spotlightRefMissingAgentMessage()
  if (kind === 'auth') return 'Dust is not signed in. Open Settings → AI and click Set up Dust to install the CLI and sign in.'
  return fallback
}

/** JSON stdout from `dust chat -m` (see Dust CLI SKILL.md). */
export function parseDustChatStdout(stdout: string): { agentAnswer?: string; error?: string; raw: string } {
  const trimmed = stdout.trim()
  if (!trimmed) return { raw: stdout }
  const tryParse = (s: string): { agentAnswer?: string; error?: string } | null => {
    try {
      const obj = JSON.parse(s) as { agentAnswer?: unknown; error?: unknown }
      const agentAnswer = typeof obj.agentAnswer === 'string' ? obj.agentAnswer : undefined
      const error = typeof obj.error === 'string' ? obj.error : undefined
      if (agentAnswer || error) return { agentAnswer, error }
    } catch {
      /* not json */
    }
    return null
  }
  const direct = tryParse(trimmed)
  if (direct) return { ...direct, raw: stdout }
  const lastBrace = trimmed.lastIndexOf('{')
  if (lastBrace >= 0) {
    const sliced = tryParse(trimmed.slice(lastBrace))
    if (sliced) return { ...sliced, raw: stdout }
  }
  const errLine = trimmed.match(/Error:\s*(.+)/)
  if (errLine) return { error: errLine[1].trim(), raw: stdout }
  return { raw: stdout, agentAnswer: trimmed }
}

export function projectNameForDataAndAiAsk(
  prompt: string,
  projectNames: readonly string[]
): string | undefined {
  if (!/\bdata\b.*\bai\b|\bai\b.*\bdata\b|data and ai/i.test(prompt)) return undefined
  const exact = projectNames.find((n) => n.trim().toLowerCase() === 'data and ai')
  if (exact) return exact
  return undefined
}

export interface DustCliSpawnPlan {
  command: string
  args: string[]
  env: Record<string, string>
}

/**
 * How to spawn the managed Dust CLI. Uses portable Node when present so keytar loads.
 * Falls back to Electron-as-node only when no portable Node exists (dev Linux).
 */
export function planManagedDustSpawn(cliArgs: string[]): DustCliSpawnPlan | { error: 'missing-cli' } {
  const found = managedCliEntry('dust')
  if (!found) return { error: 'missing-cli' }
  const node = resolveManagedNode()
  if (node) {
    return { command: node.node, args: [found.entry, ...cliArgs], env: {} }
  }
  return {
    command: process.execPath,
    args: [found.entry, ...cliArgs],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  }
}

/** Write a tiny ESM seeder next to the installed CLI so keytar (same Node ABI) stores the Métis session. */
export function writeDustKeytarSeedScript(packageDir: string): string {
  const dest = join(packageDir, '.metis-seed-session.mjs')
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(
    dest,
    [
      'import keytar from "keytar"',
      'const [token, workspace, region] = process.argv.slice(2)',
      'if (!token || !workspace) { console.error("missing token or workspace"); process.exit(2) }',
      'await keytar.setPassword("dust-cli", "access_token", token)',
      'await keytar.setPassword("dust-cli", "workspace_sid", workspace)',
      'if (region) await keytar.setPassword("dust-cli", "region", region)',
      'console.log("ok")'
    ].join('\n'),
    'utf8'
  )
  return dest
}

export function dustRegionFromBaseUrl(baseUrl: string | undefined): string {
  return baseUrl && /eu\.dust\.tt/i.test(baseUrl) ? 'europe-west1' : 'us-central1'
}

export async function ensureManagedDustCli(
  onProgress?: (p: CliInstallProgress) => void
): Promise<{ ok: true; entry: string; version: string } | { ok: false; error: string }> {
  if (process.platform === 'win32') {
    const redist = vcredistExePath()
    if (redist) {
      await new Promise<void>((resolve) => {
        const child = spawn(redist, vcredistQuietArgs(), { windowsHide: true, stdio: 'ignore' })
        const t = setTimeout(() => {
          child.kill()
          resolve()
        }, 120_000)
        child.once('close', () => {
          clearTimeout(t)
          resolve()
        })
        child.once('error', () => {
          clearTimeout(t)
          resolve()
        })
      })
    }
  }
  try {
    await ensureManagedNode()
  } catch (e) {
    return { ok: false, error: humanizeNpmInstallError(e) }
  }
  const existing = managedCliEntry('dust')
  if (existing) return { ok: true, entry: existing.entry, version: existing.version }
  try {
    const installed = await installManagedCli('dust', onProgress ?? (() => {}))
    return { ok: true, entry: installed.entry, version: installed.version }
  } catch (e) {
    return { ok: false, error: humanizeNpmInstallError(e) }
  }
}

const CHAT_TIMEOUT_MS = 180_000

export async function runManagedDustChat(opts: {
  message: string
  apiKey: string
  workspaceId: string
  baseUrl?: string
  projectName?: string
  onProgress?: (p: CliInstallProgress) => void
}): Promise<{ ok: true; text: string } | { ok: false; kind: DustChatKind; error: string }> {
  const ensured = await ensureManagedDustCli(opts.onProgress)
  if (!ensured.ok) {
    return { ok: false, kind: 'missing-cli', error: messageForDustCliKind('missing-cli', ensured.error) }
  }

  const argv = buildDustSpotlightChatArgv({
    sId: DUST_SPOTLIGHT_REF_AGENT_ID,
    message: opts.message,
    agentName: DUST_SPOTLIGHT_REF_AGENT_NAME,
    projectName: opts.projectName
  })
  if (dustChatArgvHasWithTools(argv)) {
    return { ok: false, kind: 'error', error: 'Refusing to spawn Dust chat with --with-tools.' }
  }

  const plan = planManagedDustSpawn(argv)
  if ('error' in plan) {
    return { ok: false, kind: 'missing-cli', error: spotlightRefMissingCliMessage() }
  }

  const env = {
    ...process.env,
    ...plan.env,
    ...dustChatEnv({ apiKey: opts.apiKey, workspaceId: opts.workspaceId })
  }

  const packageDir = dirname(ensured.entry)
  const seed = writeDustKeytarSeedScript(packageDir)
  const nodeBin = plan.env.ELECTRON_RUN_AS_NODE ? process.execPath : plan.command
  if (existsSync(seed) && opts.apiKey && opts.workspaceId) {
    await new Promise<void>((resolve) => {
      const child = spawn(nodeBin, [seed, opts.apiKey, opts.workspaceId, dustRegionFromBaseUrl(opts.baseUrl)], {
        env: { ...env, ...(plan.env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const t = setTimeout(() => {
        killWindowsProcessTree(child.pid)
        child.kill('SIGTERM')
        resolve()
      }, 15_000)
      child.once('close', () => {
        clearTimeout(t)
        resolve()
      })
      child.once('error', () => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  return new Promise((resolve) => {
    const child = spawn(plan.command, plan.args, {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    let done = false
    const finish = (code: number | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      const parsed = parseDustChatStdout(stdout)
      const blob = `${stdout}\n${stderr}\n${parsed.error || ''}`
      if (parsed.agentAnswer && parsed.agentAnswer.trim()) {
        resolve({ ok: true, text: parsed.agentAnswer.trim() })
        return
      }
      const kind = classifyDustCliChatFailure(blob, { cliInstalled: true })
      const fallback = parsed.error || stderr.trim() || stdout.trim() || `Dust CLI exited ${code ?? '?'}`
      resolve({
        ok: false,
        kind,
        error: messageForDustCliKind(kind, fallback)
      })
    }
    const timer = setTimeout(() => {
      killWindowsProcessTree(child.pid)
      child.kill('SIGTERM')
      finish(null)
    }, CHAT_TIMEOUT_MS)
    child.once('close', (code) => finish(code))
    child.once('error', (err) => {
      const kind = classifyDustCliChatFailure(err.message, { cliInstalled: false })
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, kind, error: messageForDustCliKind(kind, err.message) })
    })
  })
}

export { dustAgentUnavailableMessage }
