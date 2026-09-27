import { describe, expect, it, vi } from 'vitest'
import { observeSidecar, type SidecarProcess } from './sidecar-events'

function child(pid?: number): SidecarProcess & { exit: (code: number | null, signal: NodeJS.Signals | null) => void } {
  let listener: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined
  return {
    pid,
    once: vi.fn((_event, fn) => {
      listener = fn
    }),
    exit: (code, signal) => listener?.(code, signal)
  }
}

describe('observeSidecar', () => {
  it('audits spawn with name, pid and resolved pgid', () => {
    const audit = vi.fn()
    observeSidecar('llama-server', child(4242), audit, undefined, () => 5151)

    expect(audit).toHaveBeenCalledWith('sidecar.spawn', { name: 'llama-server', pid: 4242, pgid: 5151 })
  })

  it('audits exit with the same pid, pgid, code, signal and uptimeMs', () => {
    const audit = vi.fn()
    const proc = child(4242)
    let now = 100
    observeSidecar('fm-serve', proc, audit, () => now, () => 5151)

    now = 175
    proc.exit(0, 'SIGTERM')

    expect(audit).toHaveBeenCalledWith('sidecar.exit', {
      name: 'fm-serve',
      pid: 4242,
      pgid: 5151,
      code: 0,
      signal: 'SIGTERM',
      uptimeMs: 75
    })
  })

  it('audits null pgid only when the platform cannot resolve it', () => {
    const audit = vi.fn()
    observeSidecar('llama-server', child(4242), audit, undefined, () => null)

    expect(audit).toHaveBeenCalledWith('sidecar.spawn', { name: 'llama-server', pid: 4242, pgid: null })
  })

  it('emits nothing when the process has no pid', () => {
    const audit = vi.fn()
    observeSidecar('llama-server', child(undefined), audit)

    expect(audit).not.toHaveBeenCalled()
  })
})
