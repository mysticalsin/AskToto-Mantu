import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DictationInsertRequest } from '../desktop-contract'
import type { ChordWatcherEvent } from '../../voice/chord-watcher'
import type { AxFocusSnapshot, AxHelperClient, AxInsertRequest, AxInsertResult } from '../../mac-ax-helper'
import { DictationSession } from './dictation-session'
import { targetFromSnapshot } from './dictation-insert-mac'
import { createWinDictationPorts, type WinInsertAudit } from './dictation-insert-win'

// Synthetic fixtures only: no real application, window or text. Platform is pinned: hosted CI runs ubuntu too.
const TEXT = 'synthetic dictated sentence'
const NOW = 9_000_000
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const VALUE_HASH = sha('synthetic existing field text')

const snapshot = (patch: Partial<AxFocusSnapshot> = {}): AxFocusSnapshot => ({
  status: 'ok',
  pid: 5150,
  bundleId: 'win:synthetic-editor',
  processStartMs: 1_700_000_000_000,
  windowId: 'w263950',
  role: 'Edit',
  subrole: null,
  token: '42.263950.4.1',
  secure: false,
  editable: true,
  terminal: false,
  valueHash: VALUE_HASH,
  valueLength: 29,
  valueTooLarge: false,
  selection: { location: 29, length: 0 },
  ...patch
})

const inserted = (patch: Partial<AxInsertResult> = {}): AxInsertResult => ({
  outcome: 'verified',
  reason: null,
  method: 'ax',
  terminal: false,
  sanitized: false,
  textHash: sha(TEXT),
  textLength: TEXT.length,
  clipboard: 'not_used',
  ...patch
})

function fakeClient(over: { snapshots?: Array<AxFocusSnapshot | null>; insert?: AxInsertResult | null | Error } = {}) {
  const queue = [...(over.snapshots ?? [])]
  const requests: AxInsertRequest[] = []
  const client: AxHelperClient = {
    snapshot: vi.fn(async () => (queue.length > 0 ? (queue.shift() ?? null) : snapshot())),
    insert: vi.fn(async (request) => {
      requests.push(request)
      if (over.insert instanceof Error) throw over.insert
      return over.insert === undefined ? inserted() : over.insert
    })
  }
  return { client, requests }
}

const ports = (client: AxHelperClient, audit?: (detail: WinInsertAudit) => void) =>
  createWinDictationPorts({ client, platform: 'win32', helperPresent: () => true, now: () => NOW, audit })

function request(text = TEXT, patch = {}): DictationInsertRequest {
  const observed = targetFromSnapshot(snapshot(patch), NOW)
  if (observed.kind !== 'target') throw new Error('expected a target')
  return {
    kind: 'dictation.insert',
    argsHash: 'a'.repeat(64),
    args: {
      operationId: 'dictation:1',
      text,
      textHash: sha(text),
      target: observed.target,
      targetFingerprint: 'f'.repeat(64),
      transcriptRevision: 1
    }
  }
}

describe('createWinDictationPorts: target binding (G24)', () => {
  it('binds pid, window handle, UI Automation runtime id, value hash and selection, never the text', async () => {
    const { client } = fakeClient()
    const observation = await ports(client).target.captureTarget()
    expect(observation.kind).toBe('target')
    if (observation.kind !== 'target') return
    expect(observation.target).toMatchObject({
      appId: 'win:synthetic-editor',
      processInstanceId: 'p5150.1700000000000',
      windowId: 'w263950',
      elementId: '42.263950.4.1',
      documentRevision: `${VALUE_HASH}.29.29.0`,
      editable: true,
      secure: false,
      observedAtMs: NOW
    })
  })

  it.each([
    ['an elevated window (UIPI)', snapshot({ status: 'permission' }), 'permission'],
    ['nothing focused', snapshot({ status: 'no_focus' }), 'no_focus'],
    ['a password field', snapshot({ secure: true }), 'secure_field'],
    ['a field with no selection exposed', snapshot({ selection: null }), 'unsupported'],
    ['a field with no readable value', snapshot({ valueHash: null, valueLength: null }), 'unsupported'],
    ['no answer from the script', null, 'unsupported']
  ] as const)('%s binds nothing', async (_name, input, reason) => {
    const { client } = fakeClient({ snapshots: [input] })
    expect(await ports(client).target.captureTarget()).toEqual({ kind: 'unavailable', reason })
  })
})

