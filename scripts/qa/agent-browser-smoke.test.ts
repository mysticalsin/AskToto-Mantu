import { describe, expect, it } from 'vitest'
import { failureClass, loopbackDebuggerWebSocket } from './agent-browser-smoke.mjs'

describe('loopbackDebuggerWebSocket', () => {
  it('accepts the browser WebSocket advertised by the isolated Electron CDP endpoint', () => {
    expect(loopbackDebuggerWebSocket('ws://127.0.0.1:9222/devtools/browser/0123456789abcdef', 9222)).toBe(
      'ws://127.0.0.1:9222/devtools/browser/0123456789abcdef'
    )
  })

  it.each([
    ['a non-loopback host', 'ws://example.com:9222/devtools/browser/id', 9222],
    ['the wrong port', 'ws://127.0.0.1:9223/devtools/browser/id', 9222],
    ['a page target', 'ws://127.0.0.1:9222/devtools/page/id', 9222],
    ['a credential-bearing URL', 'ws://user:pass@127.0.0.1:9222/devtools/browser/id', 9222],
    ['a URL with a query string', 'ws://127.0.0.1:9222/devtools/browser/id?token=value', 9222]
  ])('rejects %s', (_reason, url, port) => {
    expect(() => loopbackDebuggerWebSocket(url, port)).toThrow('cdp-websocket-url-not-loopback')
  })

  it('rejects malformed discovery output', () => {
    expect(() => loopbackDebuggerWebSocket(undefined, 9222)).toThrow('cdp-websocket-url-invalid')
  })
})

describe('failureClass', () => {
  it.each([
    ['daemon startup errors', 'Daemon process exited during startup: runtime error', 'session-daemon-failure'],
    ['daemon connection errors', 'Failed to connect: Connection refused', 'session-daemon-failure'],
    ['CDP connection errors', 'Failed to connect via CDP', 'cdp-connection'],
    ['CLI syntax errors', 'Unknown command: invalid', 'cli-usage-error']
  ])('maps %s to a fixed diagnostic category', (_reason, stderr, expected) => {
    expect(
      failureClass({ stdout: '', stderr, timedOut: false, failedToStart: false, cleanupComplete: true })
    ).toBe(expected)
  })
})
