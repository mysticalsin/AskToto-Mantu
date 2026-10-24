import { describe, expect, it, vi } from 'vitest'
import { openExternalLink } from './open-external-link'

const deps = (openExternal: (url: string) => Promise<void>) => {
  const notifyFailure = vi.fn()
  return { openExternal: vi.fn(openExternal), notifyFailure }
}

describe('openExternalLink (G55)', () => {
  it('opens https and mailto links and says nothing', async () => {
    const d = deps(async () => undefined)
    const n = vi.fn()
    expect(await openExternalLink('https://example.com/a', { ...d, notifyFailure: n })).toBe(true)
    expect(await openExternalLink('mailto:a@example.com', { ...d, notifyFailure: n })).toBe(true)
    expect(d.openExternal).toHaveBeenCalledTimes(2)
    expect(n).not.toHaveBeenCalled()
  })

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,x',
    'ms-msdt:x',
    'http://example.com',
    '',
    'not a url'
  ])('never opens %s and reports the failure', async (url) => {
    const d = deps(async () => undefined)
    const n = vi.fn()
    expect(await openExternalLink(url, { ...d, notifyFailure: n })).toBe(false)
    expect(d.openExternal).not.toHaveBeenCalled()
    expect(n).toHaveBeenCalledTimes(1)
  })

  it('reports a rejected open instead of an unhandled promise or fake success', async () => {
    const d = deps(async () => {
      throw new Error('no handler')
    })
    const n = vi.fn()
    expect(await openExternalLink('https://example.com', { ...d, notifyFailure: n })).toBe(false)
    expect(n).toHaveBeenCalledTimes(1)
  })

  it('survives a throwing notifier', async () => {
    const d = deps(async () => undefined)
    await expect(
      openExternalLink('javascript:1', {
        ...d,
        notifyFailure: () => {
          throw new Error('window gone')
        }
      })
    ).resolves.toBe(false)
  })
})
