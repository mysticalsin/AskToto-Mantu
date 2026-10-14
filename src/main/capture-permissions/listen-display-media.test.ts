import { describe, expect, it, vi } from 'vitest'
import { registerListenDisplayMedia } from './listen-display-media'
import { SpeechCaptureGrantRegistry } from './speech-capture-grant'

function fixture() {
  const frame = { parent: null, url: 'file:///app/index.html' }
  const contents = { mainFrame: frame, getURL: () => frame.url }
  const window = { webContents: contents, isDestroyed: () => false }
  const context = { webContents: contents, frame, navigationEpoch: 1, listenStartedAt: 100 }
  const grants = new SpeechCaptureGrantRegistry()
  grants.acceptListenContext(context)
  grants.setArmed(true)
  let handler: (request: any, callback: any) => Promise<void> = async () => {}
  let armed = true
  const acquireScreenSource = vi.fn(async () => ({ id: 'screen:fixture' }))
  registerListenDisplayMedia({
    session: { setDisplayMediaRequestHandler: (callback: any) => { handler = callback } } as never,
    getWindow: () => window as never,
    isAudioArmed: () => armed,
    acquireScreenSource: acquireScreenSource as never,
    denyDisplayMedia: null as never,
    warn: vi.fn(), grants, readContext: () => context
  })
  const request = { frame, securityOrigin: 'file:///', audioRequested: true, videoRequested: false }
  return { handler, request, grants, context, acquireScreenSource, disarm: () => { armed = false; grants.setArmed(false) } }
}

describe('Listen display-media grant', () => {
  it('records an actual successful Windows loopback callback without grabbing a screen', async () => {
    const f = fixture()
    const callback = vi.fn()
    await f.handler(f.request, callback)
    expect(callback).toHaveBeenCalledWith({ audio: 'loopback' })
    expect(f.acquireScreenSource).not.toHaveBeenCalled()
    f.disarm()
    expect(f.grants.hasIssuedLoopbackGrant(f.context)).toBe(true)
  })

  it('does not record a grant when Electron rejects the callback', async () => {
    const f = fixture()
    await f.handler(f.request, () => { throw new Error('fixture rejection') })
    expect(f.grants.hasIssuedLoopbackGrant(f.context)).toBe(false)
  })

  it('rechecks ownership after asynchronous screen acquisition', async () => {
    const f = fixture()
    let resolve: (source: any) => void = () => {}
    f.acquireScreenSource.mockImplementation(() => new Promise((r) => { resolve = r }))
    const callback = vi.fn()
    const pending = f.handler({ ...f.request, videoRequested: true }, callback)
    f.disarm()
    resolve({ id: 'screen:fixture' })
    await pending
    expect(callback).toHaveBeenCalledWith(null)
    expect(f.grants.hasIssuedLoopbackGrant(f.context)).toBe(false)
  })

  it('denies a different main-frame object before capture', async () => {
    const f = fixture()
    const callback = vi.fn()
    await f.handler({ ...f.request, frame: { ...f.request.frame }, videoRequested: true }, callback)
    expect(callback).toHaveBeenCalledWith(null)
    expect(f.acquireScreenSource).not.toHaveBeenCalled()
    expect(f.grants.hasIssuedLoopbackGrant(f.context)).toBe(false)
  })
})
