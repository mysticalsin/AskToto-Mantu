/**
 * responsiveness-wiring.contract.test.ts — G12's seams in main stay thin, in the right place, and local.
 *
 * index.ts boots Electron at import time, so its seams are pinned against the real source, the same
 * structural proof every sibling *.contract.test.ts uses. Paths tolerate CRLF and `\`.
 */
import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../test-helpers/module-source'

const indexSrc = readModuleSource(__dirname, './index').text
const liveSessionSrc = readModuleSource(__dirname, './cloud-stt/live-session').text
const recorderSrc = readModuleSource(__dirname, './infra/observability/responsiveness-recorder').text

function between(source: string, from: RegExp, to: RegExp): string {
  const start = source.search(from)
  expect(start, `${from} must exist`).toBeGreaterThan(-1)
  const rest = source.slice(start)
  const end = rest.slice(1).search(to)
  return end < 0 ? rest : rest.slice(0, end + 1)
}

describe('ask seams in index.ts', () => {
  it('times a suggest request from the moment the schema accepts it', () => {
    const body = between(indexSrc, /ipcMain\.handle\(IPC\.askStart/, /ipcMain\.handle\(IPC\.askCancel/)
    expect(body).toMatch(/const req = AskStartSchema\.parse\(raw\)\r?\n\s*askTiming\.start\(req\.id, req\.mode\)/)
  })

  it('marks the first visible token where the existing time-to-first-token is taken, and only there', () => {
    const body = between(indexSrc, /const paint = \(text: string\): void => \{/, /const failAttempt =/)
    expect(body).toMatch(
      /if \(!gotToken\) \{\r?\n\s*ttftMs = Date\.now\(\) - startedAt\r?\n(?:.*\r?\n)*?\s*askTiming\.firstVisible\(req\.id\)/
    )
    expect(indexSrc.match(/askTiming\.firstVisible\(/g)).toHaveLength(1)
  })

  it('cancels through the timed helper instead of calling abort by hand', () => {
    const body = between(indexSrc, /ipcMain\.handle\(IPC\.askCancel/, /ipcMain\.handle\(IPC\.askResetContext/)
    expect(body).toMatch(/askTiming\.cancel\(streams, id\)/)
    expect(body).not.toMatch(/streams\.get\(id\)\?\.abort\(\)/)
    expect(body).toMatch(/assertMainWindow\(e\)/)
    expect(body).toMatch(/requireAuth\(\)/)
  })

  it('takes askTiming from the ask stream registry module it already imports', () => {
    expect(indexSrc).toMatch(/import \{[^}]*\baskTiming\b[^}]*\} from '\.\/ask-stream-registry'/)
  })
})

describe('first partial seam in the live session', () => {
  it('starts the clock after a chunk is sent and stops it when text is handed on', () => {
    expect(liveSessionSrc).toMatch(/createFirstPartialProbe\(\)/)
    const sendAt = liveSessionSrc.indexOf('track.ws.send(pcm)')
    expect(sendAt).toBeGreaterThan(-1)
    expect(liveSessionSrc.indexOf('this.firstPartial.audioSent()', sendAt)).toBeGreaterThan(sendAt)
    expect(liveSessionSrc.match(/this\.firstPartial\.textSeen\(\)/g)).toHaveLength(2)
  })
})

describe('the recorder stays content-free and local', () => {
  it('imports no transcript, prompt, settings, brain or network module', () => {
    const imports = [...recorderSrc.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort()
    expect(imports).toEqual(
      ['electron', 'node:fs/promises', 'node:path', 'node:perf_hooks', '../../../shared/responsiveness-metrics'].sort()
    )
  })

  it('uses no synchronous fs and no timer: it must not add to FF-05a or FF-14', () => {
    expect(recorderSrc).not.toMatch(/\b(readFileSync|writeFileSync|existsSync|mkdirSync|renameSync|statSync)\b/)
    expect(recorderSrc).not.toMatch(/\b(setTimeout|setInterval)\b/)
  })

  it('sends nothing off the device: the Operator payload is not widened by G12', () => {
    for (const specifier of ['./operator-ingest', './operator-queue', './operator-reporting-policy']) {
      const { text } = readModuleSource(__dirname, specifier)
      expect(text, specifier).not.toMatch(/responsiveness/i)
    }
    expect(recorderSrc).not.toMatch(/\bfetch\(|https?:\/\/|net\.request/)
  })
})
