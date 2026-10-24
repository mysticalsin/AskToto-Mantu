/**
 * The production erasers (Métis 2.12 G82). One per `delete` row of the data-store inventory, keyed by `DataStoreId`.
 *
 * Whole-file and whole-folder stores are removed by the paths the inventory itself names (`paths`, and `partitionPaths`
 * for the files that belong to one memory partition), so there is no second list to drift. Stores that already have an
 * eraser in their own module (meetings, brain, wiki, graph, operator outbox, task browser, artifacts, history cache,
 * credentials) are reached through the `ErasureHost`, which the lifecycle wiring fills from those modules. Nothing here
 * imports Electron, and every outcome is a count or a token: a path or an error never leaves an eraser.
 *
 * Scope: a partition-bound file is only ever this owner's (`{pid}` is the partition in force); the other owners'
 * `.brain-p-*` folders and partition files are never listed, let alone removed.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { DATA_STORES, type DataStoreEntry, type DataStoreId } from '@shared/data-store-inventory'
import type { EraserOutcome, StoreEraser } from './erasure-orchestrator'

export interface ErasureHost {
  userData(): string
  /** The partition in force, or null when none is verified (every partition-bound eraser then fails closed). */
  partitionId(): string | null
  meetingsFolder(): string
  /** Absolute root of this owner's knowledge store (`.brain` or `.brain-p-<id>` in the meetings folder). */
  brainRoot(): string
  deleteMeetings(): Promise<{ ok: boolean; deleted: number; failed: number }>
  /** How many saved meetings of Métis's own are in the meetings folder. */
  meetingCount(): Promise<number>
  purgeBrain(): { ok: boolean }
  removeWiki(): { ok: boolean }
  purgeGraph(): void
  clearArtifacts(): void
  clearHistoryCache(): void
  clearTaskBrowserProfile(): Promise<boolean>
  purgeOperatorQueue(): void
  clearMainLog(): Promise<void>
  /** G20 `accountSwitch` cleanup. */
  runCredentialCleanup(): Promise<{ failed: number }>
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function removeAll(paths: readonly string[]): Promise<{ removed: number; failed: boolean }> {
  let removed = 0
  let failed = false
  for (const path of paths) {
    if (!(await exists(path))) continue
    try {
      await rm(path, { recursive: true, force: true })
      removed += 1
    } catch {
      failed = true
    }
  }
  return { removed, failed }
}

const outcomeOf = (result: { removed: number; failed: boolean }): { outcome: EraserOutcome; count: number } => ({
  outcome: result.failed ? 'failed' : result.removed > 0 ? 'erased' : 'nothing',
  count: result.removed
})

/** Absolute paths one inventory row names under userData, for the partition in force. */
export function pathsOf(entry: DataStoreEntry, host: Pick<ErasureHost, 'userData' | 'partitionId'>): string[] | null {
  const out = (entry.paths ?? []).map((p) => join(host.userData(), p))
  if (entry.partitionPaths?.length) {
    const pid = host.partitionId()
    if (!pid || !/^(?:legacy|[0-9a-f]{24})$/.test(pid)) return null
    for (const p of entry.partitionPaths) out.push(join(host.userData(), p.replace('{pid}', pid)))
  }
  return out
}

function pathEraser(entry: DataStoreEntry, host: ErasureHost, extra?: () => Promise<void> | void): StoreEraser {
  return {
    async erase() {
      const paths = pathsOf(entry, host)
      if (!paths) return { outcome: 'failed' }
      const result = await removeAll(paths)
      try {
        await extra?.()
      } catch {
        return { outcome: 'failed' }
      }
      return outcomeOf(result)
    },
    async present() {
      const paths = pathsOf(entry, host)
      if (!paths) return true
      for (const path of paths) if (await exists(path)) return true
      return false
    }
  }
}

/** Siblings of the brain root in the meetings folder that belong to this owner: the store, its backup, preserved copy and escrow. */
async function brainSiblings(host: ErasureHost): Promise<string[]> {
  const root = host.brainRoot()
  const base = basename(root)
  let names: string[] = []
  try {
    names = await readdir(dirname(root))
  } catch {
    return []
  }
  return names
    .filter((n) => n === base || n.startsWith(`${base}.`) || n.startsWith(`${base}-preserved`))
    .map((n) => join(dirname(root), n))
}

