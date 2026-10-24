/**
 * workspace-ipc.ts — small main-window utilities: on-device eval metrics, recap JSON export, the Graphify
 * knowledge-graph controls, the meetings/team-transcript folder pickers, and the "open brain folder" reveal.
 *
 * Moved verbatim from the main entry point: every handler keeps its channel, main-window sender gate, auth
 * gate and return shape. Native dialogs, shell opens and the existence probe come in through the
 * dependencies so this module holds no window state and no synchronous fs.
 */
import type { IpcMain, IpcMainInvokeEvent, OpenDialogOptions } from 'electron'
import { IPC, type PublicSettings } from '@shared/ipc'
import type { MeetingsFolderPickResult, TeamFolderRefusal } from '@shared/contracts/settings-os-state'
import { getLockedKeys, getSettings, setSettings } from '../store'
import { readEvalMetrics, aggregateMetrics } from '../metrics'
import { RESPONSIVENESS_IPC } from '@shared/responsiveness-ipc'
import { interventionCountersFor, parseInterventionShadowRecord } from '@shared/intervention-shadow'
import { boundedAnswerAskId } from '../ask-stream-registry'
import {
  askTiming,
  type CardOutcomeName,
  emptyResponsivenessReport,
  getResponsivenessRecorder
} from '../infra/observability/responsiveness-recorder'
import { parseRecapMarkdown, resolveMeetingsFolder } from '../transcripts'
import { graphifyStatus, buildGraph, relatedNotes, graphHtml } from '../graphify'
import { wikiDir } from '../brain/publish'
import { probeFolderWritable } from '../infra/storage/folder-writable'
import { checkTeamFolder, teamFolderRefusal } from '../infra/storage/team-folder-check'

export interface WorkspaceIpcDependencies {
  ipcMain: Pick<IpcMain, 'handle'>
  /** Main-window top frame only. */
  assertMainWindow: (event: IpcMainInvokeEvent) => void
  requireAuth: () => boolean
  publicSettings: () => PublicSettings
  /** Native open dialog, attached to the overlay window when it exists. */
  showOpenDialog: (options: OpenDialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>
  /** OS open of a file or folder; resolves to an error string, or '' on success. */
  openPath: (path: string) => Promise<string>
  pathExists: (path: string) => boolean
  /** Async write probe for a chosen meetings folder (defaults to a create-and-remove of one empty file). */
  probeWritable?: (dir: string) => Promise<boolean>
  /** Async readability probe for a chosen team folder (defaults to listing it). */
  canReadFolder?: (dir: string) => Promise<boolean>
}

export function registerWorkspaceIpc(deps: WorkspaceIpcDependencies): void {
  const { ipcMain, assertMainWindow, requireAuth, publicSettings, showOpenDialog, openPath, pathExists } = deps
  const probeWritable = deps.probeWritable ?? probeFolderWritable
  // --- Metrics, export & PDF ---
  // On-device eval metrics from the local audit log (latency p50/p95, acceptance, failures). Read-only,
  // metadata-only — nothing leaves the device. Surfaced in Settings → About → Diagnostics.
  ipcMain.handle(IPC.metricsRead, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return aggregateMetrics([])
    return readEvalMetrics()
  })

