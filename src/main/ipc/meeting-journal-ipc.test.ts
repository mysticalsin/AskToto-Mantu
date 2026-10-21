import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloudSpeechEvent } from '@shared/cloud-speech'
import { IPC } from '@shared/ipc'
import type { TranscriptLine } from '@shared/transcript-line'
import { app, safeStorage } from 'electron'
import { resetSecretKeyCache } from '../secrets'
import { createLiveMeetingJournal, type LiveMeetingJournal } from '../features/meetings/live-meeting-journal'
import {
  generateContentKey,
  readWrappedKeyFile,
  unwrapContentKey,
  wrapContentKey,
  writeWrappedKeyFile
} from '../infra/security/content-key-wrap'
import { registerMeetingJournalIpc } from './meeting-journal-ipc'
import { SenderRefusal, type AuthorizeSender } from './sender-auth'

vi.mock('electron')

const STARTED_AT = Date.parse('2026-10-21T15:00:00.000Z')
const CAPTURE_ID = '11111111-1111-4111-8111-111111111111'
const mockGetPath = app.getPath as ReturnType<typeof vi.fn>

let userData: string

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'metis-journal-ipc-'))
  mockGetPath.mockImplementation((name: string) => (name === 'userData' ? userData : join(userData, name)))
  resetSecretKeyCache()
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true)
})

afterEach(() => {
  resetSecretKeyCache()
  rmSync(userData, { recursive: true, force: true })
  vi.clearAllMocks()
})

function cloudLine(index: number, overrides: Partial<TranscriptLine> = {}): TranscriptLine {
  const text = `ordinary sentence number ${index} for the record`
  const speech: Extract<CloudSpeechEvent, { type: 'segment' }> = {
    type: 'segment',
    captureId: CAPTURE_ID,
    captureGeneration: 2,
    sequence: index,
    segment: {
      stream: { generation: 2, track: 'microphone', epoch: 1 },
      engine: 'deepgram-nova3',
      index,
      revision: 1,
      final: true,
      text,
      startMs: index * 1_000,
      endMs: index * 1_000 + 900
    }
  }
  return { speaker: 'you', text, t: STARTED_AT + index * 1_000, speech, ...overrides }
}

type Handler = (event: unknown, raw: unknown) => Promise<{ status: string }>

function harness(
  options: { signedIn?: boolean; binding?: { frameOwner: string; ownerKey: string | null } | null } = {}
) {
  let handler: Handler | undefined
  const channels: string[] = []
  const ipcMain = {
    handle: vi.fn((channel: string, fn: Handler) => {
      channels.push(channel)
      handler = fn
    })
  }
  const authorizeSender = vi.fn(() => null) as unknown as AuthorizeSender & ReturnType<typeof vi.fn>
  const requireAuth = vi.fn(() => options.signedIn !== false)
  const binding = options.binding === undefined ? { frameOwner: '7:3', ownerKey: null } : options.binding
  const keys = {
    generate: generateContentKey,
    wrap: wrapContentKey,
    unwrap: (wrapped: string) => unwrapContentKey(wrapped),
    writeFile: writeWrappedKeyFile,
    readFile: readWrappedKeyFile
  }
  const journal: LiveMeetingJournal = createLiveMeetingJournal({
    userDataPath: () => userData,
    enabled: () => true,
    bindingOf: (startedAt) => (startedAt === STARTED_AT ? binding : null),
    authGeneration: () => 1,
    keys,
    audit: vi.fn()
  })
  const append = vi.spyOn(journal, 'append')
  registerMeetingJournalIpc({ ipcMain, authorizeSender, requireAuth, journal })
  const event = (processId = 7, routingId = 3) => ({
    sender: { id: 1 },
    senderFrame: { parent: null, url: 'app://main', processId, routingId }
  })
  const invoke = (raw: unknown, ev: unknown = event()) => {
    if (!handler) throw new Error('handler not registered')
    return handler(ev, raw)
  }
  return { ipcMain, channels, authorizeSender, requireAuth, journal, append, invoke, event }
}

