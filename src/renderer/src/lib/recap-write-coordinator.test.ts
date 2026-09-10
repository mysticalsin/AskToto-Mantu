import { describe, expect, it, vi } from 'vitest'
import {
  OwnedOperationGate,
  RecapWriteCoordinator,
  beginOwnedMeetingExit,
  nextMeetingStart,
  persistRecapOnExit,
  retireRecapWriteKeys
} from './recap-write-coordinator'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('recap write coordination', () => {
  it('provides a renderer-owned coordinator for generated recap writes', async () => {
    const module = await import('./recap-write-coordinator').catch(() => null)
    expect(module?.RecapWriteCoordinator).toBeTypeOf('function')
  })

  it('lands the newest same-file write last and suppresses the older UI result', async () => {
    const writes: string[] = []
    const first = deferred<void>()
    const coordinator = new RecapWriteCoordinator()
    const old = coordinator.write('meeting.md', 'old-run', async () => {
      await first.promise
      writes.push('old')
      return { ok: true }
    })
    await Promise.resolve()
    const latest = coordinator.write('meeting.md', 'new-run', async () => {
      writes.push('new')
      return { ok: true }
    })

    expect(writes).toEqual([])
    first.resolve()
    await expect(old).resolves.toEqual({ status: 'superseded' })
    await expect(latest).resolves.toEqual({ status: 'current', value: { ok: true } })
    expect(writes).toEqual(['old', 'new'])
  })

  it('orders a manual edit after an in-flight generation and leaves its status argument omitted', async () => {
    const generation = deferred<void>()
    const calls: Array<[string, string, string?]> = []
    const update = async (file: string, text: string, status?: string) => {
      calls.push([file, text, status])
      return { ok: true }
    }
    const coordinator = new RecapWriteCoordinator()
    const generated = coordinator.write('meeting.md', 'generated', async () => {
      await generation.promise
      return update('meeting.md', 'generated text', 'complete')
    })
    await Promise.resolve()
    const manual = coordinator.write('meeting.md', 'manual-1', () => update('meeting.md', 'manual text'))
    generation.resolve()

    await expect(generated).resolves.toEqual({ status: 'superseded' })
    await expect(manual).resolves.toMatchObject({ status: 'current', value: { ok: true } })
    expect(calls).toEqual([
      ['meeting.md', 'generated text', 'complete'],
      ['meeting.md', 'manual text', undefined]
    ])
  })

  it.each([
    ['/Users/tony/Meetings/meeting.md', 'meeting.md'],
    ['C:\\Users\\Tony\\Meetings\\meeting.md', 'meeting.md']
  ])('treats absolute %s and reopened basename %s as the same ordered file', async (absolute, basename) => {
    const generation = deferred<void>()
    const calls: string[] = []
    const coordinator = new RecapWriteCoordinator()
    const generated = coordinator.write(absolute, 'generated', async () => {
      await generation.promise
      calls.push('generated')
      return 'generated'
    })
    await Promise.resolve()
    const manual = coordinator.write(basename, 'manual', async () => {
      calls.push('manual')
      return 'manual'
    })

    expect(calls).toEqual([])
    generation.resolve()
    await expect(generated).resolves.toEqual({ status: 'superseded' })
    await expect(manual).resolves.toEqual({ status: 'current', value: 'manual' })
    expect(calls).toEqual(['generated', 'manual'])
  })

  it('continues to the newest same-file write after an older write rejects', async () => {
    const first = deferred<void>()
    const writeLatest = vi.fn(async () => ({ ok: true }))
    const coordinator = new RecapWriteCoordinator()
    const old = coordinator.write('meeting.md', 'old-run', async () => {
      await first.promise
      throw new Error('old disk failure')
    })
    await Promise.resolve()
    const latest = coordinator.write('meeting.md', 'new-run', writeLatest)
    first.resolve()

    await expect(old).resolves.toEqual({ status: 'superseded' })
    await expect(latest).resolves.toEqual({ status: 'current', value: { ok: true } })
    expect(writeLatest).toHaveBeenCalledTimes(1)
  })

  it('keeps the newest same-run invocation current when an exit rescue repeats the write', async () => {
    const first = deferred<void>()
    const coordinator = new RecapWriteCoordinator()
    const old = coordinator.write('meeting.md', 'same-run', async () => {
      await first.promise
      return 'first'
    })
    await Promise.resolve()
    const latest = coordinator.write('meeting.md', 'same-run', async () => 'second')

    first.resolve()
    await expect(old).resolves.toEqual({ status: 'superseded' })
    await expect(latest).resolves.toEqual({ status: 'current', value: 'second' })
  })

  it('reports the current write failure without throwing or wedging that file', async () => {
    const coordinator = new RecapWriteCoordinator()
    const error = new Error('current disk failure')
    await expect(coordinator.write('meeting.md', 'run-1', async () => { throw error })).resolves.toEqual({
      status: 'current',
      error
    })
    await expect(coordinator.write('meeting.md', 'run-2', async () => 'saved')).resolves.toEqual({
      status: 'current',
      value: 'saved'
    })
  })

  it('does not serialize writes to different meeting files', async () => {
    const one = deferred<void>()
    const two = deferred<void>()
    const started: string[] = []
    const coordinator = new RecapWriteCoordinator()
    const a = coordinator.write('a.md', 'run-a', async () => {
      started.push('a')
      await one.promise
      return 'a'
    })
    const b = coordinator.write('b.md', 'run-b', async () => {
      started.push('b')
      await two.promise
      return 'b'
    })
    await Promise.resolve()
    expect(started.sort()).toEqual(['a', 'b'])
    one.resolve()
    two.resolve()
    await expect(Promise.all([a, b])).resolves.toEqual([
      { status: 'current', value: 'a' },
      { status: 'current', value: 'b' }
    ])
  })
})