describe('createWinDictationPorts: insertion outcomes (G24)', () => {
  it('re-states the bound target to the script, which compares it again', async () => {
    const { client, requests } = fakeClient()
    await ports(client).insertion.insert(request())
    expect(requests).toEqual([
      {
        pid: 5150,
        windowId: 'w263950',
        token: '42.263950.4.1',
        valueHash: VALUE_HASH,
        valueLength: 29,
        selectionLocation: 29,
        selectionLength: 0,
        text: TEXT,
        allowPaste: true
      }
    ])
  })

  it('a verified readback becomes a receipt and the audit carries no text, hash, app or field', async () => {
    const { client } = fakeClient()
    const audits: WinInsertAudit[] = []
    const req = request()
    const result = await ports(client, (a) => audits.push(a)).insertion.insert(req)
    expect(result).toMatchObject({
      outcome: 'verified',
      receipt: { operationId: 'dictation:1', argsHash: req.argsHash }
    })
    expect(audits).toEqual([
      {
        outcome: 'inserted_verified',
        method: 'ax',
        terminal: false,
        sanitized: false,
        textLength: TEXT.length,
        clipboard: 'not_used'
      }
    ])
    const flat = JSON.stringify(audits)
    for (const secret of ['synthetic', sha(TEXT), VALUE_HASH, '263950']) expect(flat).not.toContain(secret)
  })

  it('a terminal (no readback) is inserted_unverified, hence uncertain', async () => {
    const { client } = fakeClient({ insert: inserted({ outcome: 'unverified', terminal: true, sanitized: true }) })
    const audits: WinInsertAudit[] = []
    expect(await ports(client, (a) => audits.push(a)).insertion.insert(request())).toEqual({
      outcome: 'uncertain',
      evidenceId: 'ax:unverified:ax'
    })
    expect(audits[0]).toMatchObject({ outcome: 'inserted_unverified', terminal: true, sanitized: true })
  })

  it.each([
    'secure_field',
    'target_changed',
    'permission'
  ] as const)('refused(%s) writes nothing and keeps the draft', async (reason) => {
    const { client } = fakeClient({
      insert: inserted({ outcome: 'refused', reason, textHash: null, textLength: 0, method: 'none' })
    })
    expect(await ports(client).insertion.insert(request())).toEqual({
      outcome: 'no_effect',
      evidenceId: `ax:refused:${reason}`
    })
  })

  it('an element UI Automation cannot write to is unsupported', async () => {
    const { client } = fakeClient({
      insert: inserted({ outcome: 'unsupported', reason: 'unsupported', method: 'none', textHash: null })
    })
    expect(await ports(client).insertion.insert(request())).toEqual({ outcome: 'unsupported' })
  })

  it('a script that died after it may have typed is uncertain and is never asked twice', async () => {
    for (const insert of [null, new Error('boom')]) {
      const { client } = fakeClient({ insert })
      expect(await ports(client).insertion.insert(request())).toEqual({
        outcome: 'uncertain',
        evidenceId: 'ax:helper-failed'
      })
      expect(client.insert).toHaveBeenCalledTimes(1)
    }
  })

  it('a different hash than was dictated is not a verified insertion', async () => {
    const { client } = fakeClient({ insert: inserted({ textHash: sha('something else') }) })
    expect(await ports(client).insertion.insert(request())).toEqual({
      outcome: 'uncertain',
      evidenceId: 'ax:text-hash-mismatch'
    })
  })

  it('a password-field or forged target never reaches the script', async () => {
    const { client } = fakeClient()
    const req = request()
    const secure = { ...req, args: { ...req.args, target: { ...req.args.target, secure: true } } }
    const forged = { ...req, args: { ...req.args, target: { ...req.args.target, documentRevision: 'doc:1' } } }
    for (const bad of [secure, forged]) {
      expect(await ports(client).insertion.insert(bad)).toEqual({
        outcome: 'no_effect',
        evidenceId: 'ax:refused:target_changed'
      })
    }
    expect(client.insert).not.toHaveBeenCalled()
  })

  it('is unsupported off Windows or without the script: the script is never asked', async () => {
    const { client } = fakeClient()
    for (const p of [
      createWinDictationPorts({ client, platform: 'linux', helperPresent: () => true }),
      createWinDictationPorts({ client, platform: 'darwin', helperPresent: () => true }),
      createWinDictationPorts({ client, platform: 'win32', helperPresent: () => false })
    ]) {
      expect(await p.target.captureTarget()).toEqual({ kind: 'unavailable', reason: 'unsupported' })
      expect(await p.insertion.insert(request())).toEqual({ outcome: 'unsupported' })
    }
    expect(client.snapshot).not.toHaveBeenCalled()
    expect(client.insert).not.toHaveBeenCalled()
  })
})

