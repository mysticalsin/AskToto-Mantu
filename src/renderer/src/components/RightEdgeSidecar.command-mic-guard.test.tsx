import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const sidecar = readFileSync(resolve(__dirname, 'RightEdgeSidecar.tsx'), 'utf8')

describe('right-edge microphone and command safety contract', () => {
  it('uses the app-owned meeting action instead of acquiring a second command microphone lease', () => {
    expect(sidecar).toContain('onToggleListen')
    expect(sidecar).toContain("label={listening ? 'Stop meeting' : 'Start listening'}")
    expect(sidecar).not.toContain('useCommandMic')
    expect(sidecar).not.toContain('Test microphone access')
    expect(sidecar).not.toContain('getUserMedia')
    expect(sidecar).not.toContain('interpret or save speech')
  })

  it('never confirms an opaque pending command and revokes it when the dock is closed', () => {
    expect(sidecar).toContain('cancelMetisCommand')
    expect(sidecar).toContain('It cannot be approved here.')
    expect(sidecar).toMatch(/const close = \(\): void => \{[\s\S]*?cancelPendingCommand\(\)[\s\S]*?onClose\(\)/)
    expect(sidecar).toMatch(/event\.key === 'Escape'/)
    expect(sidecar).not.toContain('Confirm pending action')
  })
})
