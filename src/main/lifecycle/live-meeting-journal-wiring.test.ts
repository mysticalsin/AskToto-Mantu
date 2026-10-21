import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMain } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudSpeechEvent } from '@shared/cloud-speech'
import type { OwnerSessionRef, OwnerSessionRevokeReason } from '@shared/contracts/owner-session'
import { DEFAULT_SETTINGS, IPC, type Settings } from '@shared/ipc'
import type { TranscriptLine } from '@shared/transcript-line'
import { app, safeStorage } from 'electron'
import type { LiveJournalKeyCustody } from '../features/meetings/live-meeting-journal'
import type { AuthorizeSender } from '../ipc/sender-auth'
import { resetSecretKeyCache } from '../secrets'
import type { SettingsObservation } from '../settings-observation'
import { bootstrapLiveMeetingJournal, liveMeetingJournalAllowed } from './live-meeting-journal-wiring'

vi.mock('electron')

const STARTED_AT = Date.parse('2026-10-21T15:00:00.000Z')
const CAPTURE_ID = '11111111-1111-4111-8111-111111111111'
const OWNER = 'a'.repeat(64)
const mockGetPath = app.getPath as ReturnType<typeof vi.fn>
const observe = (settings: Partial<Settings> = {}, readable = true): SettingsObservation => ({
  settings: { ...DEFAULT_SETTINGS, ...settings },
  readable,
  epoch: 1
})

let userData: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'metis-journal-wiring-'))
  mockGetPath.mockImplementation((name: string) => (name === 'userData' ? userData : join(userData, name)))
  resetSecretKeyCache()
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
})

