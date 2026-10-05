import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { app } from 'electron'
import { resetSecretKeyCache } from '../../secrets'
import { openJournal, readJournal } from './store'

vi.mock('electron')

// Records every append and fsync the journal makes, by file name, and can fail the next append after it
// has written a partial frame, as a full disk or an I/O error would.
const io = vi.hoisted(() => ({ events: [] as string[], failNextAppend: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const open = async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args)
    const name = basename(String(args[0]))
    return new Proxy(handle, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target)
        if (prop === 'appendFile') {
          return async (data: Buffer) => {
            if (io.failNextAppend) {
              io.failNextAppend = false
              await target.appendFile(data.subarray(0, 3))
              throw Object.assign(new Error('simulated EIO'), { code: 'EIO' })
            }
            await target.appendFile(data)
            io.events.push(`write ${name}`)
          }
        }
        if (prop === 'sync') {
          return async () => {
            await target.sync()
            io.events.push(`fsync ${name}`)
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }
  return { ...actual, open, default: { ...actual, open } }
})

describe('journal durability ordering', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'metis-journal-io-'))
    vi.mocked(app.getPath).mockReturnValue(userData)
    resetSecretKeyCache()
    io.events = []
    io.failNextAppend = false
  })

  afterEach(() => {
    resetSecretKeyCache()
    rmSync(userData, { recursive: true, force: true })
  })

  it('acknowledges a record only after its segment is written and fsynced', async () => {
    const store = await openJournal({ sessionId: 's1' })
    io.events = []
    await store.append([{ kind: 'revision', doc: 'note', text: 'one' }]).then(() => io.events.push('ack 1'))
    await store.append([{ kind: 'revision', doc: 'note', text: 'two' }]).then(() => io.events.push('ack 2'))
    await store.close()

    // The new segment's directory entry is made durable before any record in it is acknowledged.
    const created = process.platform === 'win32' ? [] : ['fsync s1']
    expect(io.events).toEqual([...created, 'write seg-1.jnl', 'fsync seg-1.jnl', 'ack 1', 'write seg-1.jnl', 'fsync seg-1.jnl', 'ack 2'])
  })

  it('after a failed append, never writes behind the torn frame and never reuses its seq', async () => {
    const store = await openJournal({ sessionId: 's1' })
    await store.append([{ kind: 'revision', doc: 'note', text: 'durable' }])
    io.failNextAppend = true
    await expect(store.append([{ kind: 'revision', doc: 'note', text: 'lost' }])).rejects.toThrow('simulated EIO')
    const ack = await store.append([{ kind: 'revision', doc: 'note', text: 'after the failure' }])
    await store.close()

    expect(ack).toMatchObject({ fromSeq: 3, toSeq: 3 })
    expect(readdirSync(join(userData, 'journal', 's1')).sort()).toEqual(['seg-1.jnl', 'seg-2.jnl'])
    const replay = await readJournal({ sessionId: 's1' })
    expect(replay.records.map((r) => [r.seq, r.kind === 'revision' && r.text])).toEqual([
      [1, 'durable'],
      [3, 'after the failure']
    ])
    expect(replay.tornTailSegments).toEqual([1])
  })
})
