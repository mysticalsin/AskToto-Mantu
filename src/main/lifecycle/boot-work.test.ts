import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ mainLog: { info: vi.fn(), warn: vi.fn() }, auditLog: vi.fn() }))
vi.mock('../mac-helper', () => ({ macStatFlagsSpawnSpec: vi.fn(() => null) }))

import { auditLog, mainLog } from '../logger'
import { createBootWork, type BootWorkWindow } from './boot-work'

function fakeWindow(opts: { visible?: boolean; destroyed?: boolean } = {}): EventEmitter & BootWorkWindow & { show(): void } {
  const win = new EventEmitter() as EventEmitter & BootWorkWindow & { show(): void }
  let visible = opts.visible ?? false
  win.isDestroyed = () => opts.destroyed ?? false
  win.isVisible = () => visible
  win.show = () => {
    visible = true
    win.emit('show')
  }
  return win
}

const nextTask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const settle = async (tasks = 20): Promise<void> => {
  for (let i = 0; i < tasks; i++) await nextTask()
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('createBootWork (M2-0031)', () => {
  it('starts no job before the boot window first shows, and none in the show task itself', async () => {
    const work = createBootWork({ limit: 2, fallbackMs: 60_000 })
    const win = fakeWindow()
    const job = vi.fn()
    work.run('ensureMeetingsFolder', job)
    work.releaseAfterFirstShow(win)
    await settle()
    expect(job).not.toHaveBeenCalled()

    win.show()
    expect(job).not.toHaveBeenCalled()
    await nextTask()
    expect(job).toHaveBeenCalledTimes(1)
  })

  it('never has more than `limit` jobs in flight, and starts the next as soon as one settles', async () => {
    const work = createBootWork({ limit: 2, holdMs: 60_000 })
    const gates = [deferred(), deferred(), deferred(), deferred()]
    const started: number[] = []
    let inFlight = 0
    let maxInFlight = 0
    gates.forEach((gate, i) =>
      work.run(`job${i}`, async () => {
        started.push(i)
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await gate.promise
        inFlight--
      })
    )
    work.releaseAfterFirstShow(fakeWindow({ visible: true }))
    await settle()
    expect(started).toEqual([0, 1])

    gates[1].resolve()
    await settle()
    expect(started).toEqual([0, 1, 2])

    gates[0].resolve()
    gates[2].resolve()
    gates[3].resolve()
    await settle()
    expect(started).toEqual([0, 1, 2, 3])
    expect(maxInFlight).toBe(2)
  })

  it('caps at the storage gateway pool capacity (poolSize - 2) by default', async () => {
    const saved = process.env.UV_THREADPOOL_SIZE
    process.env.UV_THREADPOOL_SIZE = '6'
    try {
      const work = createBootWork({ holdMs: 60_000 })
      const started: number[] = []
      const never = new Promise<void>(() => {})
      for (let i = 0; i < 8; i++) work.run(`job${i}`, () => (started.push(i), never))
      work.releaseAfterFirstShow(null)
      await settle()
      expect(started).toEqual([0, 1, 2, 3])
    } finally {
      if (saved === undefined) delete process.env.UV_THREADPOOL_SIZE
      else process.env.UV_THREADPOOL_SIZE = saved
    }
  })

  it('starts each job in a task of its own', async () => {
    const work = createBootWork({ limit: 4 })
    const order: string[] = []
    work.run('a', () => order.push('a'))
    work.run('b', () => order.push('b'))
    work.releaseAfterFirstShow(fakeWindow({ visible: true }))
    await nextTask()
    expect(order).toEqual(['a'])
    await nextTask()
    expect(order).toEqual(['a', 'b'])
  })

  it('a job that holds its slot past holdMs no longer blocks the queue', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const work = createBootWork({ limit: 1, holdMs: 1_000 })
      const second = vi.fn()
      work.run('catchUpIntelligenceIndexIfNeeded', () => new Promise<void>(() => {}))
      work.run('runConsolidationIfDue', second)
      work.releaseAfterFirstShow(null)
      await settle()
      expect(second).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1_000)
      await settle()
      expect(second).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens after the fallback when the window never reports a show', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const work = createBootWork({ fallbackMs: 5_000 })
      const job = vi.fn()
      work.run('recoverImports', job)
      work.releaseAfterFirstShow(fakeWindow())
      await settle()
      expect(job).not.toHaveBeenCalled()
      vi.advanceTimersByTime(5_000)
      await settle()
      expect(job).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('audits the gate opening on the first show with the jobs it held, outside the show task (M2-0518)', async () => {
    vi.mocked(auditLog).mockClear()
    const work = createBootWork({ limit: 1, fallbackMs: 60_000 })
    const win = fakeWindow()
    work.run('runBootSidecarReaper', () => new Promise<void>(() => {}))
    work.run('startAvailableMemorySampler', vi.fn())
    work.releaseAfterFirstShow(win)
    await settle()
    expect(auditLog).not.toHaveBeenCalled()

    win.show()
    expect(auditLog).not.toHaveBeenCalled()
    await nextTask()
    expect(auditLog).toHaveBeenCalledTimes(1)
    expect(auditLog).toHaveBeenCalledWith('app.boot.work.released', { reason: 'show', held: 2 })
  })

  it('audits a fallback opening, so work held for a window that never showed is on record (M2-0518)', async () => {
    vi.mocked(auditLog).mockClear()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const work = createBootWork({ fallbackMs: 5_000 })
      const job = vi.fn()
      work.run('recoverOrphanDrafts', job)
      work.releaseAfterFirstShow(fakeWindow())
      vi.advanceTimersByTime(5_000)
      await settle()
      expect(job).toHaveBeenCalledTimes(1)
      expect(auditLog).toHaveBeenCalledWith('app.boot.work.released', { reason: 'fallback', held: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('audits an immediate opening once, and never again for a later show (M2-0518)', async () => {
    vi.mocked(auditLog).mockClear()
    const work = createBootWork()
    work.releaseAfterFirstShow(null)
    work.releaseAfterFirstShow(fakeWindow({ visible: true }))
    await settle()
    expect(auditLog).toHaveBeenCalledTimes(1)
    expect(auditLog).toHaveBeenCalledWith('app.boot.work.released', { reason: 'immediate', held: 0 })
  })

  it('opens at once for a destroyed window, and logs a failing job without stopping the queue', async () => {
    const work = createBootWork({ limit: 1 })
    const after = vi.fn()
    work.run('throws', () => {
      throw new Error('sync boom')
    })
    work.run('rejects', () => Promise.reject(new Error('async boom')))
    work.run('after', after)
    work.releaseAfterFirstShow(fakeWindow({ destroyed: true }))
    await settle()
    expect(after).toHaveBeenCalledTimes(1)
    expect(vi.mocked(mainLog.warn)).toHaveBeenCalledWith('[boot] throws failed:', expect.any(Error))
    expect(vi.mocked(mainLog.warn)).toHaveBeenCalledWith('[boot] rejects failed:', expect.any(Error))
  })
})

describe('boot wiring in index.ts (M2-0518)', () => {
  // index.ts boots Electron at import, so the wiring is read from its syntax tree: every launch reference to a
  // boot child process or fs/crypto job must sit inside a job handed to bootWork.run.
  const indexPath = join(__dirname, '..', 'index.ts')
  const indexSource = ts.createSourceFile(indexPath, readFileSync(indexPath, 'utf8'), ts.ScriptTarget.Latest, true)

  const findAll = (root: ts.Node, match: (node: ts.Node) => boolean): ts.Node[] => {
    const found: ts.Node[] = []
    const visit = (node: ts.Node): void => {
      if (match(node)) found.push(node)
      ts.forEachChild(node, visit)
    }
    visit(root)
    return found
  }
  const isCallTo = (node: ts.Node, callee: string): node is ts.CallExpression =>
    ts.isCallExpression(node) && node.expression.getText(indexSource) === callee

  const whenReady = findAll(indexSource, (node) => isCallTo(node, 'app.whenReady().then')) as ts.CallExpression[]
  const bootCallback = whenReady[0]?.arguments[0]

  /** True when `node` is, or sits inside, the job argument of a bootWork.run call (or a periodic setInterval re-run). */
  const insideBootJob = (node: ts.Node): boolean => {
    for (let current: ts.Node = node; current !== bootCallback && current.parent; current = current.parent) {
      const parent = current.parent
      if (isCallTo(parent, 'bootWork.run') && parent.arguments[1] === current) return true
      if (isCallTo(parent, 'setInterval')) return true
    }
    return false
  }

  it.each([
    'runBootSidecarReaper',
    'startAvailableMemorySampler',
    'prewarmCli',
    'verifyCliSessions',
    'importEmbeddedCloudflareKey',
    'provisionLocalModel',
    'recoverOrphanDrafts',
    'runRetentionSweep'
  ])('starts %s at launch only through the boot-work queue', (name) => {
    expect(whenReady).toHaveLength(1)
    expect(bootCallback).toBeDefined()
    const references = findAll(bootCallback!, (node) =>
      ts.isIdentifier(node) &&
      node.text === name &&
      !(ts.isVariableDeclaration(node.parent) && node.parent.name === node) &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    )
    expect(references.length, `${name} is never started at launch`).toBeGreaterThan(0)
    for (const reference of references) {
      const { line } = indexSource.getLineAndCharacterOfPosition(reference.getStart(indexSource))
      expect(insideBootJob(reference), `index.ts:${line + 1} starts ${name} outside bootWork.run`).toBe(true)
    }
  })

  it('opens the gate on the boot window, and holds app suspension off for every overlay window', () => {
    expect(bootCallback).toBeDefined()
    expect(findAll(bootCallback!, (node) => isCallTo(node, 'bootWork.releaseAfterFirstShow'))).toHaveLength(1)
    const createWindow = indexSource.statements.find(
      (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'createWindow'
    )
    expect(createWindow).toBeDefined()
    const holds = findAll(createWindow!, (node) => isCallTo(node, 'holdAppSuspensionWhileVisible')) as ts.CallExpression[]
    expect(holds).toHaveLength(1)
    expect(holds[0].arguments[1].getText(indexSource)).toBe('powerSaveBlocker')
  })
})
