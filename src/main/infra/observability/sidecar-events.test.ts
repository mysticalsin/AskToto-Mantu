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
  it('audits spawn with name, pid and null pgid', () => {
    const audit = vi.fn()
    observeSidecar('llama-server', child(4242), audit)

    expect(audit).toHaveBeenCalledWith('sidecar.spawn', { name: 'llama-server', pid: 4242, pgid: null })
  })

  it('audits exit with the same pid, code, signal and uptimeMs', () => {
    const audit = vi.fn()
    const proc = child(4242)
    let now = 100
    observeSidecar('fm-serve', proc, audit, () => now)

    now = 175
    proc.exit(0, 'SIGTERM')

    expect(audit).toHaveBeenCalledWith('sidecar.exit', {
      name: 'fm-serve',
      pid: 4242,
      pgid: null,
      code: 0,
      signal: 'SIGTERM',
      uptimeMs: 75
    })
  })

  it('emits nothing when the process has no pid', () => {
    const audit = vi.fn()
    observeSidecar('llama-server', child(undefined), audit)

    expect(audit).not.toHaveBeenCalled()
  })
})
