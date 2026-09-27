import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  REQUIRED_TRACE_SCENARIOS,
  STATES_REQUIRING_ATTACH_PRECONDITION,
  STATES,
  classifyProcess,
  missingStates,
  oneCoreCpuPercent,
  resolveProductVersion,
  sanitizeReport,
  defaultOutputPath,
  stateRequiresAttachPrecondition,
  summarize,
  validateStatePrecondition,
  validateState
} from './lib.mjs'

const startedMs = Date.UTC(2026, 8, 27, 12)

describe('resource census state contract', () => {
  it('pins the six acceptance states in release-gate order', () => {
    expect(STATES).toEqual([
      'cold-start',
      'settled-idle',
      'first-inference',
      'active-transcription',
      'post-meeting',
      'post-recovery'
    ])
    expect(missingStates(['cold-start', 'settled-idle'])).toEqual([
      'first-inference',
      'active-transcription',
      'post-meeting',
      'post-recovery'
    ])
  })

  it('rejects unknown state names instead of silently creating non-comparable evidence', () => {
    expect(() => validateState('idle')).toThrow(/cold-start/)
  })

  it('requires attach-mode precondition evidence for every non-idle measured state', () => {
    expect(STATES_REQUIRING_ATTACH_PRECONDITION).toEqual([
      'first-inference',
      'active-transcription',
      'post-meeting',
      'post-recovery'
    ])
    expect(stateRequiresAttachPrecondition('settled-idle')).toBe(false)
    expect(stateRequiresAttachPrecondition('first-inference')).toBe(true)
    expect(() =>
      validateStatePrecondition({
        state: 'active-transcription',
        attachMode: false,
        evidence: 'fixture audio is already streaming'
      })
    ).toThrow(/requires --main-pid attach mode/)
    expect(() =>
      validateStatePrecondition({
        state: 'post-recovery',
        attachMode: true,
        evidence: ''
      })
    ).toThrow(/requires --precondition-evidence/)
    expect(
      validateStatePrecondition({
        state: 'post-meeting',
        attachMode: true,
        evidence: 'fixture meeting ended and review screen is open'
      })
    ).toEqual({
      required: true,
      attachMode: true,
      evidence: 'fixture meeting ended and review screen is open'
    })
  })
})

