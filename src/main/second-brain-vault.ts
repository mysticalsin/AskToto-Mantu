/**
 * Onboarding second-brain vault probe (DESIGN.md "Onboarding second brain + no-flash").
 *
 * Maps OneDrive / Documents for an existing Obsidian vault named "AI Second Brain".
 * Pure filesystem math: no Electron dialogs, no Dust/Claude writer (Devon).
 * Offline OneDrive is a first-class status. Never mkdir to fake a hit.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SecondBrainDetectResult, SecondBrainStatus } from '@shared/ipc'

export type { SecondBrainDetectResult, SecondBrainStatus }

export const AI_SECOND_BRAIN_VAULT_NAME = 'AI Second Brain'
export const DUST_VAULT_INBOX_REL = '00_Inbox/from-dust'
export const DUST_VAULT_INBOX_SEGMENTS = ['00_Inbox', 'from-dust'] as const

export type PathKind = 'dir' | 'file' | 'absent' | 'offline'

export interface VaultFs {
  inspect(path: string): { kind: PathKind; names?: string[] }
}

export type SecondBrainEnv = {
  home: string
  documents: string
  /** Existing OneDrive sync roots (Windows env / detectOneDrive / ~/OneDrive). Empty if none. */
  oneDriveRoots: string[]
  /** macOS CloudStorage folder. Default: ~/Library/CloudStorage */
  cloudStorage?: string
}

const OFFLINE_ERRNO = new Set([
  'EIO',
  'EBUSY',
  'EPERM',
  'EACCES',
  'ENOTCONN',
  'EAGAIN',
  'ETIMEDOUT',
  'EUNKNOWN',
  'UNKNOWN'
])

function errnoCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return (err as { code: string }).code
  }
  return ''
}

export function isOfflineErrno(err: unknown): boolean {
  return OFFLINE_ERRNO.has(errnoCode(err))
}

export function nodeVaultFs(): VaultFs {
  return {
    inspect(path: string) {
      try {
        const st = statSync(path)
        if (!st.isDirectory()) return { kind: 'file' as const }
        try {
          return { kind: 'dir' as const, names: readdirSync(path) }
        } catch (err) {
          return { kind: isOfflineErrno(err) ? ('offline' as const) : ('absent' as const) }
        }
      } catch (err) {
        if (errnoCode(err) === 'ENOENT' || errnoCode(err) === 'ENOTDIR') return { kind: 'absent' as const }
        if (isOfflineErrno(err)) return { kind: 'offline' as const }
        return { kind: 'absent' as const }
      }
    }
  }
}

export function dustInboxPath(vaultPath: string): string {
  return join(vaultPath, ...DUST_VAULT_INBOX_SEGMENTS)
}

function unique(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    if (!p || seen.has(p)) continue
    seen.add(p)
    out.push(p)
  }
  return out
}

/** CloudStorage OneDrive-* roots. Personal (not SharedLibraries) first, then any OneDrive*. */
export function listCloudOneDriveRoots(fs: VaultFs, cloudStorage: string): { roots: string[]; offline: boolean } {
  const hit = fs.inspect(cloudStorage)
  if (hit.kind === 'offline') return { roots: [], offline: true }
  if (hit.kind !== 'dir' || !hit.names) return { roots: [], offline: false }
  const personal = hit.names.filter((d) => /^OneDrive-(?!SharedLibraries)/i.test(d))
  const any = hit.names.filter((d) => /^OneDrive/i.test(d))
  const names = personal.length ? personal : any
  return { roots: names.map((d) => join(cloudStorage, d)), offline: false }
}

export function candidateVaultPaths(env: SecondBrainEnv, cloudRoots: string[]): string[] {
  const docs = env.documents || join(env.home, 'Documents')
  const out: string[] = []
  for (const root of cloudRoots) {
    out.push(join(root, 'Documents', AI_SECOND_BRAIN_VAULT_NAME))
  }
  for (const root of env.oneDriveRoots) {
    out.push(join(root, 'Documents', AI_SECOND_BRAIN_VAULT_NAME))
    out.push(join(root, AI_SECOND_BRAIN_VAULT_NAME))
  }
  out.push(join(docs, AI_SECOND_BRAIN_VAULT_NAME))
  return unique(out)
}

