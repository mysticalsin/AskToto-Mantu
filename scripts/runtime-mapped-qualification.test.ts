import { describe, expect, it } from 'vitest'
import {
  COMMON_COUNTS,
  FIFO_CASE,
  FIFO_FILE,
  NATIVE_TUPLES,
  validateCompositeEvidence,
  validateSourceReport
} from './runtime-mapped-qualification.mjs'

const sha = 'a'.repeat(40)
const digest = 'b'.repeat(64)
const nativeFile = 'src/main/llm/local-runtime.native-qualification.test.ts'
const winPipeFile = 'src/main/features/components/speech-pack/runtime-archive.windows-pipe.test.ts'
const resolverName =
  'required native local-runtime qualification performs real health, auth, inference and owned-child shutdown through production resolver'
const cpuName =
  'required native local-runtime qualification performs real health, auth, inference and owned-child shutdown with explicit CPU binary'
const pipeName =
  'Windows runtime archive named-pipe refusal proves a real blocking pipe read, then rejects the held pipe before payload reads'

function sourceFixture(lane: 'linux' | 'windows' | 'macos') {
  const entries = [...COMMON_COUNTS]
  if (lane !== 'windows') entries.push([FIFO_FILE, 1])
  const testResults = entries.map(([name, count]) => ({
    name,
    status: 'passed',
    assertionResults: Array.from({ length: count }, (_, index) => ({
      fullName: name === FIFO_FILE ? FIFO_CASE : `${name} assertion ${index + 1}`,
      status: 'passed'
    }))
  }))
  const total = entries.reduce((sum, [, count]) => sum + count, 0)
  return {
    success: true,
    numTotalTests: total,
    numPassedTests: total,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTestSuites: testResults.length * 2,
    numPassedTestSuites: testResults.length * 2,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    unhandledErrors: [],
    testResults
  }
}
function sourceContext(lane: 'linux' | 'windows' | 'macos') {
  return {
    sourceSha: sha,
    actualHead: sha,
    runId: '38670000000',
    attempt: 1,
    lane,
    platform: lane === 'windows' ? 'win32' : lane === 'macos' ? 'darwin' : 'linux',
    arch: lane === 'macos' ? 'arm64' : 'x64',
    expectedArch: lane === 'macos' ? 'arm64' : 'x64',
    testStepOutcome: 'success',
    processExit: 0,
    checkoutRoot: lane === 'windows' ? 'C:\\agent\\_work\\repo' : '/agent/_work/repo',
    pathFlavor: lane === 'windows' ? 'win32' : 'posix',
    rawReportSha256: digest,
    rawLogSha256: 'c'.repeat(64)
  }
}
function source(lane: 'linux' | 'windows' | 'macos') {
  return validateSourceReport(sourceFixture(lane), sourceContext(lane))
}
function nativeFixture(platform: 'darwin' | 'win32', arch: 'arm64' | 'x64') {
  const windows = platform === 'win32'
  const cases = windows
    ? [
        { file: nativeFile, fullName: resolverName, status: 'passed' },
        { file: nativeFile, fullName: cpuName, status: 'passed' },
        { file: winPipeFile, fullName: pipeName, status: 'passed' }
      ]
    : [{ file: nativeFile, fullName: resolverName, status: 'passed' }]
  const nativeCases = windows
    ? [
        {
          caseId: 'native-resolver',
          platform,
          arch,
          testFullName: resolverName,
          selection: 'production-resolver',
          variant: 'cpu',
          gpuQualification: 'NOT_QUALIFIED',
          inference: 'NONEMPTY',
          macSupervision: 'NOT_APPLICABLE'
        },
        {
          caseId: 'native-explicit-cpu',
          platform,
          arch,
          testFullName: cpuName,
          selection: 'explicit-cpu',
          variant: 'cpu',
          gpuQualification: 'NOT_QUALIFIED',
          inference: 'NONEMPTY',
          macSupervision: 'NOT_APPLICABLE'
        }
      ]
    : [
        {
          caseId: 'native-resolver',
          platform,
          arch,
          testFullName: resolverName,
          selection: 'production-resolver',
          variant: 'mac',
          gpuQualification: 'NOT_QUALIFIED',
          inference: 'NONEMPTY',
          macSupervision: 'DIRECT_FALLBACK_NOT_HELPER_QUALIFIED'
        }
      ]
  const count = cases.length
  return {
    schema: 1,
    status: 'PASS',
    sourceSha: sha,
    runId: '38670000000',
    attempt: 1,
    platform,
    arch,
    nativeTestStepOutcome: 'success',
    macSupervision: platform === 'darwin' ? 'DIRECT_FALLBACK_NOT_HELPER_QUALIFIED' : 'NOT_APPLICABLE',
    windowsRuntimeVariant: windows ? 'PRODUCTION_RESOLVER_AND_EXPLICIT_CPU_OBSERVED' : 'NOT_APPLICABLE',
    windowsGpuQualification: windows ? 'NOT_QUALIFIED_NO_GPU_HARDWARE_CLAIM' : 'NOT_APPLICABLE',
    tests: {
      total: count,
      passed: count,
      failed: 0,
      pending: 0,
      todo: 0,
      files: windows ? [nativeFile, winPipeFile] : [nativeFile],
      cases
    },
    nativeCases,
    inputEvidenceSha256: digest,
    testReportSha256: digest,
    nativeCasesSha256: digest,
    runtimeInventories: [{ archive: 'fixture' }],
    inputs: [{ path: 'fixture', bytes: 1, sha256: digest }]
  }
}
function compositeFixture() {
  const sources = (['linux', 'windows', 'macos'] as const).map((lane) => ({
    evidence: source(lane),
    rawReportSha256: digest,
    rawLogSha256: 'c'.repeat(64)
  }))
  const natives = NATIVE_TUPLES.map(([platform, arch]) => ({
    evidence: nativeFixture(platform as 'darwin' | 'win32', arch as 'arm64' | 'x64'),
    rawReportSha256: digest,
    rawInputSha256: digest,
    rawCasesSha256: digest,
    rawLogSha256: 'd'.repeat(64)
  }))
  return { sources, natives }
}
const compositeContext = { sourceSha: sha, runId: '38670000000', attempt: 1 }

