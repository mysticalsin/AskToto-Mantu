import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const main = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const preload = readFileSync(join(__dirname, '../preload/index.ts'), 'utf8')
const ipc = readFileSync(join(__dirname, '../shared/ipc.ts'), 'utf8')
const register = readFileSync(join(__dirname, 'metis-command-register.ts'), 'utf8')
const app = readFileSync(join(__dirname, '../renderer/src/App.tsx'), 'utf8')

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  expect(from, `missing start marker: ${start}`).toBeGreaterThan(-1)
  const to = source.indexOf(end, from)
  expect(to, `missing end marker: ${end}`).toBeGreaterThan(-1)
  return source.slice(from, to)
}

describe('Cap2 command authority boundary', () => {
  it('does not expose a renderer IPC that can manufacture desktop commands', () => {
    expect(preload).not.toContain('metisCommandIngest')
    expect(ipc).not.toContain('metisCommandIngest')
    expect(register).not.toContain('IPC.metisCommandIngest')
    expect(preload).not.toContain('metisCommandStop')
    expect(preload).not.toContain('onMetisCommandState')
    expect(ipc).not.toContain('metisCommandState')
    expect(ipc).not.toContain('metisCommandStop')
  })

  it('keeps cloud STT transcript-only because renderer PCM has no hardware provenance', () => {
    const callbacks = between(main, 'onFinal: (line) => {', 'onError: (message) => {')
    expect(callbacks).toMatch(/if \(!isCurrentCloudSttOwner\(owner, e\.sender\)\) return/)
    expect(callbacks).toMatch(/e\.sender\.send\(IPC\.cloudSttFinal, line\)/)
    expect(callbacks).toMatch(/e\.sender\.send\(IPC\.cloudSttInterim, \{ channel, text \}\)/)
    expect(callbacks).not.toContain('ingestMetisCommandFromAsr')
    expect(main).not.toContain('ingestMetisCommandFromAsr')
  })

  it('keeps native ASR transcript-only so delayed local decodes cannot command-execute', () => {
    const para = between(main, 'ipcMain.handle(IPC.parakeetFeed', 'ipcMain.handle(IPC.appleSpeechFeed')
    expect(para).toMatch(/p\.speaker === 'you'/)
    expect(para).not.toContain('ingestMetisCommandFromAsr')
    const apple = between(main, 'ipcMain.handle(IPC.appleSpeechFeed', 'ipcMain.handle(IPC.cloudSttStart')
    expect(apple).toMatch(/p\.speaker === 'you'/)
    expect(apple).not.toContain('ingestMetisCommandFromAsr')
  })

  it('does not open a second always-on microphone stream or render its competing status chip', () => {
    expect(app).not.toContain('startMetisCommandEar')
    expect(app).not.toContain('data-metis-command-ear-chip')
    expect(app).not.toContain('CommandListeningPill')
  })

})
