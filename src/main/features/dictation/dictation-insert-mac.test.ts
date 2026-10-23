import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DictationInsertRequest } from '../desktop-contract'
import type { ChordWatcherEvent } from '../../voice/chord-watcher'
import type { AxFocusSnapshot, AxHelperClient, AxInsertRequest, AxInsertResult } from '../../mac-ax-helper'
import { DictationSession } from './dictation-session'
import {
  createMacDictationPorts,
  helperRequestFor,
  targetFromSnapshot,
  terminalSafeText,
  type MacInsertAudit
} from './dictation-insert-mac'

// Synthetic fixtures only: no real application, window or text.
const TEXT = 'synthetic dictated sentence'
const NOW = 7_000_000
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const VALUE_HASH = sha('synthetic existing field text')

const snapshot = (patch: Partial<AxFocusSnapshot> = {}): AxFocusSnapshot => ({
  status: 'ok',
  pid: 4242,
  bundleId: 'com.example.synthetic-editor',
  processStartMs: 1_700_000_000_000,
  windowId: 'wsynthetic01',
  role: 'AXTextArea',
  subrole: null,
  token: 'tok0123456789abcdef',
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

const ports = (client: AxHelperClient, audit?: (detail: MacInsertAudit) => void) =>
  createMacDictationPorts({ client, platform: 'darwin', helperPresent: () => true, now: () => NOW, audit })

describe('targetFromSnapshot (G23)', () => {
  it('binds process, window, element, value and selection without the text of the field', () => {
    const observation = targetFromSnapshot(snapshot(), NOW)
    expect(observation.kind).toBe('target')
    if (observation.kind !== 'target') return
    expect(observation.target).toMatchObject({
      appId: 'com.example.synthetic-editor',
      processInstanceId: 'p4242.1700000000000',
      windowId: 'wsynthetic01',
      elementId: 'tok0123456789abcdef',
      documentRevision: `${VALUE_HASH}.29.29.0`,
      editable: true,
      secure: false,
      observedAtMs: NOW
    })
  })

  it('a different selection or value is a different target', () => {
    const a = targetFromSnapshot(snapshot(), NOW)
    const b = targetFromSnapshot(snapshot({ selection: { location: 3, length: 4 } }), NOW)
    const c = targetFromSnapshot(snapshot({ valueHash: sha('other') }), NOW)
    if (a.kind !== 'target' || b.kind !== 'target' || c.kind !== 'target') throw new Error('expected targets')
    expect(b.target.selectionRevision).not.toBe(a.target.selectionRevision)
    expect(b.target.documentRevision).not.toBe(a.target.documentRevision)
    expect(c.target.documentRevision).not.toBe(a.target.documentRevision)
  })

  it.each([
    ['no helper answer', null, 'unsupported'],
    ['Accessibility not granted', snapshot({ status: 'permission' }), 'permission'],
    ['nothing focused', snapshot({ status: 'no_focus' }), 'no_focus'],
    ['a secure field, even with a value present', snapshot({ secure: true }), 'secure_field'],
    ['no readable value', snapshot({ valueHash: null, valueLength: null }), 'unsupported'],
    ['a value too large to compare', snapshot({ valueTooLarge: true }), 'unsupported'],
    ['no selection', snapshot({ selection: null }), 'unsupported']
  ] as const)('%s binds nothing', (_name, input, reason) => {
    expect(targetFromSnapshot(input, NOW)).toEqual({ kind: 'unavailable', reason })
  })
})

function request(target = targetFromSnapshot(snapshot(), NOW), text = TEXT): DictationInsertRequest {
  if (target.kind !== 'target') throw new Error('expected a target')
  return {
    kind: 'dictation.insert',
    argsHash: 'a'.repeat(64),
    args: {
      operationId: 'dictation:1',
      text,
      textHash: sha(text),
      target: target.target,
      targetFingerprint: 'f'.repeat(64),
      transcriptRevision: 1
    }
  }
}

describe('helperRequestFor (G23)', () => {
  it('restates the bound target for the helper to compare again', () => {
    expect(helperRequestFor(request())).toEqual({
      pid: 4242,
      windowId: 'wsynthetic01',
      token: 'tok0123456789abcdef',
      valueHash: VALUE_HASH,
      valueLength: 29,
      selectionLocation: 29,
      selectionLength: 0,
      text: TEXT,
      allowPaste: true
    })
  })

  it('a target that is not one of this adapter is refused before the helper is asked', () => {
    const req = request()
    const forged = { ...req, args: { ...req.args, target: { ...req.args.target, documentRevision: 'doc:1' } } }
    expect(helperRequestFor(forged)).toBeNull()
    const secure = { ...req, args: { ...req.args, target: { ...req.args.target, secure: true } } }
    expect(helperRequestFor(secure)).toBeNull()
    const badPid = { ...req, args: { ...req.args, target: { ...req.args.target, processInstanceId: 'pid:41' } } }
    expect(helperRequestFor(badPid)).toBeNull()
  })
})

describe('createMacDictationPorts: insertion outcomes (G23)', () => {
  it('a verified readback becomes a receipt that echoes the guard request, and the audit has no text', async () => {
    const { client, requests } = fakeClient()
    const audits: MacInsertAudit[] = []
    const req = request()
    const result = await ports(client, (a) => audits.push(a)).insertion.insert(req)
    expect(result).toMatchObject({
      outcome: 'verified',
      receipt: { operationId: 'dictation:1', argsHash: req.argsHash }
    })
    expect(requests).toHaveLength(1)
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
    expect(JSON.stringify(audits)).not.toContain('synthetic dictated')
    expect(JSON.stringify(audits)).not.toContain(sha(TEXT))
  })

  it('a write that did not read back is uncertain, never verified', async () => {
    const { client } = fakeClient({ insert: inserted({ outcome: 'unverified' }) })
    const audits: MacInsertAudit[] = []
    expect(await ports(client, (a) => audits.push(a)).insertion.insert(request())).toEqual({
      outcome: 'uncertain',
      evidenceId: 'ax:unverified:ax'
    })
    expect(audits[0]?.outcome).toBe('inserted_unverified')
  })

  it.each([
    'secure_field',
    'target_changed',
    'permission'
  ] as const)('refused(%s) writes nothing and keeps the draft', async (reason) => {
    const { client } = fakeClient({
      insert: inserted({ outcome: 'refused', reason, textHash: null, textLength: 0, method: 'none' })
    })
    const audits: MacInsertAudit[] = []
    expect(await ports(client, (a) => audits.push(a)).insertion.insert(request())).toEqual({
      outcome: 'no_effect',
      evidenceId: `ax:refused:${reason}`
    })
    expect(audits[0]).toMatchObject({ outcome: 'refused', reason })
  })

  it('an element Accessibility cannot write to is unsupported', async () => {
    const { client } = fakeClient({
      insert: inserted({ outcome: 'unsupported', reason: 'unsupported', method: 'none', textHash: null })
    })
    expect(await ports(client).insertion.insert(request())).toEqual({ outcome: 'unsupported' })
  })

  it('a helper that failed after it may have written is uncertain and is never asked twice', async () => {
    for (const insert of [null, new Error('boom')]) {
      const { client } = fakeClient({ insert })
      expect(await ports(client).insertion.insert(request())).toEqual({
        outcome: 'uncertain',
        evidenceId: 'ax:helper-failed'
      })
      expect(client.insert).toHaveBeenCalledTimes(1)
    }
  })

  it('a helper that names different text than was dictated is not a verified insertion', async () => {
    const { client } = fakeClient({ insert: inserted({ textHash: sha('something else') }) })
    expect(await ports(client).insertion.insert(request())).toEqual({
      outcome: 'uncertain',
      evidenceId: 'ax:text-hash-mismatch'
    })
  })

  it('a terminal that made the text inert is verified only for exactly the inert text it was expected to write', async () => {
    const dictated = 'synthetic line one\nsynthetic line two\r\u001b[31m '
    const inert = 'synthetic line one synthetic line two [31m'
    expect(terminalSafeText(dictated)).toBe(inert)
    const { client } = fakeClient({
      insert: inserted({ method: 'paste', terminal: true, sanitized: true, textHash: sha(inert) })
    })
    const audits: MacInsertAudit[] = []
    const result = await ports(client, (a) => audits.push(a)).insertion.insert(request(undefined, dictated))
    expect(result).toMatchObject({ outcome: 'verified', evidenceId: 'ax:verified:paste:inert' })
    expect(audits[0]).toMatchObject({ method: 'paste', terminal: true, sanitized: true })
  })

  it('a sanitized claim never verifies an unrelated helper hash, or any non-terminal sanitizing (review P2)', async () => {
    const dictated = 'synthetic line one\nsynthetic line two'
    for (const patch of [
      { terminal: true, sanitized: true, textHash: sha('something unrelated') },
      { terminal: true, sanitized: true, textHash: sha(dictated) },
      { terminal: false, sanitized: true, textHash: sha(terminalSafeText(dictated)) },
      { terminal: true, sanitized: true, textHash: null }
    ]) {
      const { client } = fakeClient({ insert: inserted({ method: 'paste', ...patch }) })
      expect(await ports(client).insertion.insert(request(undefined, dictated))).toEqual({
        outcome: 'uncertain',
        evidenceId: 'ax:text-hash-mismatch'
      })
    }
  })

  it('a failing audit sink never changes the outcome', async () => {
    const { client } = fakeClient()
    const result = await ports(client, () => {
      throw new Error('sink')
    }).insertion.insert(request())
    expect(result.outcome).toBe('verified')
  })

  it('is unsupported off macOS or without the helper: the helper is never asked', async () => {
    const { client } = fakeClient()
    for (const p of [
      createMacDictationPorts({ client, platform: 'linux', helperPresent: () => true }),
      createMacDictationPorts({ client, platform: 'win32', helperPresent: () => true }),
      createMacDictationPorts({ client, platform: 'darwin', helperPresent: () => false })
    ]) {
      expect(await p.target.captureTarget()).toEqual({ kind: 'unavailable', reason: 'unsupported' })
      expect(await p.insertion.insert(request())).toEqual({ outcome: 'unsupported' })
    }
    expect(client.snapshot).not.toHaveBeenCalled()
    expect(client.insert).not.toHaveBeenCalled()
  })
})

// The real consumer: a G22 dictation session driven over this adapter and the real guard.
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

describe('DictationSession over the macOS ports (G23)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a verified AX insertion finishes the dictation', async () => {
    const { client, requests } = fakeClient()
    const { session, begins } = sessionOver(client)
    await dictate(session, begins)
    expect(session.snapshot()).toMatchObject({ state: 'done', reason: null })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.text).toBe(TEXT)
  })

  it('a field whose text changed between the two looks never reaches the helper', async () => {
    const changed = snapshot({ valueHash: sha('changed while talking') })
    const { client } = fakeClient({ snapshots: [snapshot(), snapshot(), changed] })
    const { session, begins } = sessionOver(client)
    // capture at start, then the two looks at the end: the second differs.
    session.onChordEvent(armed)
    await flush()
    session.report({ turnId: begins[0]!, phase: 'capturing' })
    session.onChordEvent(released)
    session.onTranscript(TEXT)
    await flush()
    expect(client.insert).not.toHaveBeenCalled()
    expect(session.snapshot().state).toBe('failed')
  })

  it('a secure field at the start refuses the dictation before the microphone opens', async () => {
    const { client } = fakeClient({ snapshots: [snapshot({ secure: true })] })
    const { session, begins } = sessionOver(client)
    session.onChordEvent(armed)
    await flush()
    expect(begins).toEqual([])
    expect(session.snapshot().state).toBe('failed')
  })

  it('a helper refusal because the field changed keeps the draft and ends failed', async () => {
    const { client } = fakeClient({
      insert: inserted({ outcome: 'refused', reason: 'target_changed', textHash: null, method: 'none' })
    })
    const { session, begins } = sessionOver(client)
    await dictate(session, begins)
    expect(session.snapshot()).toMatchObject({ state: 'failed' })
  })
})
