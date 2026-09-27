import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStopAll, type OwnedChildren } from '../infra/process/stop-all'
import { installExitPaths, type ExitApp } from './exit-paths'

/** A real OS process that runs until it is killed, on every platform. Standing in for a sidecar so the
 *  exit paths are proven against something the OS actually has to tear down, not a spy. */
function spawnStandIn(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore', windowsHide: true })
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return once(child, 'exit').then(() => undefined)
}

class FakeApp extends EventEmitter implements ExitApp {
  readonly calls: string[] = []
  liveAtExit: number | null = null

  constructor(private readonly children: ChildProcess[]) {
    super()
  }

  quit(): void {
    // The wedged quit the emergency path exists for: never emits will-quit.
    this.calls.push('quit')
  }

  exit(exitCode: number): void {
    this.liveAtExit = this.children.filter((child) => child.killed === false).length
    this.calls.push(`exit:${exitCode}`)
  }

  relaunch(): void {
    this.calls.push('relaunch')
  }
}

let liveChildren: ChildProcess[] = []

afterEach(() => {
  for (const child of liveChildren.splice(0)) {
    if (!child.killed) child.kill('SIGKILL')
  }
})

function harness(options: { broken?: boolean } = {}) {
  const children = [spawnStandIn(), spawnStandIn(), spawnStandIn()]
  liveChildren = children
  const app = new FakeApp(children)
  const calls = app.calls
  const bootWatchThrows = options.broken === true
  const closeBootWatch = vi.fn((): void => {
    calls.push('bootWatch')
    if (bootWatchThrows) throw new Error('boot watch close failed')
  })
  const warn = vi.fn()

  const families: OwnedChildren[] = []
  if (options.broken) {
    families.push({
      name: 'broken',
      stop: () => {
        throw new Error('broken family failed')
      }
    })
  }
  children.forEach((child, index) => {
    families.push({
      name: `child-${index}`,
      stop: () => {
        if (!child.killed) child.kill('SIGKILL')
      }
    })
  })
  const stopAll = createStopAll(families, (name, error) => warn(`[stop-all] ${name} failed to stop`, error))

  const paths = installExitPaths(app, { stopAll, closeBootWatch, warn })
  return { app, calls, children, closeBootWatch, warn, ...paths }
}

describe('installExitPaths', () => {
  describe('will-quit and the fatal relaunch', () => {
    it('E1: will-quit stops every owned child', async () => {
      const { app, calls, children } = harness()

      app.emit('will-quit')

      await Promise.all(children.map((child) => exited(child)))
      expect(calls).toEqual([])
    })

    it('E3: exitAndRelaunch stops every owned child before it exits, then relaunches', async () => {
      const { app, calls, children, closeBootWatch, exitAndRelaunch } = harness()

      exitAndRelaunch()

      expect(calls).toEqual(['relaunch', 'exit:0'])
      expect(app.liveAtExit).toBe(0)
      expect(closeBootWatch).not.toHaveBeenCalled()
      await Promise.all(children.map((child) => exited(child)))
    })
  })

  describe('the emergency force quit', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('F1: forceQuit asks politely first', () => {
      const { calls, children, forceQuit } = harness()

      forceQuit()

      expect(calls).toEqual(['quit'])
      expect(children.every((child) => child.killed === false)).toBe(true)
    })

    it("F2: stays polite through before-quit's own 2s flush window", () => {
      const { calls, children, forceQuit } = harness()

      forceQuit()
      vi.advanceTimersByTime(2_000)

      expect(calls.some((call) => call.startsWith('exit:'))).toBe(false)
      expect(children.every((child) => child.killed === false)).toBe(true)
    })

    it('F3: hard-exits once the polite quit has plainly failed', async () => {
      const { app, calls, children, forceQuit } = harness()

      forceQuit()
      vi.advanceTimersByTime(5_000)

      expect(calls).toEqual(['quit', 'bootWatch', 'exit:0'])
      expect(app.liveAtExit).toBe(0)
      await Promise.all(children.map((child) => exited(child)))
    })

    it('F4: a second press exits at once', () => {
      const { app, forceQuit } = harness()

      forceQuit()
      vi.advanceTimersByTime(100)
      forceQuit()

      expect(app.calls).toContain('exit:0')
      expect(app.liveAtExit).toBe(0)
    })

    it('F5: a throwing child kill or boot-watch close never keeps the process up', async () => {
      const { calls, children, forceQuit } = harness({ broken: true })

      forceQuit()
      vi.advanceTimersByTime(5_000)

      expect(calls).toContain('exit:0')
      await Promise.all(children.map((child) => exited(child)))
    })
  })

  describe('the watchdog never keeps a quitting process alive', () => {
    it('F6: forceQuit leaves no extra active timeout behind', () => {
      const { forceQuit } = harness()
      const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length

      forceQuit()

      const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
      expect(after).toBe(before)
    })
  })
})
