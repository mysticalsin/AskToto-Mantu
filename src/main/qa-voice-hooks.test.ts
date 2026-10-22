import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopActionRequest } from '@shared/desktop-actions'
import { MODIFIER_BITS } from '@shared/voice/modifier-mask'
import { actionEnvelope, isObservedVerified } from './action-guard'
import { createChordWatcher, type ChordWatcherEvent } from './voice/chord-watcher'
import {
  createQaChordFifoSource,
  createQaDesktopSink,
  qaChordFifoDecision,
  qaDesktopSinkEnabled,
  qaSinkOutcome,
  QA_CHORD_FIFO_COMMAND,
  QA_CHORD_FIFO_ENV,
  QA_DESKTOP_SINK_ENV,
  type QaChordFifoAudit,
  type QaFifoFs,
  type QaFifoHandle
} from './qa-voice-hooks'
import { QA_CHORD_MARKER, QA_DESKTOP_SINK_MARKER } from '../../scripts/lib/qa-fault-hook.mjs'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A throwaway QA profile (realpath'd: tmpdir is a symlink on macOS) and a sibling directory outside it. */
function profileFixture(): { root: string; profile: string; fifo: string; outside: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'asktoto-qa-voice-')))
  dirs.push(root)
  const profile = join(root, 'profile')
  const outside = join(root, 'outside')
  mkdirSync(join(profile, 'qa-voice'), { recursive: true })
  mkdirSync(outside)
  return { root, profile, fifo: join(profile, 'qa-voice', 'chord.fifo'), outside }
}

const envFor = (profile: string, fifo: string): Record<string, string> => ({
  ASKTOTO_USERDATA: profile,
  [QA_CHORD_FIFO_ENV]: fifo
})

describe('the two env names are the packaged-bytes markers the packaging gate looks for', () => {
  it('matches scripts/lib/qa-fault-hook.mjs in both directions', () => {
    expect(QA_CHORD_MARKER).toBe(QA_CHORD_FIFO_ENV)
    expect(QA_DESKTOP_SINK_MARKER).toBe(QA_DESKTOP_SINK_ENV)
  })
})

describe('qaChordFifoDecision', () => {
  it('accepts a FIFO path inside the profile', () => {
    const { profile, fifo } = profileFixture()
    expect(qaChordFifoDecision({ qaIdentity: true, packaged: true, env: envFor(profile, fifo) })).toEqual({
      path: fifo,
      profile,
      reason: null
    })
  })

  it.each([
    ['a shipping identity', 'shipping-identity', { qaIdentity: false }, (p: string, f: string) => envFor(p, f)],
    ['an unpackaged app', 'unpackaged', { packaged: false }, (p: string, f: string) => envFor(p, f)],
    ['no request', 'not-requested', {}, (p: string) => ({ ASKTOTO_USERDATA: p })],
    ['no ASKTOTO_USERDATA', 'no-profile', {}, (_p: string, f: string) => ({ [QA_CHORD_FIFO_ENV]: f })],
    [
      'a relative path',
      'relative-path',
      {},
      (p: string) => ({ ASKTOTO_USERDATA: p, [QA_CHORD_FIFO_ENV]: 'chord.fifo' })
    ],
    [
      "'..' traversal out of the profile",
      'outside-profile',
      {},
      (p: string) => ({ ASKTOTO_USERDATA: p, [QA_CHORD_FIFO_ENV]: `${p}${sep}..${sep}outside${sep}chord.fifo` })
    ],
    [
      'the profile directory itself',
      'outside-profile',
      {},
      (p: string) => ({ ASKTOTO_USERDATA: p, [QA_CHORD_FIFO_ENV]: p })
    ]
  ] as const)('refuses %s (%s)', (_label, reason, opts, envOf) => {
    const f = profileFixture()
    const decision = qaChordFifoDecision({ qaIdentity: true, packaged: true, ...opts, env: envOf(f.profile, f.fifo) })
    expect(decision).toEqual({ path: null, profile: null, reason })
  })
})

