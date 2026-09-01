/**
 * Dust Connect orchestration — one consent session, then installed = live.
 * See docs/design/DUST-CONNECT.md.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { app } from 'electron'
import {
  countDustPrivilegeSpawns,
  dustBinCandidates,
  isDustCliConnected,
  nextDustConnectStep,
  preferMantuWorkspace,
  type DustConnectStatus,
  type DustPrivilegeEvent,
  type DustWorkspaceOption
} from '@shared/dust-connect'
import type { DustCliImport } from '@shared/ipc'
import { installManagedCli, managedCliEntry } from './cli-installer'
import { resolveDustBin } from './cli'
import { importDustCliSession } from './dustcli'
import { setApiKey, setSettings } from './store'

export interface DustConnectResult extends DustCliImport {
  installed: boolean
  live: boolean
  workspaceName?: string
  privilegeSpawns: number
  needsLogin?: boolean
  version?: string
}

export interface DustDetectResult extends DustConnectStatus {
  bin: string | null
  version?: string
}

export function createDustConsentSession(sessionId: string = `dust-connect-${Date.now()}`): {
  sessionId: string
  events: DustPrivilegeEvent[]
  record: (kind: DustPrivilegeEvent['kind']) => void
  count: () => number
} {
  const events: DustPrivilegeEvent[] = []
  return {
    sessionId,
    events,
    record: (kind) => {
      events.push({ kind, sessionId })
    },
    count: () => countDustPrivilegeSpawns(events)
  }
}

/**
 * Walk install → (optional) import under one consent session.
 * Login is the existing native OAuth / browser step — not a second OS password.
 * Privilege children (Keychain/osascript/UAC/npm-global) share this sessionId so the count is 1.
 */
export async function runDustConnectInstall(opts?: {
  session?: ReturnType<typeof createDustConsentSession>
  onProgress?: (line: string) => void
}): Promise<DustConnectResult> {
  const session = opts?.session ?? createDustConsentSession()
  const onProgress = opts?.onProgress ?? ((): void => {})

  // Install is userData — no sudo, no UAC. Recording authorization marks the one Connect consent
  // so a later keychain import does not open a second session id (Tony's three passwords).
  session.record('authorization')

  let bin = await resolveDustBin()
  const step = nextDustConnectStep({
    binaryPresent: !!bin,
    sessionLive: false,
    installAttempted: false,
    installOk: null,
    loginAttempted: false
  })

  if (step.action === 'install') {
    onProgress('Installing Dust CLI…')
    try {
      const installed = await installManagedCli('dust', (p) => {
        if (p.phase === 'downloading' && p.totalBytes) {
          const pct = Math.floor(((p.receivedBytes ?? 0) / p.totalBytes) * 100)
          onProgress(`Downloading Dust CLI… ${pct}%`)
        } else if (p.phase === 'resolving') onProgress('Finding Dust CLI…')
        else if (p.phase === 'verifying') onProgress('Verifying Dust CLI…')
        else if (p.phase === 'extracting') onProgress('Installing Dust CLI…')
      })
      onProgress(`Installed Dust CLI v${installed.version}.`)
      bin = installed.entry
    } catch (e) {
      return {
        ok: false,
        installed: false,
        live: false,
        privilegeSpawns: session.count(),
        error: e instanceof Error ? e.message : 'Could not install the Dust CLI.'
      }
    }
  }

  bin = bin ?? (await resolveDustBin())
  if (!bin || !existsSync(bin)) {
    return {
      ok: false,
      installed: false,
      live: false,
      privilegeSpawns: session.count(),
      error: 'Dust CLI is not yet installed.'
    }
  }

  // One secret-store spawn, same session — not a second Keychain password.
  session.record('keychain')
  const imported = await importDustCliSession()
  if (imported.ok && imported.workspaceId && imported.token) {
    setApiKey('dust', imported.token)
    setSettings({
      dustWorkspaceId: imported.workspaceId,
      dustBaseUrl: imported.baseUrl || 'https://dust.tt',
      dustTokenMintedAt: Date.now(),
      dustSessionOrigin: 'cli'
    })
    const status: DustConnectStatus = {
      installed: true,
      live: true,
      workspaceId: imported.workspaceId
    }
    return {
      ok: true,
      installed: true,
      live: isDustCliConnected(status),
      workspaceId: imported.workspaceId,
      baseUrl: imported.baseUrl,
      privilegeSpawns: session.count(),
      version: managedCliEntry('dust')?.version
    }
  }

  return {
    ok: imported.accessDenied || imported.incomplete ? false : true,
    installed: true,
    live: false,
    needsLogin: !imported.accessDenied && !imported.incomplete,
    accessDenied: imported.accessDenied,
    incomplete: imported.incomplete,
    privilegeSpawns: session.count(),
    error: imported.error,
    version: managedCliEntry('dust')?.version
  }
}

export async function detectDustCli(persisted?: {
  hasKey?: boolean
  workspaceId?: string
  workspaceName?: string
}): Promise<DustDetectResult> {
  const bin = await resolveDustBin()
  const installed = !!bin
  const live = installed && !!persisted?.hasKey && !!persisted.workspaceId?.trim()
  return {
    installed,
    live,
    bin,
    workspaceId: persisted?.workspaceId,
    workspaceName: persisted?.workspaceName,
    version: managedCliEntry('dust')?.version
  }
}

/** Exported for Windows Quality: the Connect path never lists a global npm prefix as a privilege spawn. */
export function dustConnectPrivilegePlan(platform: NodeJS.Platform): DustPrivilegeEvent[] {
  const sessionId = 'dust-connect-plan'
  const events: DustPrivilegeEvent[] = [{ kind: 'authorization', sessionId }]
  if (platform === 'darwin') events.push({ kind: 'keychain', sessionId })
  if (platform === 'win32') events.push({ kind: 'keychain', sessionId }) // one CredRead, never uac / npm-global
  return events
}

export function dustConnectDetectOrder(userData?: string, home?: string, platform: NodeJS.Platform = process.platform): string[] {
  let managed: string | null = null
  try {
    managed = managedCliEntry('dust')?.entry ?? null
  } catch {
    managed = null
  }
  return dustBinCandidates({
    platform,
    userData: userData ?? ((): string => {
      try {
        return app.getPath('userData')
      } catch {
        return ''
      }
    })(),
    home: home ?? homedir(),
    managedEntry: managed
  })
}

export { preferMantuWorkspace, type DustWorkspaceOption }

/** Test helper: prove the install+login sequence records one spawn without touching the OS. */
export function mockDustConnectPrivilegeSequence(platform: NodeJS.Platform): {
  privilegeSpawns: number
  kinds: DustPrivilegeEvent['kind'][]
} {
  const events = dustConnectPrivilegePlan(platform)
  return {
    privilegeSpawns: countDustPrivilegeSpawns(events),
    kinds: events.map((e) => e.kind)
  }
}