describe('transcript:journalAppend IPC', () => {
  it('registers exactly one channel and gates the sender as an audited main-window top frame', async () => {
    const h = harness()
    expect(h.channels).toEqual([IPC.appendMeetingJournal])
    expect(IPC.appendMeetingJournal).toBe('transcript:journalAppend')
    await h.invoke({ startedAt: STARTED_AT, line: cloudLine(1) })
    expect(h.authorizeSender).toHaveBeenCalledWith(expect.objectContaining({ senderFrame: expect.anything() }), {
      surface: 'transcript.journalAppend',
      requireOwner: false,
      allowedFrames: 'main-window-top'
    })
    await h.journal.dispose()
  })

  it('refuses a sender the authorizer rejects before it reads the payload or touches the journal', async () => {
    const h = harness()
    h.authorizeSender.mockImplementation(() => {
      throw new SenderRefusal('wrong-window', 'transcript.journalAppend')
    })
    await expect(h.invoke({ startedAt: STARTED_AT, line: cloudLine(1) })).rejects.toThrow('IPC refused: wrong-window')
    expect(h.append).not.toHaveBeenCalled()
    expect(readdirSync(userData)).toEqual([])
  })

  it('refuses when signed out', async () => {
    const h = harness({ signedIn: false })
    await expect(h.invoke({ startedAt: STARTED_AT, line: cloudLine(1) })).resolves.toEqual({ status: 'refused' })
    expect(h.append).not.toHaveBeenCalled()
  })

  it('journals a committed cloud final from the frame bound to the meeting and replies content-free', async () => {
    const h = harness()
    const reply = await h.invoke({ startedAt: STARTED_AT, line: cloudLine(1) })
    expect(reply).toEqual({ status: 'durable' })
    expect(h.append).toHaveBeenCalledTimes(1)
    expect(h.append).toHaveBeenCalledWith(expect.objectContaining({ startedAt: STARTED_AT, frameOwner: '7:3' }))
    await h.journal.dispose()
  })

  it('proves ownership from the sender frame, never the payload: another frame, an unopened meeting and a closed one are refused', async () => {
    const other = harness()
    await expect(other.invoke({ startedAt: STARTED_AT, line: cloudLine(1) }, other.event(7, 4))).resolves.toEqual({
      status: 'refused'
    })
    await expect(other.invoke({ startedAt: STARTED_AT, line: cloudLine(1) }, other.event(8, 3))).resolves.toEqual({
      status: 'refused'
    })
    await expect(other.invoke({ startedAt: STARTED_AT + 1, line: cloudLine(1) })).resolves.toEqual({
      status: 'refused'
    })
    const closed = harness({ binding: null })
    await expect(closed.invoke({ startedAt: STARTED_AT, line: cloudLine(1) })).resolves.toEqual({ status: 'refused' })
    // A payload that tries to name its own frame fails the strict schema before the journal is consulted.
    await expect(other.invoke({ startedAt: STARTED_AT, line: cloudLine(1), frameOwner: '7:3' })).resolves.toEqual({
      status: 'refused'
    })
    expect(readdirSync(userData)).toEqual([])
    await other.journal.dispose()
    await closed.journal.dispose()
  })

  it('refuses a payload with no frame at all', async () => {
    const h = harness()
    await expect(h.invoke({ startedAt: STARTED_AT, line: cloudLine(1) }, { sender: { id: 1 } })).resolves.toEqual({
      status: 'refused'
    })
    expect(h.append).not.toHaveBeenCalled()
  })

  describe('schema', () => {
    const bad: Array<[string, () => unknown]> = [
      [
        'a local line without speech',
        () => ({ startedAt: STARTED_AT, line: { speaker: 'you', text: 'hi', t: STARTED_AT } })
      ],
      ['a provisional line', () => ({ startedAt: STARTED_AT, line: cloudLine(1, { provisional: true }) })],
      [
        'a non-final segment',
        () => {
          const line = cloudLine(1)
          return {
            startedAt: STARTED_AT,
            line: { ...line, speech: { ...line.speech!, segment: { ...line.speech!.segment, final: false } } }
          }
        }
      ],
      ['extra line keys', () => ({ startedAt: STARTED_AT, line: { ...cloudLine(1), extra: 'smuggled' } })],
      ['extra payload keys', () => ({ startedAt: STARTED_AT, line: cloudLine(1), extra: 1 })],
      ['a zero meeting start', () => ({ startedAt: 0, line: cloudLine(1) })],
      ['a fractional meeting start', () => ({ startedAt: 1.5, line: cloudLine(1) })],
      ['a missing line', () => ({ startedAt: STARTED_AT })],
      [
        'a text that differs from the segment',
        () => ({ startedAt: STARTED_AT, line: { ...cloudLine(1), text: 'edited' } })
      ],
      ['an oversize speaker name', () => ({ startedAt: STARTED_AT, line: cloudLine(1, { name: 'n'.repeat(257) }) })],
      ['an oversize language label', () => ({ startedAt: STARTED_AT, line: cloudLine(1, { lang: 'l'.repeat(257) }) })],
      ['a non-object payload', () => 'x'],
      ['no payload', () => undefined]
    ]
    it.each(bad)('refuses %s without consulting the journal', async (_name, make) => {
      const h = harness()
      await expect(h.invoke(make())).resolves.toEqual({ status: 'refused' })
      expect(h.append).not.toHaveBeenCalled()
      expect(readdirSync(userData)).toEqual([])
    })
  })

  it('never throws a journal refusal into the renderer: the reply is only durable or refused', async () => {
    const h = harness()
    h.append.mockResolvedValueOnce({ status: 'refused', reason: 'QUEUE_FULL' })
    await expect(h.invoke({ startedAt: STARTED_AT, line: cloudLine(1) })).resolves.toEqual({ status: 'refused' })
  })
})