describe('qaDesktopSinkEnabled', () => {
  const base = {
    qaIdentity: true,
    packaged: true,
    env: { ASKTOTO_USERDATA: '/synthetic/profile', [QA_DESKTOP_SINK_ENV]: '1' }
  }
  it('is on only for a packaged QA identity on an isolated profile with the value 1', () => {
    expect(qaDesktopSinkEnabled(base)).toBe(true)
    expect(qaDesktopSinkEnabled({ ...base, qaIdentity: false })).toBe(false)
    expect(qaDesktopSinkEnabled({ ...base, packaged: false })).toBe(false)
    expect(qaDesktopSinkEnabled({ ...base, env: { [QA_DESKTOP_SINK_ENV]: '1' } })).toBe(false)
    expect(qaDesktopSinkEnabled({ ...base, env: { ASKTOTO_USERDATA: '/p', [QA_DESKTOP_SINK_ENV]: 'true' } })).toBe(
      false
    )
    expect(qaDesktopSinkEnabled({ ...base, env: { ASKTOTO_USERDATA: '/p' } })).toBe(false)
  })
})

/** A fake filesystem whose FIFO is a PassThrough the test writes into (`fifoIn`). */
function fakeFs(over: Partial<QaFifoFs> = {}) {
  const fifoIn = new PassThrough()
  const calls = { wake: 0, close: 0, open: 0 }
  const handle: QaFifoHandle = {
    stream: fifoIn,
    wake: async () => {
      calls.wake += 1
    },
    close: async () => {
      calls.close += 1
      fifoIn.destroy()
    }
  }
  const fs: QaFifoFs = {
    realpath: async (path) => path,
    isFifo: async () => true,
    open: async () => {
      calls.open += 1
      return handle
    },
    ...over
  }
  return { fs, fifoIn, calls }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

function startSource(
  env: Record<string, string>,
  fsOver: Partial<QaFifoFs> = {},
  opts: { qaIdentity?: boolean; packaged?: boolean } = {}
) {
  const audits: Array<[string, Record<string, unknown>]> = []
  const audit: QaChordFifoAudit = (event, detail) => audits.push([event, detail])
  const fake = fakeFs(fsOver)
  const qa = createQaChordFifoSource({
    qaIdentity: opts.qaIdentity ?? true,
    packaged: opts.packaged ?? true,
    env,
    audit,
    fs: fake.fs
  })
  const lines: string[] = []
  const exits: Array<{ error?: string }> = []
  const handlers = {
    onLine: (line: string) => void lines.push(line),
    onExit: (info: { error?: string }) => void exits.push(info)
  }
  return { qa, audits, lines, exits, handlers, ...fake }
}

describe('createQaChordFifoSource', () => {
  it('is null when nothing asked for it (shipping, unpackaged or no env): the real helper is used', () => {
    const f = profileFixture()
    expect(startSource(envFor(f.profile, f.fifo), {}, { qaIdentity: false }).qa).toBeNull()
    expect(startSource(envFor(f.profile, f.fifo), {}, { packaged: false }).qa).toBeNull()
    expect(startSource({ ASKTOTO_USERDATA: f.profile }).qa).toBeNull()
  })

  it('an invalid request fails closed: no spec at all, never the real keyboard helper, and one refusal audit', () => {
    const f = profileFixture()
    const t = startSource({ ASKTOTO_USERDATA: f.profile, [QA_CHORD_FIFO_ENV]: 'relative.fifo' })
    expect(t.qa?.helperSpec()).toBeNull()
    expect(t.audits).toEqual([['qa.chord_fifo', { state: 'refused', reason: 'relative-path' }]])
  })

  it('hands the watcher a spec that names the FIFO source, never a real command', () => {
    const f = profileFixture()
    const t = startSource(envFor(f.profile, f.fifo))
    expect(t.qa?.helperSpec()).toEqual({ command: QA_CHORD_FIFO_COMMAND, args: [] })
  })

  it('delivers FIFO lines through the shared line splitter, audits open, and wakes then closes on kill', async () => {
    const f = profileFixture()
    const t = startSource(envFor(f.profile, f.fifo))
    const handle = t.qa!.spawnHelper(t.qa!.helperSpec()!, t.handlers)
    await settle()
    expect(t.audits).toEqual([['qa.chord_fifo', { state: 'open' }]])
    t.fifoIn.write('m 32 0\nm 3')
    t.fifoIn.write('2 1\nm 0 1\n')
    await settle()
    expect(t.lines).toEqual(['m 32 0', 'm 32 1', 'm 0 1'])
    handle.kill()
    handle.kill() // idempotent
    await settle()
    expect(t.calls).toEqual({ open: 1, wake: 1, close: 1 })
    expect(t.audits.map(([, detail]) => detail.state)).toEqual(['open', 'closed'])
    t.fifoIn.write('m 32 9\n')
    await settle()
    expect(t.lines).toHaveLength(3)
    // Content-free: neither the path nor the profile reaches the audit trail.
    expect(JSON.stringify(t.audits)).not.toContain('asktoto-qa-voice')
  })

  it('a kill that lands before the FIFO finished opening closes it as soon as it opens', async () => {
    const f = profileFixture()
    const t = startSource(envFor(f.profile, f.fifo))
    t.qa!.spawnHelper(t.qa!.helperSpec()!, t.handlers).kill()
    await settle()
    expect(t.calls.open).toBe(1)
    expect(t.calls.close).toBe(1)
  })

  it.each([
    ['a missing FIFO', { realpath: async () => Promise.reject(new Error('ENOENT')) }, 'missing'],
    ['a regular file', { isFifo: async () => false }, 'not-a-fifo'],
    ['a FIFO that cannot be opened', { open: async () => Promise.reject(new Error('EACCES')) }, 'open-failed'],
    [
      'a symlink that resolves outside the profile',
      { realpath: async (path: string) => (path.endsWith('chord.fifo') ? '/synthetic/elsewhere/chord.fifo' : path) },
      'outside-profile'
    ]
  ] as const)('refuses %s with the exit the watcher backs off on', async (_label, fsOver, reason) => {
    const f = profileFixture()
    const t = startSource(envFor(f.profile, f.fifo), fsOver as Partial<QaFifoFs>)
    t.qa!.spawnHelper(t.qa!.helperSpec()!, t.handlers)
    await settle()
    expect(t.audits).toEqual([['qa.chord_fifo', { state: 'refused', reason }]])
    expect(t.exits).toHaveLength(1)
    expect(t.exits[0].error).toContain(reason)
    expect(t.calls.open).toBe(0)
  })

  it('drives the REAL hold-chord watcher: FIFO lines become armed and released, and the watcher owns the lifecycle', async () => {
    const f = profileFixture()
    const t = startSource(envFor(f.profile, f.fifo))
    let now = 0
    const timers: Array<{ at: number; cb: () => void; id: number }> = []
    let nextId = 1
    const events: ChordWatcherEvent[] = []
    const watcher = createChordWatcher({
      helperSpec: () => t.qa!.helperSpec(),
      spawnHelper: (spec, handlers) => t.qa!.spawnHelper(spec, handlers),
      enabled: () => true,
      signedIn: () => true,
      gate: () => null,
      chordMask: () => MODIFIER_BITS.rightCommand,
      assistiveTechnologyActive: () => false,
      now: () => now,
      timers: {
        set: (cb, ms) => {
          const id = nextId++
          timers.push({ at: now + ms, cb, id })
          return id
        },
        clear: (handle) => {
          const index = timers.findIndex((timer) => timer.id === handle)
          if (index >= 0) timers.splice(index, 1)
        }
      },
      onEvent: (event) => events.push(event),
      audit: () => undefined
    })
    watcher.refresh()
    expect(watcher.status()).toBe('running')
    await settle()
    t.fifoIn.write(`m ${MODIFIER_BITS.rightCommand} 0\n`)
    await settle()
    now = 300
    for (const timer of timers.splice(0).filter((candidate) => candidate.at <= now)) timer.cb()
    expect(events).toEqual([{ type: 'armed' }])
    now = 3_800
    t.fifoIn.write('m 0 0\n')
    await settle()
    expect(events).toEqual([{ type: 'armed' }, { type: 'released', reason: 'release' }])
    // Turning the feature off stops the source within the same refresh: the FIFO is closed.
    watcher.stop()
    await settle()
    expect(t.calls.close).toBe(1)
  })
})

describe.skipIf(process.platform === 'win32')('createQaChordFifoSource on a real FIFO (POSIX)', () => {
  it('reads what another open of the same FIFO writes, survives the writer closing, and releases on kill', async () => {
    const f = profileFixture()
    execFileSync('mkfifo', [f.fifo])
    const audits: string[] = []
    const qa = createQaChordFifoSource({
      qaIdentity: true,
      packaged: true,
      env: envFor(f.profile, f.fifo),
      audit: (_event, detail) => void audits.push(detail.state)
    })
    const lines: string[] = []
    const handle = qa!.spawnHelper(qa!.helperSpec()!, {
      onLine: (line) => void lines.push(line),
      onExit: () => undefined
    })
    const until = async (check: () => boolean): Promise<void> => {
      for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await until(() => audits.includes('open'))
    for (const text of ['m 32 0\n', 'm 0 0\n']) {
      // The harness opens, writes and closes each time: the reader must not see an end of file.
      const writer = await open(f.fifo, 'r+')
      await writer.write(text)
      await writer.close()
    }
    await until(() => lines.length === 2)
    expect(lines).toEqual(['m 32 0', 'm 0 0'])
    handle.kill()
    await until(() => audits.includes('closed'))
    expect(audits).toEqual(['open', 'closed'])
  })

  it('refuses a symlink in the profile that points at a FIFO outside it', async () => {
    const f = profileFixture()
    const outsideFifo = join(f.outside, 'real.fifo')
    execFileSync('mkfifo', [outsideFifo])
    symlinkSync(outsideFifo, f.fifo)
    const audits: Array<Record<string, unknown>> = []
    const qa = createQaChordFifoSource({
      qaIdentity: true,
      packaged: true,
      env: envFor(f.profile, f.fifo),
      audit: (_event, detail) => void audits.push(detail)
    })
    const exits: Array<{ error?: string }> = []
    qa!.spawnHelper(qa!.helperSpec()!, { onLine: () => undefined, onExit: (info) => void exits.push(info) })
    for (let i = 0; i < 100 && exits.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(audits).toEqual([{ state: 'refused', reason: 'outside-profile' }])
  })

  it('refuses a regular file named like the FIFO', async () => {
    const f = profileFixture()
    writeFileSync(f.fifo, 'not a fifo')
    const audits: Array<Record<string, unknown>> = []
    const qa = createQaChordFifoSource({
      qaIdentity: true,
      packaged: true,
      env: envFor(f.profile, f.fifo),
      audit: (_event, detail) => void audits.push(detail)
    })
    const exits: unknown[] = []
    qa!.spawnHelper(qa!.helperSpec()!, { onLine: () => undefined, onExit: (info) => void exits.push(info) })
    for (let i = 0; i < 100 && exits.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(audits).toEqual([{ state: 'refused', reason: 'not-a-fifo' }])
  })
})

describe('the recording desktop sink', () => {
  const openNotes: DesktopActionRequest = { id: 'desktop.open_notes', args: {} }
  const createNote: DesktopActionRequest = { id: 'desktop.create_note', args: { title: 'synthetic-title' } }

  it('scripts create_note as unknown (the uncertain path) and everything else as verified', () => {
    expect(qaSinkOutcome('desktop.create_note')).toBe('unknown')
    for (const id of [
      'desktop.open_notes',
      'desktop.open_arc',
      'desktop.google_search',
      'desktop.open_x',
      'desktop.photo_booth_capture'
    ] as const) {
      expect(qaSinkOutcome(id)).toBe('verified')
    }
  })

  it('a verified dispatch carries a receipt the real observed-receipt rule accepts', async () => {
    const audit = vi.fn()
    const sink = createQaDesktopSink(audit)
    const envelope = actionEnvelope('proposal-1', openNotes)
    const result = await sink(openNotes, envelope)
    expect(result).toMatchObject({ id: 'desktop.open_notes', ok: true, outcome: 'verified' })
    expect(isObservedVerified(openNotes, result, envelope)).toBe(true)
  })

  it('an unknown dispatch is never reported verified, with or without an envelope', async () => {
    const sink = createQaDesktopSink(vi.fn())
    const envelope = actionEnvelope('proposal-2', createNote)
    const result = await sink(createNote, envelope)
    expect(result).toMatchObject({ ok: true, outcome: 'unknown' })
    expect(isObservedVerified(createNote, result, envelope)).toBe(false)
    expect((await sink(openNotes)).outcome).toBe('unknown') // no envelope, no receipt, no claim
  })

  it('audits the action id, outcome and args hash only: never a title or any argument', async () => {
    const audit = vi.fn()
    const envelope = actionEnvelope('proposal-3', createNote)
    await createQaDesktopSink(audit)(createNote, envelope)
    expect(audit.mock.calls).toEqual([
      [
        'qa.desktop_action.dispatched',
        { actionId: 'desktop.create_note', outcome: 'unknown', argsHash: envelope.argsHash }
      ]
    ])
    expect(JSON.stringify(audit.mock.calls)).not.toContain('synthetic-title')
  })
})