afterEach(() => {
  resetSecretKeyCache()
  rmSync(userData, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('liveMeetingJournalAllowed', () => {
  it('is on by default once settings are readable and the speech policy is installed', () => {
    expect(DEFAULT_SETTINGS.liveMeetingJournal).toBe(true)
    expect(liveMeetingJournalAllowed(observe(), true)).toBe(true)
  })

  it('is off for the kill switch, an unreadable or absent settings snapshot, a missing policy and summary-only profiles', () => {
    expect(liveMeetingJournalAllowed(observe({ liveMeetingJournal: false }), true)).toBe(false)
    expect(liveMeetingJournalAllowed(observe({}, false), true)).toBe(false)
    expect(liveMeetingJournalAllowed(null, true)).toBe(false)
    expect(liveMeetingJournalAllowed(observe(), false)).toBe(false)
    const summaryOnly = observe({
      enterpriseLive: { managed: true, inferenceMode: 'cloud-only', summaryOnly: true }
    } as Partial<Settings>)
    expect(liveMeetingJournalAllowed(summaryOnly, true)).toBe(false)
  })
})

function line(index: number): TranscriptLine {
  const text = `wiring sentence ${index} spoken aloud`
  const speech: Extract<CloudSpeechEvent, { type: 'segment' }> = {
    type: 'segment',
    captureId: CAPTURE_ID,
    captureGeneration: 1,
    sequence: index,
    segment: {
      stream: { generation: 1, track: 'system', epoch: 1 },
      engine: 'deepgram-nova3',
      index,
      revision: 1,
      final: true,
      text,
      startMs: index * 1_000,
      endMs: index * 1_000 + 900
    }
  }
  return { speaker: 'them', text, t: STARTED_AT + index, speech }
}

function wiring(options: { settings?: SettingsObservation | null } = {}) {
  let handler: ((event: unknown, raw: unknown) => Promise<{ status: string }>) | undefined
  const ipcMain = {
    handle: vi.fn((channel: string, fn: unknown) => {
      expect(channel).toBe(IPC.appendMeetingJournal)
      handler = fn as typeof handler
    })
  }
  const bindings = new Map([[STARTED_AT, { frameOwner: '7:3' as const, ownerKey: OWNER as string | null }]])
  let onMeetingEnd: ((startedAt: number) => void) | undefined
  let onRevoked: ((ref: OwnerSessionRef, reason: OwnerSessionRevokeReason) => void) | undefined
  let onWillQuit: (() => void) | undefined
  const settings = { current: options.settings === undefined ? observe() : options.settings }
  const keys: LiveJournalKeyCustody = {
    generate: vi.fn(() => Buffer.alloc(32, 5)),
    wrap: vi.fn(() => ({ ok: true as const, wrapped: 'F:' + Buffer.alloc(40, 1).toString('base64') })),
    unwrap: vi.fn(() => ({ ok: true as const, key: Buffer.alloc(32, 5), keychainRecovery: false })),
    writeFile: vi.fn(async () => ({ ok: true as const })),
    readFile: vi.fn(async () => ({ ok: false as const, reason: 'missing' as const }))
  }
  const journal = bootstrapLiveMeetingJournal({
    ipcMain: ipcMain as unknown as Pick<IpcMain, 'handle'>,
    authorizeSender: vi.fn(() => null) as unknown as AuthorizeSender,
    requireAuth: () => true,
    store: { bindingOf: (startedAt) => bindings.get(startedAt) ?? null },
    ownerSession: {
      onRevoked: (cb) => {
        onRevoked = cb
        return () => undefined
      }
    },
    onMeetingEnd: (listener) => {
      onMeetingEnd = listener
      return () => undefined
    },
    readSettings: () => settings.current,
    userDataPath: () => userData,
    authGeneration: () => 1,
    audit: vi.fn(),
    onWillQuit: (listener) => {
      onWillQuit = listener
    },
    keys,
    policyInstalled: () => true
  })
  const invoke = (raw: unknown) =>
    handler!({ sender: { id: 1 }, senderFrame: { parent: null, url: 'app://x', processId: 7, routingId: 3 } }, raw)
  return {
    ipcMain,
    journal,
    keys,
    settings,
    invoke,
    endMeeting: () => onMeetingEnd?.(STARTED_AT),
    revoke: (ownerKey: string) => onRevoked?.({ ownerKey } as OwnerSessionRef, 'sign-out'),
    quit: () => onWillQuit?.()
  }
}

describe('bootstrapLiveMeetingJournal', () => {
  it('registers the write seam on construction and does no I/O until a record arrives', () => {
    const w = wiring()
    expect(w.ipcMain.handle).toHaveBeenCalledTimes(1)
    expect(readdirSync(userData)).toEqual([])
    expect(w.journal.activeMeetings()).toEqual([])
  })

  it('journals through the registered handler and ends the session when the meeting ends', async () => {
    const w = wiring()
    await expect(w.invoke({ startedAt: STARTED_AT, line: line(1) })).resolves.toEqual({ status: 'durable' })
    expect(w.journal.activeMeetings()).toEqual([STARTED_AT])
    w.endMeeting()
    await vi.waitFor(() => expect(w.journal.activeMeetings()).toEqual([]))
  })

  it('ends only the revoked owner on owner-session revocation', async () => {
    const w = wiring()
    await w.invoke({ startedAt: STARTED_AT, line: line(1) })
    w.revoke('b'.repeat(64))
    expect(w.journal.activeMeetings()).toEqual([STARTED_AT])
    w.revoke(OWNER)
    await vi.waitFor(() => expect(w.journal.activeMeetings()).toEqual([]))
  })

  it('disposes every session at will-quit', async () => {
    const w = wiring()
    await w.invoke({ startedAt: STARTED_AT, line: line(1) })
    w.quit()
    await vi.waitFor(() => expect(w.journal.activeMeetings()).toEqual([]))
  })

  it('does no journal I/O at all with the kill switch off, and refuses through the same handler', async () => {
    const w = wiring({ settings: observe({ liveMeetingJournal: false }) })
    await expect(w.invoke({ startedAt: STARTED_AT, line: line(1) })).resolves.toEqual({ status: 'refused' })
    expect(readdirSync(userData)).toEqual([])
    for (const fn of Object.values(w.keys)) expect(fn).not.toHaveBeenCalled()
  })

  it('follows the switch live: turning it off mid-meeting stops further writes', async () => {
    const w = wiring()
    await expect(w.invoke({ startedAt: STARTED_AT, line: line(1) })).resolves.toEqual({ status: 'durable' })
    w.settings.current = observe({ liveMeetingJournal: false })
    await expect(w.invoke({ startedAt: STARTED_AT, line: line(2) })).resolves.toEqual({ status: 'refused' })
    expect(w.journal.activeMeetings()).toEqual([])
  })
})
