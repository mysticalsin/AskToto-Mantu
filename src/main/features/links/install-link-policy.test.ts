import { describe, expect, it, vi } from 'vitest'
import { LINK_IPC } from '@shared/links'
import { readModuleSource } from '../../../test-helpers/module-source'

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async () => undefined) }))
vi.mock('electron', () => ({ shell: { openExternal } }))

import { installLinkPolicy } from './install-link-policy'

function fakeContents(currentUrl = 'app://overlay/index.html') {
  let openHandler: (d: { url: string }) => { action: string } = () => ({ action: 'allow' })
  const listeners = new Map<string, (...a: never[]) => void>()
  const contents = {
    setWindowOpenHandler: vi.fn((h: typeof openHandler) => void (openHandler = h)),
    on: vi.fn((e: string, h: (...a: never[]) => void) => void listeners.set(e, h)),
    getURL: () => currentUrl,
    isDestroyed: () => false,
    send: vi.fn()
  }
  installLinkPolicy(contents as never)
  return { contents, open: (url: string) => openHandler({ url }), listeners }
}

describe('installLinkPolicy keeps the old index.ts handler rules (G55)', () => {
  it('always denies a child window, so nothing inherits the privileged preload', async () => {
    const { open } = fakeContents()
    for (const url of ['https://example.com', 'javascript:1', 'file:///x', 'http://a.test']) {
      expect(open(url)).toEqual({ action: 'deny' })
    }
  })

  it('opens an https link in the real browser, as before', async () => {
    openExternal.mockClear()
    const { open, contents } = fakeContents()
    open('https://example.com/a')
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://example.com/a'))
    expect(contents.send).not.toHaveBeenCalled()
  })

  it('never hands a non-allow-listed scheme to the OS, and tells the renderer (G55 addition)', async () => {
    openExternal.mockClear()
    const { open, contents } = fakeContents()
    open('javascript:alert(1)')
    open('file:///etc/passwd')
    open('http://example.com')
    await vi.waitFor(() => expect(contents.send).toHaveBeenCalledTimes(3))
    expect(contents.send).toHaveBeenCalledWith(LINK_IPC.openFailed)
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('blocks navigation away from the renderer page and allows the same URL, as before', () => {
    const { listeners } = fakeContents('app://overlay/index.html')
    const nav = listeners.get('will-navigate') as unknown as (e: { preventDefault(): void }, url: string) => void
    const away = { preventDefault: vi.fn() }
    nav(away, 'https://evil.test')
    expect(away.preventDefault).toHaveBeenCalled()
    const same = { preventDefault: vi.fn() }
    nav(same, 'app://overlay/index.html')
    expect(same.preventDefault).not.toHaveBeenCalled()
  })

  it('is what the overlay window calls: index.ts installs it on the window it creates and no longer inlines the handler', () => {
    const main = readModuleSource(__dirname, '../../index').text
    expect(main).toContain('installLinkPolicy(win.webContents)')
    expect(main).not.toMatch(/win\.webContents\.setWindowOpenHandler\(/)
    const policy = readModuleSource(__dirname, './install-link-policy').text
    expect(policy).toMatch(/setWindowOpenHandler/)
    expect(policy).toMatch(/action:\s*'deny'/)
    expect(policy).toMatch(/'will-navigate'/)
  })
})
