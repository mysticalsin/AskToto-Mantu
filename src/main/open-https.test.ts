import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const { openExternal, spawnMock } = vi.hoisted(() => ({
  openExternal: vi.fn(async (_url: string) => {}),
  spawnMock: vi.fn()
}))

vi.mock('electron', () => ({ shell: { openExternal } }))
vi.mock('./logger', () => ({ mainLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }))

import { isHttpsUrl, openHttpsExternal, openHttpsViaOs } from './open-https'

function fakeChild(succeed = true): EventEmitter {
  const child = new EventEmitter() as EventEmitter & { unref: () => void }
  child.unref = vi.fn()
  queueMicrotask(() => {
    if (succeed) child.emit('spawn')
    else child.emit('error', new Error('spawn failed'))
  })
  return child
}

describe('open-https', () => {
  beforeEach(() => {
    openExternal.mockReset()
    openExternal.mockResolvedValue(undefined)
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => fakeChild(true))
  })

  describe('isHttpsUrl', () => {
    it('accepts https and refuses everything else', () => {
      expect(isHttpsUrl('https://signin.dust.tt/device')).toBe(true)
      expect(isHttpsUrl('http://signin.dust.tt/device')).toBe(false)
      expect(isHttpsUrl('file:///etc/passwd')).toBe(false)
      expect(isHttpsUrl('ms-msdt:something')).toBe(false)
      expect(isHttpsUrl('not a url')).toBe(false)
    })
  })

  describe('openHttpsExternal', () => {
    it('uses shell.openExternal first and does not spawn a fallback on success', async () => {
      await expect(openHttpsExternal('https://signin.dust.tt/device')).resolves.toBe(true)
      expect(openExternal).toHaveBeenCalledWith('https://signin.dust.tt/device')
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('falls back to the OS opener when openExternal rejects with spawn EINVAL', async () => {
      openExternal.mockRejectedValueOnce(new Error('spawn EINVAL'))
      const prev = process.platform
      Object.defineProperty(process, 'platform', { value: 'win32' })
      try {
        await expect(openHttpsExternal('https://signin.dust.tt/device?user_code=ABCD')).resolves.toBe(true)
        expect(spawnMock).toHaveBeenCalled()
        const [command, args, opts] = spawnMock.mock.calls[0]
        expect(String(command).toLowerCase()).toMatch(/cmd\.exe$/)
        expect(args).toEqual(['/d', '/s', '/c', 'start', '""', 'https://signin.dust.tt/device?user_code=ABCD'])
        expect(opts).toMatchObject({ shell: false, detached: true })
      } finally {
        Object.defineProperty(process, 'platform', { value: prev })
      }
    })

    it('returns false (never throws) when both Electron and the OS opener fail', async () => {
      openExternal.mockRejectedValueOnce(new Error('spawn EINVAL'))
      spawnMock.mockImplementation(() => fakeChild(false))
      await expect(openHttpsExternal('https://signin.dust.tt/device')).resolves.toBe(false)
    })

    it('refuses a non-https URL without calling openExternal', async () => {
      await expect(openHttpsExternal('file:///tmp/x')).resolves.toBe(false)
      expect(openExternal).not.toHaveBeenCalled()
      expect(spawnMock).not.toHaveBeenCalled()
    })
  })

  describe('openHttpsViaOs', () => {
    it('routes darwin through open', async () => {
      const prev = process.platform
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      try {
        await openHttpsViaOs('https://example.com')
        expect(spawnMock.mock.calls[0][0]).toBe('open')
        expect(spawnMock.mock.calls[0][1]).toEqual(['https://example.com'])
      } finally {
        Object.defineProperty(process, 'platform', { value: prev })
      }
    })
  })
})