/** Drafts and half-written saves Métis itself leaves in the meetings folder. */
const OWN_LEFTOVER = /^(?:\.autosave-draft-.*\.md|.+\.md\.[0-9a-f]+\.tmp)$/

async function leftovers(host: ErasureHost): Promise<string[]> {
  try {
    const folder = host.meetingsFolder()
    return (await readdir(folder)).filter((n) => OWN_LEFTOVER.test(n)).map((n) => join(folder, n))
  } catch {
    return []
  }
}

async function crashLogs(host: ErasureHost): Promise<string[]> {
  try {
    return (await readdir(host.userData()))
      .filter((n) => /^crash-.*\.log$/.test(n))
      .map((n) => join(host.userData(), n))
  } catch {
    return []
  }
}

/** The erasers keyed by inventory id. A `delete` row with no entry here is reported `failed` by the orchestrator. */
export function createProductionErasers(host: ErasureHost): Partial<Record<DataStoreId, StoreEraser>> {
  const entry = (id: DataStoreId): DataStoreEntry => {
    const found = DATA_STORES.find((e) => e.id === id)
    if (!found) throw new Error('unknown data store')
    return found
  }
  const hook = (run: () => Promise<void> | void): StoreEraser => ({
    async erase() {
      await run()
      return { outcome: 'erased' }
    }
  })
  const brain: StoreEraser = {
    async erase() {
      const purged = host.purgeBrain()
      const swept = await removeAll(await brainSiblings(host))
      const left = await brainSiblings(host)
      return { outcome: !purged.ok || swept.failed || left.length > 0 ? 'failed' : 'erased', count: swept.removed }
    },
    async present() {
      return (await brainSiblings(host)).length > 0
    }
  }
  return {
    meetings: {
      async erase() {
        const result = await host.deleteMeetings()
        if (!result.ok || result.failed > 0) return { outcome: 'failed', count: result.deleted }
        return { outcome: result.deleted > 0 ? 'erased' : 'nothing', count: result.deleted }
      },
      present: async () => (await host.meetingCount()) > 0
    },
    'meeting-drafts': {
      async erase() {
        return outcomeOf(await removeAll(await leftovers(host)))
      },
      async present() {
        return (await leftovers(host)).length > 0
      }
    },
    'meeting-journal': pathEraser(entry('meeting-journal'), host),
    'save-receipts': pathEraser(entry('save-receipts'), host),
    'import-jobs': pathEraser(entry('import-jobs'), host),
    'dictation-memory': pathEraser(entry('dictation-memory'), host),
    brain,
    'brain-backup': brain,
    'brain-preserved': brain,
    wiki: {
      async erase() {
        return { outcome: host.removeWiki().ok ? 'erased' : 'failed' }
      }
    },
    graph: pathEraser(entry('graph'), host, () => host.purgeGraph()),
    assistants: pathEraser(entry('assistants'), host),
    'user-memory': pathEraser(entry('user-memory'), host),
    'context-snapshots': pathEraser(entry('context-snapshots'), host),
    'connector-accounts': pathEraser(entry('connector-accounts'), host),
    'desktop-tasks': pathEraser(entry('desktop-tasks'), host),
    'desktop-task-acks': pathEraser(entry('desktop-task-acks'), host),
    voiceprints: pathEraser(entry('voiceprints'), host),
    'artifacts-registry': hook(() => host.clearArtifacts()),
    'task-browser-profile': {
      async erase() {
        return { outcome: (await host.clearTaskBrowserProfile()) ? 'erased' : 'failed' }
      }
    },
    'operator-outbox': hook(() => host.purgeOperatorQueue()),
    'mcp-push-queue': pathEraser(entry('mcp-push-queue'), host),
    'history-cache': hook(() => host.clearHistoryCache()),
    'crash-logs': {
      async erase() {
        return outcomeOf(await removeAll(await crashLogs(host)))
      },
      async present() {
        return (await crashLogs(host)).length > 0
      }
    },
    'stall-bundles': pathEraser(entry('stall-bundles'), host),
    'responsiveness-report': pathEraser(entry('responsiveness-report'), host),
    'time-saved-log': pathEraser(entry('time-saved-log'), host),
    'export-receipts': pathEraser(entry('export-receipts'), host),
    'main-log': hook(() => host.clearMainLog()),
    credentials: {
      async erase() {
        const receipt = await host.runCredentialCleanup()
        return { outcome: receipt.failed > 0 ? 'failed' : 'erased' }
      }
    }
  }
}