export function preferredCreatePath(env: SecondBrainEnv, cloudRoots: string[]): string {
  const firstCloud = cloudRoots[0]
  if (firstCloud) return join(firstCloud, 'Documents', AI_SECOND_BRAIN_VAULT_NAME)
  const firstDrive = env.oneDriveRoots[0]
  if (firstDrive) return join(firstDrive, 'Documents', AI_SECOND_BRAIN_VAULT_NAME)
  return join(env.documents || join(env.home, 'Documents'), AI_SECOND_BRAIN_VAULT_NAME)
}

/**
 * Probe typical OneDrive / Documents locations.
 * found = first readable directory named AI Second Brain (`.obsidian` not required).
 * offline = OneDrive is present but unreadable; never treat that as not-found-so-create.
 * not-found = every candidate was absent and OneDrive (if any) was readable.
 */
export function detectSecondBrainVault(env: SecondBrainEnv, fs: VaultFs = nodeVaultFs()): SecondBrainDetectResult {
  const cloudStorage = env.cloudStorage ?? join(env.home, 'Library', 'CloudStorage')
  const cloud = listCloudOneDriveRoots(fs, cloudStorage)
  if (cloud.offline) {
    return {
      status: 'offline',
      suggestedPath: preferredCreatePath(env, []),
      reason: 'OneDrive is not available'
    }
  }
  const candidates = candidateVaultPaths(env, cloud.roots)
  const suggestedPath = preferredCreatePath(env, cloud.roots)
  let sawOffline = false

  for (const path of candidates) {
    const hit = fs.inspect(path)
    if (hit.kind === 'dir') {
      return { status: 'found', path, suggestedPath }
    }
    if (hit.kind === 'offline') sawOffline = true
  }

  // OneDrive root present but its Documents (or the vault placeholder) is unreadable.
  const driveRoots = unique([...cloud.roots, ...env.oneDriveRoots])
  for (const root of driveRoots) {
    const docs = fs.inspect(join(root, 'Documents'))
    if (docs.kind === 'offline') sawOffline = true
    const rootHit = fs.inspect(root)
    if (rootHit.kind === 'offline') sawOffline = true
  }

  if (sawOffline) {
    return { status: 'offline', suggestedPath, reason: 'OneDrive is not available' }
  }
  return { status: 'not-found', suggestedPath }
}

export function createSecondBrainVault(
  vaultPath: string,
  fsWrite: { mkdir: (path: string) => void } = {
    mkdir: (path: string) => mkdirSync(path, { recursive: true })
  }
): { ok: true; path: string } | { ok: false; status: 'offline'; reason: string } {
  try {
    fsWrite.mkdir(vaultPath)
    fsWrite.mkdir(dustInboxPath(vaultPath))
    return { ok: true, path: vaultPath }
  } catch (err) {
    if (isOfflineErrno(err)) {
      return { ok: false, status: 'offline', reason: 'OneDrive is not available' }
    }
    throw err
  }
}

/** Live env for the IPC handlers (tests inject their own). */
export function liveSecondBrainEnv(oneDriveRoot: string): SecondBrainEnv {
  const home = homedir()
  const extra: string[] = []
  if (process.platform === 'win32') {
    for (const e of [process.env.OneDriveCommercial, process.env.OneDrive, process.env.OneDriveConsumer]) {
      if (e && existsSync(e)) extra.push(e)
    }
  }
  const roots = unique([...extra, oneDriveRoot].filter(Boolean))
  return {
    home,
    documents: join(home, 'Documents'),
    oneDriveRoots: roots,
    cloudStorage: join(home, 'Library', 'CloudStorage')
  }
}
