import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const index = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const screenPreprocess = readFileSync(join(__dirname, 'screen-preprocess.ts'), 'utf8')

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

function expectBefore(source: string, first: string, second: string): void {
  const firstIndex = source.indexOf(first)
  const secondIndex = source.indexOf(second)
  expect(firstIndex).toBeGreaterThanOrEqual(0)
  expect(secondIndex).toBeGreaterThanOrEqual(0)
  expect(firstIndex).toBeLessThan(secondIndex)
}

describe('import-memory pressure contract', () => {
  it('defers every unattended local-start entry point before it can start or warm the sidecar', () => {
    const rendererPrewarm = between(index, 'ipcMain.handle(IPC.localPrewarm', '// --- Screen capture ---')
    const earlyEnsure = between(index, 'Overlap local sidecar start', '// Receipt Mode:')
    const bootWarm = between(index, 'const warmLocalIfReady = (): void => {', 'void provisionLocalModel(')
    const backgroundVlm = between(screenPreprocess, 'if (!text) {', 'if (!text) return')
    const backgroundVlmStart = between(screenPreprocess, 'async function describeOnce', 'async function describeForWindow')

    expectBefore(rendererPrewarm, 'speculativeLocalWorkAllowed()', 'void prewarmLocal(')
    expectBefore(earlyEnsure, 'speculativeLocalWorkAllowed()', 'ensureLocalRuntimeStarted(')
    expectBefore(bootWarm, 'speculativeLocalWorkAllowed()', 'void prewarmLocal(')
    expectBefore(backgroundVlm, 'allowSpeculativeLocalWork?.() === false', 'describeOnce(shot.image)')
    expect(rendererPrewarm).toContain(
      'prewarmLocal(s.localLlm.modelId, buildPrewarmMessages(parsed.data.text, s), speculativeLocalWorkAllowed)'
    )
    expect(bootWarm).toContain(
      "prewarmLocal(cur.localLlm.modelId, buildPrewarmMessages('warm', cur), speculativeLocalWorkAllowed)"
    )
    expect(earlyEnsure).toContain(
      "ensureLocalRuntimeStarted(s.localLlm.modelId, req.mode === 'vision', speculativeLocalWorkAllowed)"
    )
    expect(backgroundVlmStart).toContain(
      'ensureLocalRuntimeStarted(s.localLlm.modelId, true, deps.allowSpeculativeLocalWork)'
    )
  })

  it('reserves high-tier pressure after digest verification and clears it only after the helper stops', () => {
    const admission = between(index, 'onDecodeAdmission:', 'decode: (job) =>')
    const idle = between(index, 'onIdle: () => {', 'saveMeeting: (meeting) =>')

    expect(admission).toContain('highMemoryWhisperImportReserved = highTierVerified')
    expect(admission).toContain('await isHighTierAsrModelReady()')
    expectBefore(idle, 'stopWhisperHost()', 'highMemoryWhisperImportReserved = false')
    expect(idle).toContain('.finally(() =>')
  })
})
