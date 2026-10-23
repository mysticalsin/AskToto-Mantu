import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../../test-helpers/module-source'

const mainDir = join(__dirname, '..')

function productionSources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...productionSources(path))
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push({ file: path, text: readFileSync(path, 'utf8') })
  }
  return out
}
const rel = (file: string): string =>
  file
    .slice(mainDir.length + 1)
    .replace(/\\/g, '/')
    .replace(/\.ts$/, '')

describe('voice actions wiring (V03)', () => {
  it('recognized text reaches the voice pipeline before the command panel, from one place in index.ts', () => {
    const index = readModuleSource(__dirname, '../index').text
    expect(index).toMatch(
      /ingestTranscript: \(text\) => \{\r?\n\s+if \(!voiceActions\?\.onTranscript\(text\)\) getMetisCommandRuntime\(\)\?\.ingestTranscript\(text, 'command'\)\r?\n\s+\},/
    )
    expect(index).toMatch(
      /turns: createMainVoiceTurns\(\{\s+commandControl,\s+authority: inputSessionAuthority,\s+window: \(\) => win,\s+walkthroughEnabled: \(\) => QA_IDENTITY_BUILD/
    )
  })

  it('every desktop action dispatch goes through the one durable task bridge', () => {
    const callers = productionSources(mainDir)
      .filter(({ text }) => /\bexecuteDesktopAction\(/.test(text))
      .map(({ file }) => rel(file))
      .sort()
    expect(callers).toEqual(['desktop-adapters', 'tasks/desktop-action-task-runtime'])
    const runtime = readModuleSource(__dirname, '../tasks/desktop-action-task-runtime').text
    expect(runtime).toMatch(/execute:\s*\(request, envelope, signal\)\s*=>/)
    expect(runtime).toContain(
      'executeDesktopAction(request, { envelope, deps: createProductionDesktopAdapterDeps(), signal })'
    )
    // One bridge per process, shared by CommandConfirmation and the voice pipeline.
    expect(runtime).toMatch(/if \(!sharedDeps\) \{/)
  })

  it('no voice module starts a process, opens a microphone or imports the renderer', () => {
    for (const spec of [
      './voice-router',
      './voice-action-executor',
      './voice-turn-handler',
      './voice-turns-main',
      './safe-targets'
    ]) {
      const text = readModuleSource(__dirname, spec).text
      expect(text, spec).not.toMatch(/child_process|execFile|spawn\(|getUserMedia|AudioContext/)
      expect(text, spec).not.toMatch(/renderer\/src/)
    }
  })

  it('the router resolves no provider, model, key or endpoint: the classifier is a seam, not a binding', () => {
    const router = readModuleSource(__dirname, './voice-router').text
    expect(router).not.toMatch(/resolveModelTier|PROVIDERS\[|resolveManagedModel|apiKey|baseURL|fetch\(/)
    const turns = readModuleSource(__dirname, './voice-turns-main').text
    expect(turns).toContain('providerReady: () => false')
    expect(turns).not.toMatch(/classify:/)
  })

  it('a voice action is refused while a meeting records, at the gate and at the turn', () => {
    const turns = readModuleSource(__dirname, './voice-turns-main').text
    expect(turns).toContain('meetingReserved: deps.authority.hasMeetingReservation')
    const executor = readModuleSource(__dirname, './voice-action-executor').text
    expect(executor).toContain("return 'meeting_recording'")
  })

  it('the audit event exists and the executor never puts request arguments in it', () => {
    const logger = readModuleSource(__dirname, '../logger').text
    expect(logger).toContain("| 'voice.action'")
    const executor = readModuleSource(__dirname, './voice-action-executor').text
    const audit = executor.slice(
      executor.indexOf('audit({'),
      executor.indexOf('return result', executor.indexOf('audit({'))
    )
    expect(audit).not.toMatch(/args|title|query|\.q\b|preview/)
  })

  it('the panel parser has no provider or model resolution (rule based, not model-routed)', () => {
    const parse = readModuleSource(__dirname, '../../shared/metis-command-parse').text
    expect(parse).not.toMatch(/resolveModelTier|PROVIDERS\[/)
    const grammar = readModuleSource(__dirname, '../../shared/voice/voice-grammar').text
    expect(grammar).not.toMatch(/resolveModelTier|PROVIDERS\[|fetch\(|child_process/)
  })
})
