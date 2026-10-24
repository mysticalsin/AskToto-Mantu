import { app, BrowserWindow, dialog } from 'electron'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_STORES } from '@shared/data-store-inventory'
import type { DataExportDeps, ErasureHost } from '../features/data-rights'
import type { AssistantService } from '../features/assistants'
import type { ArtifactRegistry } from '../features/artifacts'
import type { DictationMemory } from '../features/dictation'
import type { UserMemory } from '../features/user-memory'
import { createExportService, type ExportService } from '../features/export/export-service'
import { eraseLegacyOwnedMeetings } from '../features/data-rights/legacy-meetings'
import { legacyMeetingsFolderOf } from '../infra/storage/paths'
import { whenDrainSettles, whenIndexWritesSettle } from '../brain/ingest'
import { brainDir } from '../brain/brain-root'
import { removeWiki } from '../brain/publish'
import { loadAccount, loadDeal, loadEntitySlugs, loadPerson, purgeBrain } from '../brain/store'
import { runCredentialCleanup } from '../credential-cleanup'
import { productionClearers } from '../credential-clearers'
import { purgeGraphArtifacts } from '../graphify'
import { clearHistoryReadCache, listMeetings } from '../history-read'
import { MeetingNotDownloadedError, readSavedMeeting } from '../history-actions'
import { clearMainLogFile } from '../logger'
import { isOwnedMeetingFile } from '../meeting-privacy'
import { memoryAccess } from '../memory-partition/memory-access'
import { purgeOperatorQueue } from '../operator-queue'
import { deleteAllMeetings } from '../recall'
import { getSettings } from '../store'
import { taskBrowserRuntime } from '../task-browser/task-browser-runtime'
import { resolveMeetingsFolder } from '../transcripts'
import { collectExtraRecords, type ExportedEntity } from './data-rights-export-records'

export interface ProductionDataRightsParts {
  artifacts: Pick<ArtifactRegistry, 'clear'>
  assistants: Pick<AssistantService, 'list'>
  userMemory: Pick<UserMemory, 'list'>
  dictionary: Pick<DictationMemory, 'dictionaryList'>
}

/** The G58 export receipt log shares its file with every other export: the path comes from the inventory row. */
const EXPORT_RECEIPTS = DATA_STORES.find((entry) => entry.id === 'export-receipts')?.paths?.[0] ?? ''

const exportService: ExportService = createExportService({
  showSaveDialog: (options) => {
    const window = BrowserWindow.getFocusedWindow()
    return window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options)
  },
  showMessageBox: (options) => {
    const window = BrowserWindow.getFocusedWindow()
    return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options)
  },
  receiptLogPath: () => join(app.getPath('userData'), EXPORT_RECEIPTS)
})

/** Entities are derived from meetings; each names the meeting files it came from so the manifest can say so. */
async function exportedEntities(): Promise<ExportedEntity[]> {
  const settings = getSettings()
  const out: ExportedEntity[] = []
  const load = { person: loadPerson, account: loadAccount, deal: loadDeal } as const
  for (const kind of ['person', 'account', 'deal'] as const) {
    for (const slug of await loadEntitySlugs(settings, kind)) {
      const record = await load[kind](settings, slug)
      if (!record) continue
      const meetings = record.meetings.map(({ file, date, title }) => ({ file, date, title }))
      out.push({
        kind,
        slug,
        record: { ...record, meetings },
        meetingFiles: meetings.map((meeting) => meeting.file),
        modifiedAt: Math.max(0, ...meetings.map((meeting) => Date.parse(meeting.date) || 0))
      })
    }
  }
  return out
}

/** The quiesce wait stops at this bound so a slow provider call never holds the erasure open. */
const QUIESCE_BOUND_MS = 10_000

const bounded = (work: Promise<unknown>): Promise<void> =>
  new Promise<void>((resolve) => {
    AbortSignal.timeout(QUIESCE_BOUND_MS).addEventListener('abort', () => resolve(), { once: true })
    work.then(
      () => resolve(),
      () => resolve()
    )
  })

/**
 * Binds the data-rights erasers to the modules that own each store (G82). Everything resolves on use: the settings, the
 * meetings folder and the partition in force can change between calls, and nothing here caches a path.
 */
export function createProductionDataRights(parts: ProductionDataRightsParts): {
  host: ErasureHost
  quiesce(): Promise<void>
  exportDeps: Omit<DataExportDeps, 'now'>
} {
  const ownedMeetings = async (): Promise<string[]> => {
    const folder = resolveMeetingsFolder(getSettings())
    const out: string[] = []
    for (const row of await listMeetings())
      if ((await isOwnedMeetingFile(folder, row.file)) === true) out.push(row.file)
    return out
  }
  const host: ErasureHost = {
    userData: () => app.getPath('userData'),
    partitionId: () => {
      const access = memoryAccess()
      return access.status === 'ok' ? access.partitionId : null
    },
    meetingsFolder: () => resolveMeetingsFolder(getSettings()),
    brainRoot: () => brainDir(getSettings()),
    async deleteMeetings() {
      const result = await deleteAllMeetings()
      const legacy = await eraseLegacyOwnedMeetings({
        folder: legacyMeetingsFolderOf(resolveMeetingsFolder(getSettings())),
        isOwned: isOwnedMeetingFile
      })
      return {
        ok: result.ok && legacy.failed === 0,
        deleted: result.deleted + legacy.deleted,
        failed: result.failed.length + legacy.failed
      }
    },
    meetingCount: async () => (await ownedMeetings()).length,
    purgeBrain: () => purgeBrain(getSettings(), { mode: 'erase' }),
    removeWiki: () => removeWiki(getSettings()),
    purgeGraph: () => void purgeGraphArtifacts(),
    clearArtifacts: () => parts.artifacts.clear(),
    clearHistoryCache: () => clearHistoryReadCache(),
    clearTaskBrowserProfile: () => taskBrowserRuntime().clearProfile(),
    purgeOperatorQueue: () => purgeOperatorQueue(app.getPath('userData')),
    clearMainLog: async () => clearMainLogFile(),
    async runCredentialCleanup() {
      const receipt = await runCredentialCleanup('accountSwitch', productionClearers())
      return { failed: receipt.failed }
    }
  }
  const exportDeps: Omit<DataExportDeps, 'now'> = {
    listMeetingFiles: ownedMeetings,
    async readMeeting(file) {
      const folder = resolveMeetingsFolder(getSettings())
      try {
        const markdown = await readSavedMeeting(folder, file)
        if (!markdown) return { status: 'unreadable' }
        const info = await stat(join(folder, file))
        return { status: 'ok', markdown, modifiedAt: Math.trunc(info.mtimeMs), origin: 'meeting-capture' }
      } catch (error) {
        return { status: error instanceof MeetingNotDownloadedError ? 'not-downloaded' : 'unreadable' }
      }
    },
    extraRecords: () =>
      collectExtraRecords({
        async assistants() {
          const listed = await parts.assistants.list()
          return listed.ok ? listed.assistants.filter((assistant) => !assistant.system) : []
        },
        userMemory: () => parts.userMemory.list(),
        dictionary: () => parts.dictionary.dictionaryList(),
        brainEntities: exportedEntities
      }),
    exportDirectory: (request) => exportService.exportDirectory(request),
    appVersion: () => app.getVersion()
  }
  return {
    host,
    // The fence has just closed admission for every queued ingest job, so this only waits for them to wind down.
    quiesce: () => bounded(whenDrainSettles().then(() => whenIndexWritesSettle())),
    exportDeps
  }
}
