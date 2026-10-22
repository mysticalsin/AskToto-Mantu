import { describe, expect, it } from 'vitest'
import { readModuleSource } from '../test-helpers/module-source'

const source = readModuleSource(__dirname, './index').text

/** The ask handler, from its registration to the cancel handler that follows it. */
const askHandler = (): string => {
  const start = source.indexOf('ipcMain.handle(IPC.askStart')
  const end = source.indexOf('ipcMain.handle(IPC.askCancel')
  if (start < 0 || end < start) throw new Error('ask handler boundaries not found')
  return source.slice(start, end)
}

describe('G14: ask and suggest publish through their meeting queue turn', () => {
  it('takes a turn on the meeting queue right after the conversation context is applied', () => {
    const body = askHandler()
    const applied = body.indexOf('applyAskContext(')
    const begun = body.indexOf('await askTurns.begin(')
    expect(applied).toBeGreaterThan(0)
    expect(begun).toBeGreaterThan(applied)
    expect(body).toMatch(/askTurns\.begin\(\{[^}]*handle: contextGate\.handle\(\)/)
    expect(body.slice(begun, begun + 200)).toMatch(/if \(!turn\) return/)
  })

  it('sends every stream delta, meta, done and error of the dispatch through the turn, never straight to the window', () => {
    const body = askHandler()
    const dispatch = body.slice(body.indexOf('await askTurns.begin('))
    expect(dispatch).not.toMatch(/win\??\.webContents\.send\(\s*IPC\.stream(Delta|Meta|Done|Error)/)
    for (const channel of ['streamDelta', 'streamMeta', 'streamDone', 'streamError']) {
      expect(dispatch).toContain(`turn.send(IPC.${channel}`)
    }
  })

  it('reports start failures and gate refusals through the turn registry so the queue slot is freed', () => {
    const body = askHandler()
    expect(body).toMatch(/failAskStart = \(err: unknown\): void => askTurns\.fail\(/)
    expect(body).toMatch(/onRefused: \(message\) => askTurns\.fail\(/)
  })

  it('a renderer cancel is timed by G12, then releases the turn and aborts the provider stream', () => {
    const start = source.indexOf('ipcMain.handle(IPC.askCancel')
    const body = source.slice(start, start + 400)
    expect(body).toMatch(/askTiming\.cancel\(streams, id\)\s*\n\s*askTurns\.cancel\(id\)/)
  })

  it('builds the turn registry over the main process stream map and the window', () => {
    expect(source).toMatch(/const askTurns = createAskTurns\(\{[^}]*webContents\.send[^}]*streams/)
  })
})
