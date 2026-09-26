import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const main = readFileSync(join(__dirname, 'index.ts'), 'utf8')
const preload = readFileSync(join(__dirname, '../preload/index.ts'), 'utf8')
const ipc = readFileSync(join(__dirname, '../shared/ipc.ts'), 'utf8')
const register = readFileSync(join(__dirname, 'metis-command-register.ts'), 'utf8')

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
  })

  it('accepts command text only from the current local-microphone cloud-STT track', () => {
    const callbacks = between(main, 'onFinal: (line) => {', 'onError: (message) => {')
    expect(callbacks).toMatch(/if \(!isCurrentCloudSttOwner\(owner, e\.sender\)\) return/)
    expect(callbacks).toMatch(/line\.speaker === 'you'/)
    expect(callbacks).toMatch(/channel === 'you'/)
    expect(callbacks).toMatch(/isCurrentCloudSttCommandOwner\(owner, e\.sender\)/)
    expect(callbacks).toMatch(/ingestMetisCommandFromAsr\(line\.text\)/)
    expect(callbacks).toMatch(/ingestMetisCommandFromAsr\(text\)/)
    expect(callbacks).not.toContain("'meeting'")
  })

  it('revokes command authority before graceful stop can emit final provider audio', () => {
    const stop = between(main, 'ipcMain.handle(IPC.cloudSttStop', 'ipcMain.handle(IPC.cloudSttPush')
    expect(stop).toContain('cloudSttCommandOwner = null')
    expect(stop).toContain("getMetisCommandRuntime()?.reset('cloud_stt_stop')")
  })

  it('feeds Cap2 from local-mic Parakeet/Apple YOU tracks', () => {
    const para = between(main, 'ipcMain.handle(IPC.parakeetFeed', 'ipcMain.handle(IPC.appleSpeechFeed')
    expect(para).toMatch(/p\.speaker === 'you'/)
    expect(para).toContain('ingestMetisCommandFromAsr(text)')
    const apple = between(main, 'ipcMain.handle(IPC.appleSpeechFeed', 'ipcMain.handle(IPC.cloudSttStart')
    expect(apple).toMatch(/p\.speaker === 'you'/)
    expect(apple).toContain('ingestMetisCommandFromAsr(text)')
  })

})
