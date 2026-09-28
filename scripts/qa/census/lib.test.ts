import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ATTRIBUTABLE_PROCESS_KINDS,
  REQUIRED_TRACE_SCENARIOS,
  STATES_REQUIRING_ATTACH_PRECONDITION,
  STATES,
  classifyProcess,
  collectCensus,
  missingStates,
  oneCoreCpuPercent,
  parseProveLocalTtftOutput,
  proveLocalTtftEvidenceFromArtifact,
  rendererScenarioProbeSource,
  resolveProductVersion,
  sanitizeReport,
  defaultOutputPath,
  stateCoverageForRun,
  stateRequiresAttachPrecondition,
  summarize,
  validateStatePrecondition,
  validateState,
  windowsWorkingSetEvidenceFromArtifact
} from './lib.mjs'
import { representativeSettings, writeRepresentativeProfile } from './profile.mjs'

const startedMs = Date.UTC(2026, 8, 27, 12)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

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
  it('declares every attributable process kind the release gate compares by pid and start time', () => {
    expect(ATTRIBUTABLE_PROCESS_KINDS).toEqual([
      'main',
      'renderer',
      'gpu',
      'parakeet-utility',
      'whisper-utility',
      'speaker-utility',
      'llama-server',
      'fm-serve',
      'crashpad'
    ])
  })

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

  it('takes a terminal sample at the requested wall boundary before computing one-core CPU percent', async () => {
    let clockMs = 0
    const report = await collectCensus({
      state: 'settled-idle',
      seconds: 300,
      intervalMs: 120_000,
      platform: 'darwin',
      installRoot: '/Applications/Metis.app',
      mainPid: 100,
      productVersion: '1.9.6',
      listProcesses: () => [
        {
          pid: 100,
          ppid: 1,
          startedMs,
          exe: '/Applications/Metis.app/Contents/MacOS/Metis',
          role: 'Metis'
        }
      ],
      sampleOwnedProcesses: () => [
        {
          pid: 100,
          startedMs,
          role: 'Metis',
          kind: 'main',
          rssBytes: 100,
          physFootprintBytes: 80,
          workingSetBytes: null,
          cpuSeconds: clockMs / 1000
        }
      ],
      now: () => clockMs,
      sleep: async (ms: number) => {
        clockMs += ms
      }
    })

    expect(report.samples.map((sample: { tMs: number }) => sample.tMs)).toEqual([0, 120_000, 240_000, 300_000])
    expect(report.summary.oneCoreCpuPercent).toBe(100)
  })

  it('rejects an otherwise successful-looking census when the main process identity is absent', async () => {
    let clockMs = 0
    await expect(
      collectCensus({
        state: 'settled-idle',
        seconds: 0.001,
        intervalMs: 5,
        platform: 'darwin',
        installRoot: '/Applications/Metis.app',
        mainPid: 100,
        productVersion: '1.9.6',
        listProcesses: () => [
          {
            pid: 200,
            ppid: 1,
            startedMs,
            exe: '/Applications/Metis.app/Contents/Frameworks/Metis Helper (Renderer)',
            role: 'Metis Helper (Renderer)'
          }
        ],
        sampleOwnedProcesses: () => [
          {
            pid: 200,
            startedMs,
            role: 'Metis Helper (Renderer)',
            kind: 'renderer',
            rssBytes: 100,
            physFootprintBytes: 80,
            workingSetBytes: null,
            cpuSeconds: 0
          }
        ],
        now: () => clockMs,
        sleep: async (ms: number) => {
          clockMs += ms
        }
      })
    ).rejects.toThrow(/main process identity/)
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

  it('marks Windows working-set evidence from the census samples themselves', async () => {
    let clockMs = 0
    const report = await collectCensus({
      state: 'settled-idle',
      seconds: 1,
      intervalMs: 1,
      platform: 'win32',
      installRoot: 'C:\\Metis',
      mainPid: 100,
      productVersion: '1.9.6',
      listProcesses: () => [
        {
          pid: 100,
          ppid: 1,
          startedMs,
          exe: 'C:\\Metis\\Metis.exe',
          role: 'Metis.exe'
        }
      ],
      sampleOwnedProcesses: () => [
        {
          pid: 100,
          startedMs,
          role: 'Metis.exe',
          kind: 'main',
          rssBytes: 123,
          physFootprintBytes: null,
          workingSetBytes: 123,
          cpuSeconds: clockMs / 1000
        }
      ],
      now: () => clockMs,
      sleep: async (ms: number) => {
        clockMs += ms
      }
    })

    expect(report.windowsWorkingSet).toEqual({
      measured: true,
      metric: 'Win32_Process.WorkingSetSize',
      lane: 'windows-qa'
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
    expect(report).toMatchObject({
      evidenceLevel: 'MEASURED',
      attributableProcessKinds: ATTRIBUTABLE_PROCESS_KINDS
    })
  })

  it('records an explicit state-coverage boundary instead of faking states that need a live precondition', () => {
    expect(stateCoverageForRun('settled-idle')).toEqual([
      { state: 'cold-start', status: 'SUPPORTED_NOT_RUN', unblockStep: 'Run node scripts/qa/census/run.mjs --state cold-start --seconds 300.' },
      { state: 'settled-idle', status: 'MEASURED' },
      {
        state: 'first-inference',
        status: 'BLOCKED_EXTERNAL',
        unblockStep:
          'Start the packaged app on the representative QA profile, establish first-inference, then rerun with --main-pid, --install-root, and --precondition-evidence.'
      },
      {
        state: 'active-transcription',
        status: 'BLOCKED_EXTERNAL',
        unblockStep:
          'Start the packaged app on the representative QA profile, establish active-transcription, then rerun with --main-pid, --install-root, and --precondition-evidence.'
      },
      {
        state: 'post-meeting',
        status: 'BLOCKED_EXTERNAL',
        unblockStep:
          'Start the packaged app on the representative QA profile, establish post-meeting, then rerun with --main-pid, --install-root, and --precondition-evidence.'
      },
      {
        state: 'post-recovery',
        status: 'BLOCKED_EXTERNAL',
        unblockStep:
          'Start the packaged app on the representative QA profile, establish post-recovery, then rerun with --main-pid, --install-root, and --precondition-evidence.'
      }
    ])
  })

  it('pins the renderer trace scenarios required by the ticket', () => {
    expect(REQUIRED_TRACE_SCENARIOS).toEqual(['parked-bar-orb', 'backdrop-filter', 'threejs-obsidian-orb'])
  })

  it('emits renderer probes that check the actual requested UI state before tracing', () => {
    expect(rendererScenarioProbeSource('parked-bar-orb')).toContain('[data-bar-pill-orb]')
    expect(rendererScenarioProbeSource('backdrop-filter')).toContain('backdropFilter')
    expect(rendererScenarioProbeSource('threejs-obsidian-orb')).toContain('[data-orb-style="obsidian"] canvas')
    expect(() => rendererScenarioProbeSource('caller-supplied-label')).toThrow(/unknown trace scenario/)
  })

  it('keeps the reusable tool default output out of program-document paths', () => {
    const output = defaultOutputPath({ state: 'settled-idle', platform: 'darwin' })

    expect(output).toBe('metis-census-output/darwin-settled-idle.json')
    expect(output).not.toContain('docs/')
  })
})

describe('resource census external proof artifacts', () => {
  it('extracts TTFT only from the prove-local-ttft output shape', () => {
    const output = `=== prove-local-ttft: Métis Local warm-suggest TTFT proof (PLAN.md §4.4 / Rock 5) ===
[prove-local-ttft] model files verified (sha256 match).
warm TTFT: 842 ms
`
    expect(parseProveLocalTtftOutput(output)).toBe(842)
    expect(() => parseProveLocalTtftOutput('warm TTFT: 842 ms')).toThrow(/not output/)
    expect(() =>
      parseProveLocalTtftOutput(`=== prove-local-ttft: Métis Local warm-suggest TTFT proof (PLAN.md §4.4 / Rock 5) ===
[prove-local-ttft] FAIL — warm TTFT 2000ms exceeds the 1500ms budget.
warm TTFT: 2000 ms`)
    ).toThrow(/failed/)
  })

  it('records TTFT with a checkable artifact path and sha256, not a caller-supplied number', () => {
    const root = mkdtempSync(join(tmpdir(), 'metis-census-ttft-'))
    try {
      mkdirSync(join(root, 'metis-census-output'), { recursive: true })
      writeFileSync(
        join(root, 'metis-census-output', 'prove-local-ttft.log'),
        `=== prove-local-ttft: Métis Local warm-suggest TTFT proof (PLAN.md §4.4 / Rock 5) ===
warm TTFT: 731 ms
`,
        'utf8'
      )

      const evidence = proveLocalTtftEvidenceFromArtifact('metis-census-output/prove-local-ttft.log', { cwd: root })

      expect(evidence).toMatchObject({
        recorded: true,
        command: 'node scripts/prove-local-ttft.mjs',
        warmTtftMs: 731,
        artifact: { path: 'metis-census-output/prove-local-ttft.log' }
      })
      expect(evidence.artifact.sha256).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not mark Windows working set measured without a Windows lane artifact containing workingSetBytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'metis-census-winws-'))
    try {
      mkdirSync(join(root, 'metis-census-output'), { recursive: true })
      writeFileSync(
        join(root, 'metis-census-output', 'win32-settled-idle.json'),
        JSON.stringify({
          platform: 'win32',
          samples: [{ processes: [{ pid: 44, startedMs, workingSetBytes: 123456 }] }]
        }),
        'utf8'
      )
      writeFileSync(
        join(root, 'metis-census-output', 'darwin-settled-idle.json'),
        JSON.stringify({ platform: 'darwin', samples: [{ processes: [{ pid: 44, startedMs, workingSetBytes: null }] }] }),
        'utf8'
      )

      const evidence = windowsWorkingSetEvidenceFromArtifact('metis-census-output/win32-settled-idle.json', { cwd: root })

      expect(evidence).toMatchObject({
        measured: true,
        metric: 'Win32_Process.WorkingSetSize',
        lane: 'windows-qa',
        artifact: { path: 'metis-census-output/win32-settled-idle.json' }
      })
      expect(() =>
        windowsWorkingSetEvidenceFromArtifact('metis-census-output/darwin-settled-idle.json', { cwd: root })
      ).toThrow(/platform "win32"/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('resource census representative profile', () => {
  it('arms the local synthetic profile so the baseline is not a fresh-profile census', () => {
    const settings = representativeSettings('/tmp/metis-census-profile', 1)

    expect(settings).toMatchObject({
      onboardingDone: true,
      recordingConsent: true,
      autoSaveTranscripts: true,
      overlayLayout: 'bar',
      overlayOrbStyle: 'obsidian',
      routingMode: 'local',
      localLlm: {
        enabled: true,
        modelId: 'qwen3.5-0.8b',
        useFor: { suggest: true, summary: true, vision: true },
        fallback: true
      }
    })
    expect(settings.meetingsFolder).toBe('/tmp/metis-census-profile/meetings')
  })

  it('writes only a disposable profile and meetings folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'metis-census-profile-'))
    try {
      const profile = writeRepresentativeProfile(root, 1)
      const persisted = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'))

      expect(profile.profileDir).toBe(root)
      expect(persisted.meetingsFolder).toBe(join(root, 'meetings'))
      expect(persisted.localLlm.enabled).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('resource census GitHub Actions lane', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/resource-census.yml'), 'utf8')

  it('runs only on workflow_dispatch and never edits release publication triggers', () => {
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).not.toContain('push:')
    expect(workflow).not.toContain('release:')
  })

  it('runs the reusable census tool on hosted macOS and Windows with artifact upload', () => {
    expect(workflow).toContain('runs-on: macos-latest')
    expect(workflow).toContain('runs-on: windows-latest')
    expect(workflow).toContain('node scripts/qa/census/run.mjs')
    expect(workflow).toContain('--state settled-idle')
    expect(workflow).toContain('--seconds 300')
    expect(workflow).toContain('node scripts/prove-local-ttft.mjs')
    expect(workflow).toContain('actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2')
  })
})
