import { describe, expect, it } from 'vitest'
import {
  failureClass,
  electronLaunchArgs,
  loopbackDebuggerWebSocket,
  safeCommandEvidence,
  safeStartupEvidence
} from './agent-browser-smoke.mjs'

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

describe('electronLaunchArgs', () => {
  it('places loopback debugging switches before Electron’s app path', () => {
    expect(electronLaunchArgs(9222, 'C:\\worktree')).toEqual([
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=9222',
      'C:\\worktree'
    ])
  })
})

describe('failureClass', () => {
  it.each([
    ['daemon startup errors', 'Daemon process exited during startup: runtime error', 'session-daemon-failure'],
    ['daemon connection errors', 'Failed to connect: Connection refused', 'session-daemon-failure'],
    ['CDP connection errors', 'Failed to connect via CDP', 'cdp-connection'],
    ['CLI syntax errors', 'Unknown command: invalid', 'cli-usage-error']
  ])('maps %s to a fixed diagnostic category', (_reason, stderr, expected) => {
    expect(failureClass({ stdout: '', stderr, timedOut: false, failedToStart: false, cleanupComplete: true })).toBe(
      expected
    )
  })
})

describe('safeCommandEvidence', () => {
  it('keeps only fixed operation and byte-count evidence, never command output', () => {
    expect(
      safeCommandEvidence(
        {
          code: 1,
          stdout: 'private page text',
          stderr: 'browser-specific error',
          timedOut: false,
          cleanupComplete: true
        },
        ['snapshot', '-i']
      )
    ).toEqual({
      operation: 'snapshot',
      exitCode: 1,
      stdoutBytes: 17,
      stderrBytes: 22,
      diagnosticCodes: [],
      diagnosticHints: ['browser'],
      timedOut: false,
      cleanupComplete: true
    })
  })
})

describe('safeStartupEvidence', () => {
  it('reports exit state and output sizes without retaining startup text', () => {
    expect(
      safeStartupEvidence({ stdout: 'synthetic stdout', stderr: 'synthetic stderr' }, { exitCode: 1, signalCode: null })
    ).toEqual({
      exitCode: 1,
      signal: null,
      stdoutBytes: 16,
      stderrBytes: 16,
      diagnosticCodes: [],
      diagnosticHints: [],
      diagnosticTerms: [],
      diagnosticModules: [],
      diagnosticModuleKind: 'other-startup-error',
      diagnosticErrorKind: 'other-startup-error',
      diagnosticSourceFrames: []
    })
  })

  it('extracts only standard runtime error codes from startup text', () => {
    expect(
      safeStartupEvidence(
        { stdout: 'TypeError: ignored detail', stderr: 'ERR_MODULE_NOT_FOUND (os error 2)' },
        { exitCode: 1, signalCode: null }
      ).diagnosticCodes
    ).toEqual(['ERR_MODULE_NOT_FOUND', 'OS ERROR 2'])
  })

  it('reduces textual diagnostics to a fixed set of non-content hints', () => {
    expect(
      safeStartupEvidence(
        { stdout: '', stderr: 'Failed to connect to daemon via WebSocket: target closed' },
        { exitCode: 1, signalCode: null }
      ).diagnosticHints
    ).toEqual(['daemon', 'websocket', 'connection', 'page-target', 'closed'])
  })

  it('keeps only allowlisted startup terms and never emits paths or arbitrary text', () => {
    expect(
      safeStartupEvidence(
        { stdout: '', stderr: "Error: Cannot find module '/private/customer-data/secret.js'" },
        { exitCode: null, signalCode: null }
      ).diagnosticTerms
    ).toEqual(['error', 'cannot', 'find', 'module'])
  })

  it('preserves diagnostic word order while stripping startup paths', () => {
    expect(
      safeStartupEvidence(
        { stdout: '', stderr: "Error: Failed to load app at path 'C:\\private\\secret' from module 'node:electron'" },
        { exitCode: null, signalCode: null }
      ).diagnosticTerms
    ).toEqual(['error', 'failed', 'to', 'load', 'app', 'at', 'path', 'from', 'module', 'node', 'electron'])
  })

  it('limits startup terms to the pre-stack error message', () => {
    expect(
      safeStartupEvidence(
        {
          stdout: '',
          stderr: [
            'App threw an error during load',
            'Error: The specified path could not be found',
            '    at SecretModule.load'
          ].join('\n')
        },
        { exitCode: null, signalCode: null }
      ).diagnosticTerms
    ).toEqual([
      'app',
      'threw',
      'an',
      'error',
      'during',
      'load',
      'error',
      'the',
      'specified',
      'path',
      'could',
      'not',
      'be',
      'found'
    ])
  })

  it('retains safe startup operation terms without exposing path values', () => {
    expect(
      safeStartupEvidence(
        {
          stdout: '',
          stderr: [
            'App threw an error during load',
            'Error: Failed to set path to C:\\private\\secret',
            '    at SecretModule.load'
          ].join('\n')
        },
        { exitCode: null, signalCode: null }
      ).diagnosticTerms
    ).toEqual(['app', 'threw', 'an', 'error', 'during', 'load', 'error', 'failed', 'to', 'set', 'path', 'to'])
    expect(
      safeStartupEvidence(
        {
          stdout: '',
          stderr: 'Error: Failed to get path C:\\private\\secret\n    at SecretModule.load'
        },
        { exitCode: null, signalCode: null }
      ).diagnosticTerms
    ).toEqual(['error', 'failed', 'to', 'get', 'path'])
  })

  it('reports only known dependency names from the pre-stack error text', () => {
    expect(
      safeStartupEvidence(
        {
          stdout: '',
          stderr: `Error: Cannot find module '@private/fixture'; required from C:\\private\\customer\\app.js
    at Module._resolveFilename`
        },
        { exitCode: null, signalCode: null },
        ['@private/fixture', 'electron']
      ).diagnosticModules
    ).toEqual(['@private/fixture'])
  })

  it('classifies local module failures without retaining their path', () => {
    const report = safeStartupEvidence(
      { stdout: '', stderr: "Error: Cannot find module '../private/main.js'\n    at Module._resolveFilename" },
      { exitCode: null, signalCode: null }
    )
    expect(report.diagnosticModuleKind).toBe('relative-app-module')
    expect(report.diagnosticModules).toEqual([])
  })

  it('reports only worktree source and declared package frames from main-process failures', () => {
    const report = safeStartupEvidence(
      {
        stdout: '',
        stderr: [
          'App threw an error during load',
          'TypeError: synthetic startup failure',
          '    at Object.start (/safe/worktree/src/main/index.ts:1:1)',
          '    at Object.fixture (/safe/worktree/node_modules/@private/fixture/index.js:2:3)',
          '    at Object.private (/external/user/private.js:3:4)'
        ].join('\n')
      },
      { exitCode: null, signalCode: null },
      ['@private/fixture'],
      '/safe/worktree'
    )
    expect(report.diagnosticErrorKind).toBe('main-process-exception')
    expect(report.diagnosticSourceFrames).toEqual(['src/main/index.ts', '@private/fixture'])
  })
})