const sourceNegatives: Array<[string, (report: any, context: any) => void, string]> = [
  [
    'failed test process',
    (_r, c) => {
      c.processExit = 1
    },
    'SOURCE_TEST_EXECUTION_FAILED'
  ],
  [
    'missing process exit',
    (_r, c) => {
      delete c.processExit
    },
    'SOURCE_TEST_EXECUTION_FAILED'
  ],
  [
    'missing process outcome',
    (_r, c) => {
      delete c.testStepOutcome
    },
    'SOURCE_TEST_EXECUTION_FAILED'
  ],
  [
    'wrong source SHA',
    (_r, c) => {
      c.sourceSha = 'f'.repeat(40)
    },
    'SOURCE_HEAD_MISMATCH'
  ],
  [
    'wrong checkout HEAD',
    (_r, c) => {
      c.actualHead = 'f'.repeat(40)
    },
    'SOURCE_HEAD_MISMATCH'
  ],
  [
    'malformed run ID',
    (_r, c) => {
      c.runId = 'run-123'
    },
    'SOURCE_RUN_ID_MISSING_OR_MALFORMED'
  ],
  [
    'wrong host platform',
    (_r, c) => {
      c.platform = 'darwin'
    },
    'SOURCE_HOST_MISMATCH'
  ],
  [
    'wrong host architecture',
    (_r, c) => {
      c.arch = 'arm64'
    },
    'SOURCE_ARCH_MISMATCH'
  ],
  ['missing report', () => {}, 'SOURCE_REPORT_MALFORMED'],
  [
    'failed counter',
    (r) => {
      r.numFailedTests = 1
    },
    'SOURCE_TEST_COUNTER_MISMATCH'
  ],
  [
    'unsuccessful report flag',
    (r) => {
      r.success = false
    },
    'SOURCE_REPORT_UNSUCCESSFUL'
  ],
  [
    'pending counter',
    (r) => {
      r.numPendingTests = 1
    },
    'SOURCE_TEST_COUNTER_MISMATCH'
  ],
  [
    'todo counter',
    (r) => {
      r.numTodoTests = 1
    },
    'SOURCE_TEST_COUNTER_MISMATCH'
  ],
  [
    'unhandled error',
    (r) => {
      r.unhandledErrors = [{ message: 'unhandled' }]
    },
    'SOURCE_UNHANDLED_ERRORS'
  ],
  [
    'failed case',
    (r) => {
      r.testResults[0].assertionResults[0].status = 'failed'
    },
    'SOURCE_CASE_DID_NOT_PASS'
  ],
  [
    'pending case',
    (r) => {
      r.testResults[0].assertionResults[0].status = 'pending'
    },
    'SOURCE_CASE_DID_NOT_PASS'
  ],
  [
    'todo case',
    (r) => {
      r.testResults[0].assertionResults[0].status = 'todo'
    },
    'SOURCE_CASE_DID_NOT_PASS'
  ],
  [
    'duplicate file',
    (r) => {
      r.testResults[1].name = r.testResults[0].name
    },
    'SOURCE_UNKNOWN_OR_DUPLICATE_FILE'
  ],
  [
    'extra file',
    (r) => {
      r.testResults[0].name = 'src/main/extra.test.ts'
    },
    'SOURCE_UNKNOWN_OR_DUPLICATE_FILE'
  ],
  [
    'missing file',
    (r) => {
      r.testResults.pop()
    },
    'SOURCE_FILE_INVENTORY_COUNT_MISMATCH'
  ],
  [
    'same-total wrong per-file distribution',
    (r) => {
      r.testResults[0].assertionResults.pop()
      r.testResults[1].assertionResults.push({ fullName: 'extra transfer', status: 'passed' })
    },
    'SOURCE_PER_FILE_COUNT_MISMATCH'
  ],
  [
    'escaping report path',
    (r) => {
      r.testResults[0].name = '../outside.test.ts'
    },
    'SOURCE_PATH_ESCAPES_CHECKOUT'
  ],
  [
    'duplicate fullName',
    (r) => {
      r.testResults[0].assertionResults[1].fullName = r.testResults[0].assertionResults[0].fullName
    },
    'SOURCE_CASE_NAME_DUPLICATE'
  ],
  [
    'malformed fullName',
    (r) => {
      r.testResults[0].assertionResults[0].fullName = ''
    },
    'SOURCE_CASE_NAME_MALFORMED'
  ],
  [
    'missing POSIX FIFO',
    (r) => {
      r.testResults.pop()
    },
    'SOURCE_FILE_INVENTORY_COUNT_MISMATCH'
  ],
  [
    'substituted POSIX FIFO title',
    (r) => {
      r.testResults.at(-1).assertionResults[0].fullName = 'fake fifo test'
    },
    'SOURCE_FIFO_ROSTER_MISMATCH'
  ],
  [
    'FIFO incorrectly on Windows',
    (r) => {
      r.testResults.push({
        name: FIFO_FILE,
        status: 'passed',
        assertionResults: [{ fullName: FIFO_CASE, status: 'passed' }]
      })
      r.numTotalTests++
      r.numPassedTests++
    },
    'SOURCE_TEST_COUNTER_MISMATCH'
  ]
]

