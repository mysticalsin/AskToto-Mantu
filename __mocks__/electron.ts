import { vi } from 'vitest'

export const app = {
  getPath: vi.fn((name: string) => {
    if (name === 'userData') return '/tmp/asktoto-test-userdata'
    if (name === 'documents') return '/tmp/asktoto-test-documents'
    return `/tmp/asktoto-${name}`
  }),
  getVersion: vi.fn(() => '0.1.0-test'),
  isReady: vi.fn(() => true),
  whenReady: vi.fn(() => Promise.resolve()),
  on: vi.fn(),
  once: vi.fn()
}

export const safeStorage = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`)),
  decryptString: vi.fn((buffer: Buffer) => {
    const s = buffer.toString('utf8')
    return s.startsWith('enc:') ? s.slice(4) : s
  })
}

export const desktopCapturer = {
  getSources: vi.fn(() => Promise.resolve([]))
}

export const shell = {
  openExternal: vi.fn(() => Promise.resolve()),
  openPath: vi.fn(() => Promise.resolve(''))
}

// Proxy-aware main-process fetch (updater's release-feed check). Tests stub per-call via
// vi.mocked(net.fetch).mockResolvedValue(...).
export const net = {
  fetch: vi.fn(() => Promise.reject(new Error('net.fetch not stubbed in this test')))
}

export const ipcMain = {
  on: vi.fn(),
  handle: vi.fn()
}

export const BrowserWindow = vi.fn()

// Native OS notification. `new Notification(opts)` records the options on the mock, and the object it
// returns carries a `show` spy, so a test can assert both that something was shown and what it said.
export const Notification = Object.assign(
  vi.fn(function (this: { options: unknown; show: () => void }, options: { title?: string; body?: string }) {
    this.options = options
    this.show = vi.fn()
  }),
  { isSupported: vi.fn(() => true) }
)