// The real consumer: a G22 dictation session over these ports and the real guard.
const armed: ChordWatcherEvent = { type: 'armed' }
const released: ChordWatcherEvent = { type: 'released', reason: 'release' }
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function sessionOver(client: AxHelperClient) {
  const begins: string[] = []
  const session = new DictationSession({
    settings: () => ({ enabled: true }),
    gate: {
      signedIn: () => true,
      meetingReserved: () => false,
      onboardingActive: () => false,
      windowVisible: () => true,
      captureBusy: () => false,
      availability: () => ({ ok: true })
    },
    activation: { mint: () => true, revoke: () => undefined },
    stopLease: () => undefined,
    speech: { prewarm: async () => undefined },
    ports: ports(client),
    push: { begin: (p) => begins.push(p.turnId), end: () => undefined },
    newTurnId: () => 'turn-1',
    now: () => NOW,
    audit: () => undefined
  })
  session.refresh()
  return { session, begins }
}

async function dictate(session: DictationSession, begins: string[]): Promise<void> {
  session.onChordEvent(armed)
  await flush()
  session.report({ turnId: begins[0]!, phase: 'capturing' })
  session.onChordEvent(released)
  session.onTranscript(TEXT)
  await flush()
}

describe('DictationSession over the Windows ports (G24)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a verified insertion finishes the dictation', async () => {
    const { client, requests } = fakeClient()
    const { session, begins } = sessionOver(client)
    await dictate(session, begins)
    expect(session.snapshot()).toMatchObject({ state: 'done', reason: null })
    expect(requests).toHaveLength(1)
  })

  it('a password field at the start refuses the dictation before the microphone opens', async () => {
    const { client } = fakeClient({ snapshots: [snapshot({ secure: true })] })
    const { session, begins } = sessionOver(client)
    session.onChordEvent(armed)
    await flush()
    expect(begins).toEqual([])
    expect(session.snapshot().state).toBe('failed')
  })

  it('a field whose text changed between the looks never reaches the script', async () => {
    const { client } = fakeClient({
      snapshots: [snapshot(), snapshot(), snapshot({ valueHash: sha('changed while talking') })]
    })
    const { session, begins } = sessionOver(client)
    await dictate(session, begins)
    expect(client.insert).not.toHaveBeenCalled()
    expect(session.snapshot().state).toBe('failed')
  })

  it('a refusal by the script (focus moved, elevated target) keeps the draft and ends failed', async () => {
    for (const reason of ['target_changed', 'permission'] as const) {
      const { client } = fakeClient({
        insert: inserted({ outcome: 'refused', reason, textHash: null, method: 'none' })
      })
      const { session, begins } = sessionOver(client)
      await dictate(session, begins)
      expect(session.snapshot().state).toBe('failed')
    }
  })
})