describe('runtime mapped qualification source validator', () => {
  it('accepts the Windows 20-file / 312-case source roster', () => {
    const evidence = validateSourceReport(sourceFixture('windows'), sourceContext('windows'))
    expect(evidence.tests).toMatchObject({ total: 312, passed: 312, failed: 0, pending: 0, todo: 0 })
    expect(evidence.tests.files).toHaveLength(20)
  })
  it('accepts POSIX only with the exact registered FIFO witness', () => {
    const evidence = validateSourceReport(sourceFixture('linux'), sourceContext('linux'))
    expect(evidence.tests).toMatchObject({ total: 313, passed: 313 })
    expect(evidence.tests.cases.filter((test) => test.file === FIFO_FILE)).toEqual([
      { file: FIFO_FILE, fullName: FIFO_CASE, status: 'passed' }
    ])
  })
  it.each(sourceNegatives)('rejects %s', (name, mutate, code) => {
    const lane =
      name === 'FIFO incorrectly on Windows'
        ? 'windows'
        : name.includes('FIFO') || name.includes('POSIX')
          ? 'linux'
          : 'windows'
    const report = structuredClone(sourceFixture(lane))
    const context = { ...sourceContext(lane) }
    if (name === 'missing report') {
      expect(() => validateSourceReport(undefined, context)).toThrow(code)
      return
    }
    mutate(report, context)
    expect(() => validateSourceReport(report, context)).toThrow(code)
  })
})