  // G12: the responsiveness report (first partial, useful suggestion, display receipt, cancellation, queue
  // health, intervention counters). Counts and latencies only, kept on this device; a metric nobody has
  // measured reads "not measured". Surfaced in Settings → About → Diagnostics.
  ipcMain.handle(RESPONSIVENESS_IPC.report, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return emptyResponsivenessReport()
    const recorder = getResponsivenessRecorder()
    await recorder.ready()
    return recorder.report()
  })

  // The renderer confirms a suggestion it painted. Only a suggestion main marked as shown can be confirmed,
  // so a forged or stale id counts for nothing.
  ipcMain.handle(RESPONSIVENESS_IPC.displayReceipt, (e, askId: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return
    const id = boundedAnswerAskId(askId)
    if (id) askTiming.displayed(id)
  })

  // G71: how a displayed suggestion's duplicate review ended. The payload is the ask id and one name from a
  // closed set (never card text); main counts it once, and only for a suggestion it marked displayed.
  ipcMain.handle(RESPONSIVENESS_IPC.cardOutcome, (e, askId: unknown, outcome: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return
    const id = boundedAnswerAskId(askId)
    if (id && typeof outcome === 'string') askTiming.cardOutcome(id, outcome as CardOutcomeName)
  })

  // G70: one content-free shadow record per intervention decision. Closed enums and integers only; anything
  // else (a text field, an unknown enum) is dropped whole, so no meeting content can ride this channel.
  ipcMain.handle(RESPONSIVENESS_IPC.interventionShadow, (e, value: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return
    const record = parseInterventionShadowRecord(value)
    if (!record) return
    const recorder = getResponsivenessRecorder()
    for (const counter of interventionCountersFor(record)) recorder.increment(counter)
  })

  // Parse a recap's markdown into a structured object (decisions + action-items-with-owners) the renderer
  // can copy as JSON for Jira/Asana/Notion. Pure transform of text the renderer already holds — no disk I/O.
  ipcMain.handle(IPC.exportRecapJson, (e, markdown: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    return parseRecapMarkdown(typeof markdown === 'string' ? markdown : '')
  })

  // --- Graphify knowledge graph ---
  ipcMain.handle(IPC.graphifyStatus, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { enabled: false, installed: false, backend: null, building: false, hasGraph: false }
    return graphifyStatus()
  })

  ipcMain.handle(IPC.graphifyRebuild, (e) => {
    assertMainWindow(e)
    if (!requireAuth()) throw new Error('Not signed in.')
    return buildGraph(false) // explicit user rebuild = full
  })

  ipcMain.handle(IPC.graphifyRelated, (e, file: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, error: 'Not signed in.', topics: [], notes: [] }
    return relatedNotes(String(file || ''))
  })

  ipcMain.handle(IPC.graphifyOpenGraph, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return ''
    const html = graphHtml()
    if (!html) return ''
    await openPath(html)
    return html
  })

  // --- Filesystem pickers ---
  ipcMain.handle(IPC.pickFolder, async (e): Promise<MeetingsFolderPickResult<PublicSettings>> => {
    assertMainWindow(e)
    // Trust boundary is main, not the renderer — this persists a settings write (meetingsFolder), so it
    // must be gated the same as every other settings-writer. Without this, a DevTools/compromised-renderer
    // caller could silently redirect where transcripts are written even with auth enforced.
    if (!requireAuth()) return { ok: false, reason: 'signed-out' }
    // Same LSUIElement-accessory-app reasoning as recapPdf above: anchor to `win` so the dialog actually
    // surfaces instead of silently hanging with nothing to attach to.
    const openDialogOpts: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      message: 'Choose where Métis saves meeting transcripts'
    }
    const r = await showOpenDialog(openDialogOpts)
    const picked = !r.canceled ? r.filePaths[0] : undefined
    if (!picked) return { ok: false, reason: 'cancelled' }
    // HIG (Settings): invalid input is refused inline, and the last valid value stays. A folder Métis cannot
    // write to would make every meeting save fail later, so it is never saved.
    if (!(await probeWritable(picked))) return { ok: false, reason: 'not-writable' }
    setSettings({ meetingsFolder: picked })
    return { ok: true, settings: publicSettings() }
  })

  // Team transcripts: pick a shared folder whose meeting transcripts are ALSO ingested into this brain
  // (settings.teamTranscriptFolders). Appended (deduped) rather than replacing meetingsFolder — this
  // never touches where the user's OWN meetings are saved.
  ipcMain.handle(IPC.addTeamTranscriptFolder, async (e): Promise<PublicSettings | TeamFolderRefusal> => {
    assertMainWindow(e)
    if (!requireAuth()) return publicSettings() // adds a folder to the brain's ingestion set — gate it like every other settings write
    const openDialogOpts: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
      message: "Choose a shared folder whose transcripts feed this brain (e.g. a teammate's meetings folder)"
    }
    const r = await showOpenDialog(openDialogOpts)
    if (!r.canceled && r.filePaths[0]) {
      const picked = r.filePaths[0]
      const current = getSettings().teamTranscriptFolders ?? []
      if (!current.includes(picked)) {
        // setSettings drops a locked key silently, which would read as success; say so instead (D9-10).
        if (getLockedKeys().includes('teamTranscriptFolders')) return teamFolderRefusal('managed')
        const refusal = await checkTeamFolder(picked, {
          meetingsFolder: resolveMeetingsFolder(getSettings()),
          teamFolders: current,
          canRead: deps.canReadFolder
        })
        if (refusal) return refusal
        setSettings({ teamTranscriptFolders: [...current, picked] })
      }
    }
    return publicSettings()
  })
  ipcMain.handle(IPC.removeTeamTranscriptFolder, async (e, folder: unknown) => {
    assertMainWindow(e)
    if (!requireAuth()) return publicSettings()
    const target = typeof folder === 'string' ? folder : ''
    const current = getSettings().teamTranscriptFolders ?? []
    setSettings({ teamTranscriptFolders: current.filter((f) => f !== target) })
    return publicSettings()
  })

  ipcMain.handle(IPC.openPath, (e) => {
    assertMainWindow(e)
    return requireAuth() ? openPath(resolveMeetingsFolder(getSettings())) : ''
  })

  // "Open brain folder for Claude" (the handshake): reveal the published wiki — a plaintext, self-describing
  // mirror with a CLAUDE.md entry doc — so the user can point Claude at it (a Claude Project, Claude Desktop,
  // or a synced-folder connector). Gated on publishBrainPages in the UI; when publishing is on the folder
  // exists (settingsSet fires publishAll on enable). Returns the path so the renderer can show/copy it.
  ipcMain.handle(IPC.openBrainForClaude, async (e) => {
    assertMainWindow(e)
    if (!requireAuth()) return { ok: false, path: '' }
    const s = getSettings()
    const dir = wikiDir(s)
    if (!s.publishBrainPages || !pathExists(dir)) return { ok: false, path: dir }
    await openPath(dir)
    return { ok: true, path: dir }
  })
}