describe('meeting save ownership', () => {
  it('invalidates ownership even when reset and restart share the same millisecond', () => {
    expect(nextMeetingStart(100, 100)).toBe(101)
    expect(nextMeetingStart(100, 99)).toBe(101)
    expect(nextMeetingStart(100, 102)).toBe(102)
  })

  it('retires completed runs only for the meeting that can no longer be rescued', () => {
    const keys = new Set(['meeting-a\u0000run-1', 'meeting-a\u0000run-2', 'meeting-b\u0000run-1'])
    retireRecapWriteKeys(keys, 'meeting-a')
    expect([...keys]).toEqual(['meeting-b\u0000run-1'])
  })

  it('does not let meeting A publish into or release meeting B after A settles late', () => {
    const gate = new OwnedOperationGate()
    const a = gate.start('meeting-a')
    const b = gate.start('meeting-b')
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()

    expect(gate.mayPublish('meeting-a', a!, 'meeting-b')).toBe(false)
    expect(gate.mayPublish('meeting-b', b!, 'meeting-b')).toBe(true)
    gate.finish('meeting-a', a!)
    expect(gate.isActive('meeting-b')).toBe(true)
    expect(gate.start('meeting-b')).toBeNull()
  })

  it('runs real deferred callbacks but publishes only the current meeting result', async () => {
    const gate = new OwnedOperationGate()
    const first = deferred<string>()
    const second = deferred<string>()
    let currentOwner = 'meeting-a'
    const a = gate.run('meeting-a', () => currentOwner, () => first.promise)
    currentOwner = 'meeting-b'
    const b = gate.run('meeting-b', () => currentOwner, () => second.promise)

    second.resolve('b.md')
    await expect(b).resolves.toEqual({ status: 'current', value: 'b.md' })
    first.resolve('a.md')
    await expect(a).resolves.toEqual({ status: 'stale', value: 'a.md' })
    expect(gate.isActive('meeting-a')).toBe(false)
    expect(gate.isActive('meeting-b')).toBe(false)
  })
})

describe('exit recap persistence', () => {
  it('captures the cancel snapshot before New Meeting starts persistence and never substitutes blank notes', () => {
    const calls: string[] = []
    const snapshot = { id: 'run-a', text: 'Buffered current text' }
    const received = beginOwnedMeetingExit(
      () => {
        calls.push('cancel')
        return snapshot
      },
      (value) => {
        calls.push(`persist:${value.text}`)
      }
    )
    expect(received).toBe(snapshot)
    expect(calls).toEqual(['cancel', 'persist:Buffered current text'])
  })

  it('waits for the exact initial file then writes the cancelled partial and incomplete status', async () => {
    const path = deferred<string | null>()
    const create = vi.fn(async () => 'created.md')
    const update = vi.fn(async () => ({ ok: true as const }))
    const markPersisted = vi.fn()
    const result = persistRecapOnExit({
      action: { runId: 'run-a', text: 'Useful partial', recapStatus: 'incomplete' },
      path: path.promise,
      isPersisted: () => false,
      markPersisted,
      create,
      update,
      coordinator: new RecapWriteCoordinator()
    })

    expect(create).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    path.resolve('meeting-a.md')
    await expect(result).resolves.toMatchObject({ kind: 'updated', path: 'meeting-a.md' })
    expect(update).toHaveBeenCalledWith('meeting-a.md', 'Useful partial', 'incomplete')
    expect(markPersisted).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
  })

  it('still creates the transcript without attributed recap when no owned recap exists', async () => {
    const create = vi.fn(async () => 'meeting.md')
    await expect(
      persistRecapOnExit({
        action: null,
        path: Promise.resolve(null),
        isPersisted: () => false,
        markPersisted: vi.fn(),
        create,
        update: vi.fn(),
        coordinator: new RecapWriteCoordinator()
      })
    ).resolves.toEqual({ kind: 'created', value: 'meeting.md' })
    expect(create).toHaveBeenCalledWith('', undefined)
  })
})
