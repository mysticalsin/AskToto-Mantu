import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { claimStartup, type StartupApp } from './startup-gate'

/** Two-launch harness: one shared "OS" lock, each launch is its own app object. */
function makeOs() {
  let owner: FakeApp | null = null
  const events: string[] = []
  class FakeApp extends EventEmitter implements StartupApp {
    quit = vi.fn(() => void events.push(`${this.name}:quit`))
    constructor(readonly name: string) {
      super()
    }
    requestSingleInstanceLock = vi.fn(() => {
      events.push(`${this.name}:lock`)
      if (owner && owner !== this) return false
      owner = this
      return true
    })
  }
  return { FakeApp, events, secondInstance: (argv: string[]) => owner?.emit('second-instance', {}, argv, '/cwd') }
}

const dialogs = () => ({ showErrorBox: vi.fn() })

describe('claimStartup (D-26 minimum OS, single instance)', () => {
  it('takes the lock before anything else and lets the first launch boot', () => {
    const os = makeOs()
    const app = new os.FakeApp('a')
    const dialog = dialogs()
    expect(
      claimStartup({ app, dialog, platform: 'darwin', systemVersion: '15.1', reveal: vi.fn(), argv: vi.fn() })
    ).toBe(true)
    expect(os.events).toEqual(['a:lock'])
    expect(app.quit).not.toHaveBeenCalled()
    expect(dialog.showErrorBox).not.toHaveBeenCalled()
  })

  it('a second launch quits without booting and the first receives only argv', () => {
    const os = makeOs()
    const first = new os.FakeApp('a')
    const second = new os.FakeApp('b')
    const onSecond = vi.fn()
    const reveal = vi.fn()
    const revealLoser = vi.fn()
    expect(
      claimStartup({
        app: first,
        dialog: dialogs(),
        platform: 'darwin',
        systemVersion: '15.1',
        reveal,
        argv: onSecond
      })
    ).toBe(true)
    const onSecondLoser = vi.fn()
    expect(
      claimStartup({
        app: second,
        dialog: dialogs(),
        platform: 'darwin',
        systemVersion: '15.1',
        reveal: revealLoser,
        argv: onSecondLoser
      })
    ).toBe(false)
    expect(second.quit).toHaveBeenCalledTimes(1)
    expect(second.listenerCount('second-instance')).toBe(0)
    os.secondInstance(['Metis', 'metis://handoff?x=1'])
    expect(onSecond).toHaveBeenCalledTimes(1)
    expect(onSecond).toHaveBeenCalledWith(['Metis', 'metis://handoff?x=1'])
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(onSecondLoser).not.toHaveBeenCalled()
    expect(revealLoser).not.toHaveBeenCalled()
  })

  it('exactly one boot (one mic owner, one usage event) across two launches', () => {
    const os = makeOs()
    const boots: string[] = []
    for (const name of ['a', 'b']) {
      const app = new os.FakeApp(name)
      if (
        claimStartup({
          app,
          dialog: dialogs(),
          platform: 'darwin',
          systemVersion: '15.1',
          reveal: vi.fn(),
          argv: vi.fn()
        })
      ) {
        boots.push(name) // stands for whenReady(): window, mic owner, sidecars, usage event
      }
    }
    expect(boots).toEqual(['a'])
  })

  it('an unsupported macOS shows the copy once, quits, and never takes the lock', () => {
    const os = makeOs()
    const app = new os.FakeApp('a')
    const dialog = dialogs()
    const args = { app, dialog, platform: 'darwin' as const, systemVersion: '13.6', reveal: vi.fn(), argv: vi.fn() }
    expect(claimStartup(args)).toBe(false)
    expect(dialog.showErrorBox).toHaveBeenCalledTimes(1)
    expect(dialog.showErrorBox).toHaveBeenCalledWith('Métis can’t open', 'Métis needs macOS 14.4 or later.')
    expect(app.quit).toHaveBeenCalledTimes(1)
    expect(app.requestSingleInstanceLock).not.toHaveBeenCalled()
    expect(app.listenerCount('second-instance')).toBe(0)
  })

  it('an unsupported Windows gets the Windows copy', () => {
    const os = makeOs()
    const dialog = dialogs()
    expect(
      claimStartup({
        app: new os.FakeApp('a'),
        dialog,
        platform: 'win32',
        systemVersion: '10.0.17134',
        reveal: vi.fn(),
        argv: vi.fn()
      })
    ).toBe(false)
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      'Métis can’t open',
      'Métis needs Windows 10 version 1809 or later.'
    )
  })

  it('a failing dialog still quits', () => {
    const os = makeOs()
    const app = new os.FakeApp('a')
    const dialog = {
      showErrorBox: vi.fn(() => {
        throw new Error('no display')
      })
    }
    expect(
      claimStartup({ app, dialog, platform: 'darwin', systemVersion: '12.0', reveal: vi.fn(), argv: vi.fn() })
    ).toBe(false)
    expect(app.quit).toHaveBeenCalledTimes(1)
  })
})