describe('resource census product version contract', () => {
  it('prefers an explicit product version so candidate gates are not labeled as the baseline', () => {
    expect(resolveProductVersion({ explicit: ' 2.0.0-qa.4 ', installRoot: '/missing', platform: 'darwin' })).toBe(
      '2.0.0-qa.4'
    )
  })

  it('reads the product version from an installed macOS app bundle when no CLI value is supplied', () => {
    const root = mkdtempSync(join(tmpdir(), 'metis-census-version-'))
    try {
      const app = join(root, 'Metis.app')
      const contents = join(app, 'Contents')
      mkdirSync(contents, { recursive: true })
      writeFileSync(
        join(contents, 'Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleShortVersionString</key>
  <string>1.9.6</string>
</dict>
</plist>
`,
        'utf8'
      )

      expect(resolveProductVersion({ installRoot: app, platform: 'darwin' })).toBe('1.9.6')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('resource census process classification', () => {
  it.each([
    [
      'renderer',
      { pid: 2, startedMs, role: 'Metis Helper (Renderer)', exe: '/Applications/Metis.app/Contents/Frameworks/Metis Helper (Renderer)' }
    ],
    ['gpu', { pid: 3, startedMs, role: 'Metis Helper (GPU)', commandLine: 'Metis Helper --type=gpu-process' }],
    ['crashpad', { pid: 4, startedMs, role: 'chrome_crashpad_handler', exe: '/Applications/Metis.app/Contents/Frameworks/chrome_crashpad_handler' }],
    ['llama-server', { pid: 5, startedMs, role: 'llama-server', exe: '/Applications/Metis.app/Contents/Resources/llama-server' }],
    ['fm-serve', { pid: 6, startedMs, role: 'fm', commandLine: '/usr/bin/fm serve --port 54321' }],
    ['parakeet-utility', { pid: 7, startedMs, role: 'Metis Helper (Plugin)', commandLine: 'parakeet-asr-host.js --serviceName metis-parakeet-asr-1' }],
    ['whisper-utility', { pid: 8, startedMs, role: 'Metis Helper (Plugin)', commandLine: 'whisper-asr-host.js --serviceName metis-whisper-import' }],
    ['speaker-utility', { pid: 9, startedMs, role: 'Metis Helper (Plugin)', commandLine: 'speaker-embedding-host.js --serviceName metis-speaker-embedding-1' }],
    ['main', { pid: 1, startedMs, role: 'Metis', exe: '/Applications/Metis.app/Contents/MacOS/Metis' }]
  ])('classifies %s without relying on pid alone', (expected, entry) => {
    expect(classifyProcess(entry)).toBe(expected)
  })
})

describe('resource census CPU formula', () => {
  it('uses one-core CPU percent from total observed CPU-time deltas over wall time', () => {
    const samples = [
      {
        tMs: 0,
        processes: [
          { pid: 10, startedMs: 1000, cpuSeconds: 7 },
          { pid: 11, startedMs: 1100, cpuSeconds: 1 },
          { pid: 12, startedMs: 1200, cpuSeconds: 2 }
        ]
      },
      {
        tMs: 150_000,
        processes: [
          { pid: 10, startedMs: 1000, cpuSeconds: 10 },
          { pid: 14, startedMs: 1400, cpuSeconds: 3 },
          { pid: 15, startedMs: 1500, cpuSeconds: 4 }
        ]
      },
      {
        tMs: 240_000,
        processes: [
          { pid: 10, startedMs: 1000, cpuSeconds: 12 },
          { pid: 14, startedMs: 1400, cpuSeconds: 9 }
        ]
      },
      {
        tMs: 300_000,
        processes: [
          { pid: 10, startedMs: 1000, cpuSeconds: 12 },
          { pid: 11, startedMs: 1100, cpuSeconds: 2 },
          { pid: 12, startedMs: 9999, cpuSeconds: 200 },
          { pid: 13, startedMs: 1300, cpuSeconds: 10 }
        ]
      }
    ]

    expect(oneCoreCpuPercent(samples, 300)).toBe(4)
  })

  it('summarizes GPU sampling by process identity, not by a global machine counter', () => {
    const samples = [
      {
        tMs: 0,
        processes: [
          { pid: 1, startedMs, kind: 'main', role: 'Metis', cpuSeconds: 10, rssBytes: 100 },
          { pid: 2, startedMs, kind: 'gpu', role: 'Metis Helper (GPU)', cpuSeconds: 1, rssBytes: 50 }
        ]
      },
      {
        tMs: 300_000,
        processes: [
          { pid: 1, startedMs, kind: 'main', role: 'Metis', cpuSeconds: 12, rssBytes: 120 },
          { pid: 2, startedMs, kind: 'gpu', role: 'Metis Helper (GPU)', cpuSeconds: 2, rssBytes: 60 }
        ]
      }
    ]

    expect(summarize(samples, 300)).toMatchObject({
      oneCoreCpuPercent: 1,
      processCount: 2,
      gpuSampled: true,
      gpuPids: [2],
      byKind: {
        gpu: { count: 1, rssBytes: 60 },
        main: { count: 1, rssBytes: 120 }
      }
    })
  })
})

describe('resource census report boundary', () => {
  it('keeps command lines out of the persisted report while preserving pid and start time identity', () => {
    const report = sanitizeReport({
      generatedAt: '2026-09-27T12:00:00.000Z',
      productVersion: '1.9.6',
      platform: 'darwin',
      state: 'settled-idle',
      seconds: 300,
      intervalMs: 5000,
      mainPid: 100,
      installRootKind: 'app-bundle',
      profileKind: 'representative-synthetic',
      accountingBoundary: 'test boundary',
      processIdentities: [
        { pid: 100, startedMs, role: 'Metis', kind: 'main', commandLine: 'Metis --private-value', rssBytes: 1, cpuSeconds: 0 }
      ],
      samples: [
        {
          tMs: 0,
          processes: [
            { pid: 100, startedMs, role: 'Metis', kind: 'main', commandLine: 'Metis --private-value', rssBytes: 1, cpuSeconds: 0 }
          ]
        }
      ],
      summary: { oneCoreCpuPercent: 0, processCount: 1 },
      rendererTrace: { captured: false, scenarios: [] },
      proveLocalTtft: { recorded: false },
      windowsWorkingSet: { measured: false }
    })

    expect(JSON.stringify(report)).not.toContain('private-value')
    expect(report.processIdentities[0]).toMatchObject({ pid: 100, startedMs, role: 'Metis', kind: 'main' })
  })

  it('pins the renderer trace scenarios required by the ticket', () => {
    expect(REQUIRED_TRACE_SCENARIOS).toEqual(['parked-bar-orb', 'backdrop-filter', 'threejs-obsidian-orb'])
  })

  it('keeps the reusable tool default output out of program-document paths', () => {
    const output = defaultOutputPath({ state: 'settled-idle', platform: 'darwin' })

    expect(output).toBe('metis-census-output/darwin-settled-idle.json')
    expect(output).not.toContain('docs/')
  })
})