describe('runtime mapped qualification composite validator', () => {
  it('accepts six exact source/native lanes with mapped common cases and platform witnesses', () => {
    const result = validateCompositeEvidence(compositeFixture(), compositeContext)
    expect(result.status).toBe('RUNTIME_MAPPED_COMPOSITE_PASS')
    expect(result.mappedCounts).toEqual({
      commonFiles: 20,
      commonCases: 312,
      linuxSourceCases: 313,
      macosSourceCases: 313,
      macosNativeCasesPerArchitecture: 1,
      macosLogicalMappedCasesPerArchitecture: 314,
      windowsSourceCases: 312,
      windowsNativeCases: 3,
      windowsLogicalMappedCases: 315,
      posixFifoCasesPerPosixLane: 1,
      nativeMacCasesPerArchitecture: 1,
      nativeWindowsCases: 3
    })
  })
  it.each([
    [
      'missing native lane',
      (e: any) => {
        e.natives.pop()
      },
      'COMPOSITE_NATIVE_BUNDLE_COUNT_MISMATCH'
    ],
    [
      'failed native lane',
      (e: any) => {
        e.natives[0].evidence.status = 'FAIL'
      },
      'COMPOSITE_NATIVE_BINDING_MISMATCH'
    ],
    [
      'skipped native execution',
      (e: any) => {
        e.natives[0].evidence.nativeTestStepOutcome = 'skipped'
      },
      'COMPOSITE_NATIVE_EXECUTION_MISMATCH'
    ],
    [
      'cancelled native execution',
      (e: any) => {
        e.natives[0].evidence.nativeTestStepOutcome = 'cancelled'
      },
      'COMPOSITE_NATIVE_EXECUTION_MISMATCH'
    ],
    [
      'wrong SHA',
      (e: any) => {
        e.natives[0].evidence.sourceSha = 'e'.repeat(40)
      },
      'COMPOSITE_NATIVE_BINDING_MISMATCH'
    ],
    [
      'wrong run',
      (e: any) => {
        e.natives[0].evidence.runId = '99999999999'
      },
      'COMPOSITE_NATIVE_BINDING_MISMATCH'
    ],
    [
      'wrong attempt',
      (e: any) => {
        e.natives[0].evidence.attempt = 2
      },
      'COMPOSITE_NATIVE_BINDING_MISMATCH'
    ],
    [
      'wrong architecture',
      (e: any) => {
        e.natives[0].evidence.arch = 'arm32'
      },
      'COMPOSITE_NATIVE_LANE_DUPLICATE_OR_UNKNOWN'
    ],
    [
      'duplicate native lane',
      (e: any) => {
        e.natives[1].evidence.platform = e.natives[0].evidence.platform
        e.natives[1].evidence.arch = e.natives[0].evidence.arch
      },
      'COMPOSITE_NATIVE_LANE_DUPLICATE_OR_UNKNOWN'
    ],
    [
      'altered raw report digest',
      (e: any) => {
        e.natives[0].rawReportSha256 = 'f'.repeat(64)
      },
      'COMPOSITE_NATIVE_DIGEST_MISMATCH'
    ],
    [
      'Windows missing explicit CPU case',
      (e: any) => {
        e.natives[2].evidence.tests.cases[1].fullName = 'substituted Windows native case'
      },
      'COMPOSITE_WINDOWS_CPU_CASE_MISSING'
    ],
    [
      'Windows missing pipe case',
      (e: any) => {
        e.natives[2].evidence.tests.cases[2].fullName = 'substituted Windows pipe case'
      },
      'COMPOSITE_WINDOWS_PIPE_CASE_MISSING'
    ],
    [
      'native zero tests',
      (e: any) => {
        e.natives[0].evidence.tests.total = 0
        e.natives[0].evidence.tests.passed = 0
      },
      'COMPOSITE_NATIVE_COUNT_MISMATCH'
    ],
    [
      'weakened GPU classification',
      (e: any) => {
        e.natives[2].evidence.nativeCases[0].gpuQualification = 'QUALIFIED'
      },
      'COMPOSITE_NATIVE_WITNESS_MISMATCH'
    ],
    [
      'mismatched common roster',
      (e: any) => {
        e.sources[1].evidence.tests.cases[0].fullName = 'substituted common assertion'
      },
      'COMPOSITE_COMMON_ROSTER_MISMATCH'
    ],
    [
      'Windows FIFO false registration',
      (e: any) => {
        e.sources[1].evidence.tests.files.push(FIFO_FILE)
        e.sources[1].evidence.tests.total++
        e.sources[1].evidence.tests.passed++
      },
      'COMPOSITE_SOURCE_COUNT_MISMATCH'
    ],
    [
      'failed source lane despite evidence',
      (e: any) => {
        e.sources[0].evidence.processExit = 1
      },
      'COMPOSITE_SOURCE_EXECUTION_MISMATCH'
    ],
    [
      'altered source digest',
      (e: any) => {
        e.sources[0].rawLogSha256 = 'f'.repeat(64)
      },
      'COMPOSITE_SOURCE_RAW_DIGEST_MISMATCH'
    ]
  ])('rejects %s', (_name, mutate, code) => {
    const evidence = compositeFixture()
    mutate(evidence)
    expect(() => validateCompositeEvidence(evidence, compositeContext)).toThrow(code)
  })
})
