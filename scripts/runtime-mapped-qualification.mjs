#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve, posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

export const INVENTORY_VERSION = 'runtime-mapped-source-v1'
export const COMMON_COUNTS = new Map([
  ['scripts/check-architecture.test.ts', 31],
  ['scripts/design/design-capture.test.ts', 19],
  ['src/main/features/components/speech-pack/download.test.ts', 35],
  ['src/main/features/components/speech-pack/runtime-admission.test.ts', 4],
  ['src/main/features/components/speech-pack/runtime-archive.test.ts', 2],
  ['src/main/features/components/speech-pack/runtime-lease.test.ts', 14],
  ['src/main/features/components/speech-pack/runtime-resource-protocol.test.ts', 3],
  ['src/main/features/components/speech-pack/runtime-staged-verifier.test.ts', 5],
  ['src/main/features/components/speech-pack/runtime-tar.test.ts', 3],
  ['src/main/features/components/speech-pack/runtime-trust.test.ts', 3],
  ['src/main/infra/process/supervisor.test.ts', 19],
  ['src/main/infra/storage/runtime-owned-files.test.ts', 4],
  ['src/main/llm/local-runtime.concurrency.test.ts', 17],
  ['src/main/llm/local-runtime.test.ts', 23],
  ['src/main/parakeet-client.test.ts', 24],
  ['src/main/speaker-embedding-client.test.ts', 13],
  ['src/main/whisper-import.test.ts', 41],
  ['src/main/speaker-session-wiring.test.ts', 23],
  ['src/main/asr-bundled-ensure.test.ts', 19],
  ['src/main/asr-model-manifest.test.ts', 10]
])
export const FIFO_FILE = 'src/main/features/components/speech-pack/runtime-archive.posix-fifo.test.ts'
export const FIFO_CASE =
  'runtime archive held-descriptor hashing opens a raced-in FIFO without blocking before rejecting its type'
export const NATIVE_TUPLES = [
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['win32', 'x64']
]
const commonTotal = [...COMMON_COUNTS.values()].reduce((a, b) => a + b, 0)
const digestPattern = /^[0-9a-f]{64}$/

function demand(condition, message) {
  if (!condition) throw new Error(message)
}
function hash(value) {
  return typeof value === 'string' && digestPattern.test(value)
}
function integer(value) {
  return Number.isSafeInteger(value) && value >= 0
}
function normalizeReportPath(value, context) {
  demand(typeof value === 'string' && value.length > 0, 'SOURCE_PATH_EMPTY_OR_MALFORMED')
  const paths = context.pathFlavor === 'win32' ? win32 : posix
  const root = paths.resolve(context.checkoutRoot)
  const absolute = paths.isAbsolute(value) ? paths.resolve(value) : paths.resolve(root, value)
  const local = paths.relative(root, absolute)
  demand(
    local && local !== '..' && !local.startsWith(`..${paths.sep}`) && !paths.isAbsolute(local),
    'SOURCE_PATH_ESCAPES_CHECKOUT'
  )
  return local.split(paths.sep).join('/')
}

export function validateSourceReport(report, context) {
  demand(report && typeof report === 'object', 'SOURCE_REPORT_MALFORMED')
  const {
    sourceSha,
    actualHead,
    runId,
    attempt,
    lane,
    platform,
    arch,
    expectedArch,
    testStepOutcome,
    processExit,
    checkoutRoot
  } = context ?? {}
  demand(typeof sourceSha === 'string' && /^[0-9a-f]{40}$/.test(sourceSha), 'SOURCE_SHA_MISSING_OR_MALFORMED')
  demand(actualHead === sourceSha, 'SOURCE_HEAD_MISMATCH')
  demand(typeof runId === 'string' && /^\d+$/.test(runId), 'SOURCE_RUN_ID_MISSING_OR_MALFORMED')
  demand(integer(attempt) && attempt > 0, 'SOURCE_ATTEMPT_MISSING_OR_MALFORMED')
  const expectedHost = lane === 'linux' ? 'linux' : lane === 'windows' ? 'win32' : lane === 'macos' ? 'darwin' : null
  demand(expectedHost && platform === expectedHost, 'SOURCE_HOST_MISMATCH')
  demand(typeof arch === 'string' && ['arm64', 'x64'].includes(arch), 'SOURCE_ARCH_MALFORMED')
  demand(arch === expectedArch, 'SOURCE_ARCH_MISMATCH')
  demand(typeof checkoutRoot === 'string' && checkoutRoot.length > 0, 'SOURCE_CHECKOUT_ROOT_MISSING')
  demand(testStepOutcome === 'success' && processExit === 0, 'SOURCE_TEST_EXECUTION_FAILED')
  const posixLane = lane !== 'windows'
  const expected = new Map(COMMON_COUNTS)
  if (posixLane) expected.set(FIFO_FILE, 1)
  const expectedTotal = commonTotal + (posixLane ? 1 : 0)
  const counterKeys = [
    'numTotalTests',
    'numPassedTests',
    'numFailedTests',
    'numPendingTests',
    'numTodoTests',
    'numTotalTestSuites',
    'numPassedTestSuites',
    'numFailedTestSuites',
    'numPendingTestSuites'
  ]
  demand(
    counterKeys.every((key) => integer(report[key])),
    'SOURCE_COUNTERS_MALFORMED'
  )
  demand(report.success === true, 'SOURCE_REPORT_UNSUCCESSFUL')
  demand(
    report.numTotalTests === expectedTotal &&
      report.numPassedTests === expectedTotal &&
      report.numFailedTests === 0 &&
      report.numPendingTests === 0 &&
      report.numTodoTests === 0,
    'SOURCE_TEST_COUNTER_MISMATCH'
  )
  demand(
    report.numTotalTestSuites > 0 &&
      report.numPassedTestSuites === report.numTotalTestSuites &&
      report.numFailedTestSuites === 0 &&
      report.numPendingTestSuites === 0,
    'SOURCE_RECURSIVE_SUITE_COUNTER_MISMATCH'
  )
  demand(
    report.unhandledErrors === undefined ||
      (Array.isArray(report.unhandledErrors) && report.unhandledErrors.length === 0),
    'SOURCE_UNHANDLED_ERRORS'
  )
  demand(
    Array.isArray(report.testResults) && report.testResults.length === expected.size,
    'SOURCE_FILE_INVENTORY_COUNT_MISMATCH'
  )
  const seen = new Set()
  const cases = []
  for (const suite of report.testResults) {
    const file = normalizeReportPath(suite?.name, context)
    demand(expected.has(file) && !seen.has(file), 'SOURCE_UNKNOWN_OR_DUPLICATE_FILE')
    seen.add(file)
    demand(suite.status === 'passed' && Array.isArray(suite.assertionResults), 'SOURCE_FILE_DID_NOT_PASS')
    const requiredCount = expected.get(file)
    demand(suite.assertionResults.length === requiredCount, 'SOURCE_PER_FILE_COUNT_MISMATCH')
    const names = suite.assertionResults.map((entry) => entry?.fullName)
    demand(
      names.every((name) => typeof name === 'string' && name.trim().length > 0),
      'SOURCE_CASE_NAME_MALFORMED'
    )
    demand(new Set(names).size === names.length, 'SOURCE_CASE_NAME_DUPLICATE')
    demand(
      suite.assertionResults.every((entry) => entry.status === 'passed'),
      'SOURCE_CASE_DID_NOT_PASS'
    )
    if (file === FIFO_FILE) demand(names.length === 1 && names[0] === FIFO_CASE, 'SOURCE_FIFO_ROSTER_MISMATCH')
    for (const fullName of names) cases.push({ file, fullName, status: 'passed' })
  }
  demand(seen.size === expected.size, 'SOURCE_REQUIRED_FILE_MISSING')
  demand(cases.length === expectedTotal, 'SOURCE_CASE_ROSTER_COUNT_MISMATCH')
  demand(hash(context.rawReportSha256) && hash(context.rawLogSha256), 'SOURCE_RAW_DIGEST_MISSING')
  return {
    schema: 1,
    status: 'PASS',
    sourceSha,
    runId,
    attempt,
    lane,
    platform,
    arch,
    testStepOutcome,
    processExit,
    inventoryVersion: INVENTORY_VERSION,
    inventorySha256: createHash('sha256')
      .update(JSON.stringify([...expected]))
      .digest('hex'),
    tests: {
      total: expectedTotal,
      passed: expectedTotal,
      failed: 0,
      pending: 0,
      todo: 0,
      files: [...expected.keys()],
      cases
    },
    rawReportSha256: context.rawReportSha256,
    rawLogSha256: context.rawLogSha256,
    recursiveSuites: {
      total: report.numTotalTestSuites,
      passed: report.numPassedTestSuites,
      failed: report.numFailedTestSuites,
      pending: report.numPendingTestSuites
    }
  }
}

const nativeExpected = new Map([
  [
    'darwin/arm64',
    {
      platform: 'darwin',
      arch: 'arm64',
      files: ['src/main/llm/local-runtime.native-qualification.test.ts'],
      tests: 1,
      caseIds: ['native-resolver']
    }
  ],
  [
    'darwin/x64',
    {
      platform: 'darwin',
      arch: 'x64',
      files: ['src/main/llm/local-runtime.native-qualification.test.ts'],
      tests: 1,
      caseIds: ['native-resolver']
    }
  ],
  [
    'win32/x64',
    {
      platform: 'win32',
      arch: 'x64',
      files: [
        'src/main/llm/local-runtime.native-qualification.test.ts',
        'src/main/features/components/speech-pack/runtime-archive.windows-pipe.test.ts'
      ],
      tests: 3,
      caseIds: ['native-resolver', 'native-explicit-cpu']
    }
  ]
])
const nativeNames = {
  'native-resolver':
    'required native local-runtime qualification performs real health, auth, inference and owned-child shutdown through production resolver',
  'native-explicit-cpu':
    'required native local-runtime qualification performs real health, auth, inference and owned-child shutdown with explicit CPU binary',
  'windows-pipe':
    'Windows runtime archive named-pipe refusal proves a real blocking pipe read, then rejects the held pipe before payload reads'
}

export function validateCompositeEvidence(evidence, context) {
  demand(evidence && typeof evidence === 'object', 'COMPOSITE_EVIDENCE_MALFORMED')
  demand(typeof context?.sourceSha === 'string' && /^[0-9a-f]{40}$/.test(context.sourceSha), 'COMPOSITE_SHA_MALFORMED')
  demand(
    typeof context.runId === 'string' && /^\d+$/.test(context.runId) && integer(context.attempt) && context.attempt > 0,
    'COMPOSITE_RUN_BINDING_MALFORMED'
  )
  const sources = evidence.sources
  const natives = evidence.natives
  demand(Array.isArray(sources) && sources.length === 3, 'COMPOSITE_SOURCE_BUNDLE_COUNT_MISMATCH')
  demand(Array.isArray(natives) && natives.length === 3, 'COMPOSITE_NATIVE_BUNDLE_COUNT_MISMATCH')
  const sourceByLane = new Map()
  for (const bundle of sources) {
    const source = bundle?.evidence
    demand(
      source?.schema === 1 &&
        source.status === 'PASS' &&
        source.sourceSha === context.sourceSha &&
        source.runId === context.runId &&
        source.attempt === context.attempt,
      'COMPOSITE_SOURCE_BINDING_MISMATCH'
    )
    demand(
      ['linux', 'windows', 'macos'].includes(source.lane) && !sourceByLane.has(source.lane),
      'COMPOSITE_SOURCE_LANE_DUPLICATE_OR_UNKNOWN'
    )
    demand(
      source.platform === (source.lane === 'linux' ? 'linux' : source.lane === 'windows' ? 'win32' : 'darwin'),
      'COMPOSITE_SOURCE_HOST_MISMATCH'
    )
    demand(
      source.testStepOutcome === 'success' && source.processExit === 0 && source.inventoryVersion === INVENTORY_VERSION,
      'COMPOSITE_SOURCE_EXECUTION_MISMATCH'
    )
    demand(
      source.arch === { linux: 'x64', windows: 'x64', macos: 'arm64' }[source.lane],
      'COMPOSITE_SOURCE_ARCH_MISMATCH'
    )
    demand(
      hash(source.rawReportSha256) &&
        source.rawReportSha256 === bundle.rawReportSha256 &&
        hash(source.rawLogSha256) &&
        source.rawLogSha256 === bundle.rawLogSha256,
      'COMPOSITE_SOURCE_RAW_DIGEST_MISMATCH'
    )
    const posixLane = source.lane !== 'windows'
    const total = commonTotal + (posixLane ? 1 : 0)
    demand(
      source.tests?.total === total &&
        source.tests?.passed === total &&
        source.tests.failed === 0 &&
        source.tests.pending === 0 &&
        source.tests.todo === 0,
      'COMPOSITE_SOURCE_COUNT_MISMATCH'
    )
    const expectedFiles = [...COMMON_COUNTS.keys(), ...(posixLane ? [FIFO_FILE] : [])]
    demand(
      JSON.stringify(source.tests.files) === JSON.stringify(expectedFiles),
      'COMPOSITE_SOURCE_FILE_ROSTER_MISMATCH'
    )
    const fixedInventory = new Map(COMMON_COUNTS)
    if (posixLane) fixedInventory.set(FIFO_FILE, 1)
    const expectedInventoryDigest = createHash('sha256')
      .update(JSON.stringify([...fixedInventory]))
      .digest('hex')
    demand(source.inventorySha256 === expectedInventoryDigest, 'COMPOSITE_SOURCE_INVENTORY_DIGEST_MISMATCH')
    demand(
      Number.isSafeInteger(source.recursiveSuites?.total) &&
        source.recursiveSuites.total > 0 &&
        source.recursiveSuites.passed === source.recursiveSuites.total &&
        source.recursiveSuites.failed === 0 &&
        source.recursiveSuites.pending === 0,
      'COMPOSITE_SOURCE_RECURSIVE_SUITE_MISMATCH'
    )
    demand(
      Array.isArray(source.tests.cases) &&
        source.tests.cases.length === total &&
        source.tests.cases.every((test) => test.status === 'passed'),
      'COMPOSITE_SOURCE_CASE_ROSTER_MISMATCH'
    )
    const expectedCounts = new Map(COMMON_COUNTS)
    if (posixLane) expectedCounts.set(FIFO_FILE, 1)
    const perFile = new Map()
    const seenCases = new Set()
    for (const test of source.tests.cases) {
      demand(
        expectedCounts.has(test.file) && typeof test.fullName === 'string' && test.fullName.trim().length > 0,
        'COMPOSITE_SOURCE_CASE_ROSTER_MISMATCH'
      )
      const key = `${test.file}\0${test.fullName}`
      demand(!seenCases.has(key), 'COMPOSITE_SOURCE_CASE_DUPLICATE')
      seenCases.add(key)
      perFile.set(test.file, (perFile.get(test.file) ?? 0) + 1)
    }
    demand(
      [...expectedCounts].every(([file, count]) => perFile.get(file) === count),
      'COMPOSITE_SOURCE_PER_FILE_COUNT_MISMATCH'
    )
    demand(
      source.tests.cases.filter((test) => test.file === FIFO_FILE).length === (posixLane ? 1 : 0),
      'COMPOSITE_FIFO_MAPPING_MISMATCH'
    )
    if (posixLane)
      demand(
        source.tests.cases.find((test) => test.file === FIFO_FILE)?.fullName === FIFO_CASE,
        'COMPOSITE_FIFO_ROSTER_MISMATCH'
      )
    sourceByLane.set(source.lane, source)
  }
  demand(
    sourceByLane.size === 3 && ['linux', 'windows', 'macos'].every((lane) => sourceByLane.has(lane)),
    'COMPOSITE_SOURCE_LANE_MISSING'
  )
  const canon = (src) =>
    src.tests.cases
      .filter((test) => COMMON_COUNTS.has(test.file))
      .map(({ file, fullName }) => `${file}\0${fullName}`)
      .sort()
  const common = canon(sourceByLane.get('linux'))
  demand(common.length === commonTotal, 'COMPOSITE_COMMON_CASE_COUNT_MISMATCH')
  for (const lane of ['windows', 'macos'])
    demand(JSON.stringify(canon(sourceByLane.get(lane))) === JSON.stringify(common), 'COMPOSITE_COMMON_ROSTER_MISMATCH')
  const commonRosterSha256 = createHash('sha256').update(JSON.stringify(common)).digest('hex')
  const nativeByTuple = new Map()
  for (const bundle of natives) {
    const item = bundle?.evidence
    const tuple = `${item?.platform}/${item?.arch}`
    const expected = nativeExpected.get(tuple)
    demand(expected && !nativeByTuple.has(tuple), 'COMPOSITE_NATIVE_LANE_DUPLICATE_OR_UNKNOWN')
    demand(
      item.schema === 1 &&
        item.status === 'PASS' &&
        item.sourceSha === context.sourceSha &&
        item.runId === context.runId &&
        item.attempt === context.attempt,
      'COMPOSITE_NATIVE_BINDING_MISMATCH'
    )
    demand(item.nativeTestStepOutcome === 'success', 'COMPOSITE_NATIVE_EXECUTION_MISMATCH')
    demand(
      item.tests?.total === expected.tests &&
        item.tests.passed === expected.tests &&
        item.tests.failed === 0 &&
        item.tests.pending === 0 &&
        item.tests.todo === 0,
      'COMPOSITE_NATIVE_COUNT_MISMATCH'
    )
    demand(
      JSON.stringify([...item.tests.files].sort()) === JSON.stringify([...expected.files].sort()),
      'COMPOSITE_NATIVE_FILE_ROSTER_MISMATCH'
    )
    demand(
      Array.isArray(item.tests.cases) &&
        item.tests.cases.length === expected.tests &&
        item.tests.cases.every((test) => test.status === 'passed'),
      'COMPOSITE_NATIVE_CASE_ROSTER_MISMATCH'
    )
    const casePairs = new Set(item.tests.cases.map((test) => `${test.file}\0${test.fullName}`))
    demand(
      casePairs.has(`${expected.files[0]}\0${nativeNames['native-resolver']}`),
      'COMPOSITE_NATIVE_RESOLVER_CASE_MISSING'
    )
    if (item.platform === 'win32') {
      demand(
        casePairs.has(`src/main/llm/local-runtime.native-qualification.test.ts\0${nativeNames['native-explicit-cpu']}`),
        'COMPOSITE_WINDOWS_CPU_CASE_MISSING'
      )
      demand(
        casePairs.has(
          `src/main/features/components/speech-pack/runtime-archive.windows-pipe.test.ts\0${nativeNames['windows-pipe']}`
        ),
        'COMPOSITE_WINDOWS_PIPE_CASE_MISSING'
      )
    }
    demand(
      Array.isArray(item.nativeCases) && item.nativeCases.length === expected.caseIds.length,
      'COMPOSITE_NATIVE_WITNESS_COUNT_MISMATCH'
    )
    demand(
      item.macSupervision === (item.platform === 'darwin' ? 'DIRECT_FALLBACK_NOT_HELPER_QUALIFIED' : 'NOT_APPLICABLE'),
      'COMPOSITE_NATIVE_SUPERVISION_MISMATCH'
    )
    const witnessById = new Map(item.nativeCases.map((w) => [w.caseId, w]))
    for (const id of expected.caseIds) {
      const w = witnessById.get(id)
      demand(
        w &&
          w.platform === item.platform &&
          w.arch === item.arch &&
          w.testFullName === nativeNames[id] &&
          w.gpuQualification === 'NOT_QUALIFIED' &&
          w.inference === 'NONEMPTY',
        'COMPOSITE_NATIVE_WITNESS_MISMATCH'
      )
      demand(
        w.selection === (id === 'native-resolver' ? 'production-resolver' : 'explicit-cpu'),
        'COMPOSITE_NATIVE_SELECTION_MISMATCH'
      )
      demand(
        id !== 'native-resolver' ||
          (item.platform === 'darwin' ? w.variant === 'mac' : ['cpu', 'vulkan'].includes(w.variant)),
        'COMPOSITE_NATIVE_RESOLVER_VARIANT_MISMATCH'
      )
      demand(id !== 'native-explicit-cpu' || w.variant === 'cpu', 'COMPOSITE_NATIVE_CPU_VARIANT_MISMATCH')
      demand(
        w.macSupervision === (item.platform === 'darwin' ? 'DIRECT_FALLBACK_NOT_HELPER_QUALIFIED' : 'NOT_APPLICABLE'),
        'COMPOSITE_NATIVE_SUPERVISION_MISMATCH'
      )
    }
    if (item.platform === 'win32')
      demand(
        item.windowsRuntimeVariant === 'PRODUCTION_RESOLVER_AND_EXPLICIT_CPU_OBSERVED' &&
          item.windowsGpuQualification === 'NOT_QUALIFIED_NO_GPU_HARDWARE_CLAIM',
        'COMPOSITE_WINDOWS_CLASSIFICATION_MISMATCH'
      )
    demand(
      hash(item.testReportSha256) &&
        item.testReportSha256 === bundle.rawReportSha256 &&
        hash(item.inputEvidenceSha256) &&
        item.inputEvidenceSha256 === bundle.rawInputSha256 &&
        hash(item.nativeCasesSha256) &&
        item.nativeCasesSha256 === bundle.rawCasesSha256 &&
        hash(bundle.rawLogSha256),
      'COMPOSITE_NATIVE_DIGEST_MISMATCH'
    )
    demand(
      Array.isArray(item.inputs) &&
        item.inputs.length > 0 &&
        Array.isArray(item.runtimeInventories) &&
        item.runtimeInventories.length > 0,
      'COMPOSITE_NATIVE_INPUT_EVIDENCE_MISSING'
    )
    nativeByTuple.set(tuple, item)
  }
  demand(
    nativeByTuple.size === 3 && NATIVE_TUPLES.every(([p, a]) => nativeByTuple.has(`${p}/${a}`)),
    'COMPOSITE_NATIVE_LANE_MISSING'
  )
  return {
    schema: 1,
    status: 'RUNTIME_MAPPED_COMPOSITE_PASS',
    sourceSha: context.sourceSha,
    runId: context.runId,
    attempt: context.attempt,
    sourceLanes: sources.map(({ evidence: s }) => ({
      lane: s.lane,
      sourceSha: s.sourceSha,
      runId: s.runId,
      attempt: s.attempt,
      platform: s.platform,
      arch: s.arch,
      tests: s.tests.total,
      testStepOutcome: s.testStepOutcome,
      processExit: s.processExit,
      rawReportSha256: s.rawReportSha256,
      rawLogSha256: s.rawLogSha256
    })),
    nativeLanes: natives.map(({ evidence: n, rawLogSha256 }) => ({
      sourceSha: n.sourceSha,
      runId: n.runId,
      attempt: n.attempt,
      platform: n.platform,
      arch: n.arch,
      tests: n.tests.total,
      nativeTestStepOutcome: n.nativeTestStepOutcome,
      testReportSha256: n.testReportSha256,
      inputEvidenceSha256: n.inputEvidenceSha256,
      nativeCasesSha256: n.nativeCasesSha256,
      rawLogSha256
    })),
    mappedCounts: {
      commonFiles: 20,
      commonCases: commonTotal,
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
    },
    commonRosterSha256,
    gate: 'PASS',
    limitations: [
      'Linux is source/POSIX qualified only; no Linux native lane.',
      'GPU execution, Mac helper supervision, installed DMG/EXE behavior, production speech engine B/C/D, release acceptance and whole-app qualification are outside this result.'
    ]
  }
}

async function sha(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}
async function main() {
  const mode = process.argv[2]
  if (mode === 'source') {
    const [reportPath, logPath, outputPath] = process.argv.slice(3)
    demand(reportPath && logPath && outputPath, 'USAGE: source <report> <log> <output>')
    const reportBytes = await readFile(reportPath)
    const report = JSON.parse(reportBytes.toString('utf8'))
    const evidence = validateSourceReport(report, {
      sourceSha: process.env.GITHUB_SHA,
      actualHead: process.env.ACTUAL_HEAD,
      runId: process.env.GITHUB_RUN_ID,
      attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      lane: process.env.SOURCE_LANE,
      platform: process.env.ACTUAL_PLATFORM,
      arch: process.env.ACTUAL_ARCH,
      expectedArch: process.env.EXPECTED_ARCH,
      testStepOutcome: process.env.SOURCE_TEST_STEP_OUTCOME,
      processExit: Number(process.env.SOURCE_TEST_EXIT),
      checkoutRoot: process.cwd(),
      pathFlavor: process.platform === 'win32' ? 'win32' : 'posix',
      rawReportSha256: createHash('sha256').update(reportBytes).digest('hex'),
      rawLogSha256: await sha(logPath)
    })
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' })
    console.log(
      `RUNTIME_MAPPED_SOURCE_PASS ${JSON.stringify({ lane: evidence.lane, sha: evidence.sourceSha, tests: evidence.tests.total })}`
    )
    return
  }
  if (mode === 'aggregate') {
    const [bundleDirectory, outputPath] = process.argv.slice(3)
    demand(bundleDirectory && outputPath, 'USAGE: aggregate <bundle-directory> <output>')
    const manifest = JSON.parse(await readFile(resolve(bundleDirectory, 'manifest.json'), 'utf8'))
    demand(
      manifest.sourceSha === process.env.GITHUB_SHA &&
        manifest.runId === process.env.GITHUB_RUN_ID &&
        manifest.attempt === Number(process.env.GITHUB_RUN_ATTEMPT),
      'AGGREGATE_MANIFEST_BINDING_MISMATCH'
    )
    const expectedBundleNames = [
      ...['linux', 'windows', 'macos'].map(
        (lane) =>
          `runtime-source-${lane}-${process.env.GITHUB_SHA}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
      ),
      ...NATIVE_TUPLES.map(
        ([platform, arch]) =>
          `runtime-native-${platform}-${arch}-${process.env.GITHUB_SHA}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
      )
    ].sort()
    const actualBundleNames = (await readdir(bundleDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    demand(
      JSON.stringify(actualBundleNames) === JSON.stringify(expectedBundleNames),
      'AGGREGATE_BUNDLE_DIRECTORY_SET_MISMATCH'
    )
    const sources = []
    for (const lane of ['linux', 'windows', 'macos']) {
      const dir = resolve(
        bundleDirectory,
        `runtime-source-${lane}-${process.env.GITHUB_SHA}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
      )
      demand(
        JSON.stringify((await readdir(dir)).sort()) ===
          JSON.stringify(['source-exit.json', 'source-qualification.json', 'source-vitest.json', 'source-vitest.log']),
        'AGGREGATE_SOURCE_BUNDLE_LAYOUT_MISMATCH'
      )
      const evidence = JSON.parse(await readFile(resolve(dir, 'source-qualification.json'), 'utf8'))
      const rawReportSha256 = await sha(resolve(dir, 'source-vitest.json'))
      const rawLogSha256 = await sha(resolve(dir, 'source-vitest.log'))
      const exit = JSON.parse(await readFile(resolve(dir, 'source-exit.json'), 'utf8'))
      demand(
        exit.outcome === 'success' &&
          exit.processExit === 0 &&
          exit.exitCode === 0 &&
          exit.teeExit === 0 &&
          evidence.processExit === exit.processExit &&
          evidence.testStepOutcome === exit.outcome,
        'AGGREGATE_SOURCE_EXIT_RECORD_FAILED'
      )
      sources.push({ evidence, rawReportSha256, rawLogSha256 })
    }
    const natives = []
    for (const [platform, arch] of NATIVE_TUPLES) {
      const dir = resolve(
        bundleDirectory,
        `runtime-native-${platform}-${arch}-${process.env.GITHUB_SHA}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
      )
      demand(
        JSON.stringify((await readdir(dir)).sort()) ===
          JSON.stringify(
            [
              'native-cases.json',
              'native-inputs.json',
              'native-qualification.json',
              'native-vitest.json',
              'native-vitest.log',
              'native-exit.json'
            ].sort()
          ),
        'AGGREGATE_NATIVE_BUNDLE_LAYOUT_MISMATCH'
      )
      const evidence = JSON.parse(await readFile(resolve(dir, 'native-qualification.json'), 'utf8'))
      const rawReportSha256 = await sha(resolve(dir, 'native-vitest.json'))
      const rawInputSha256 = await sha(resolve(dir, 'native-inputs.json'))
      const rawCasesSha256 = await sha(resolve(dir, 'native-cases.json'))
      const rawLogSha256 = await sha(resolve(dir, 'native-vitest.log'))
      const exit = JSON.parse(await readFile(resolve(dir, 'native-exit.json'), 'utf8'))
      demand(
        exit.outcome === 'success' && exit.processExit === 0 && exit.teeExit === 0,
        'AGGREGATE_NATIVE_EXIT_RECORD_FAILED'
      )
      natives.push({ evidence, rawReportSha256, rawInputSha256, rawCasesSha256, rawLogSha256, exit })
    }
    const composite = validateCompositeEvidence(
      { sources, natives },
      {
        sourceSha: process.env.GITHUB_SHA,
        runId: process.env.GITHUB_RUN_ID,
        attempt: Number(process.env.GITHUB_RUN_ATTEMPT)
      }
    )
    await writeFile(outputPath, `${JSON.stringify(composite, null, 2)}\n`, { flag: 'wx' })
    console.log(
      `RUNTIME_MAPPED_COMPOSITE_PASS ${JSON.stringify({ sourceSha: composite.sourceSha, runId: composite.runId, attempt: composite.attempt, sourceLanes: composite.sourceLanes.length, nativeLanes: composite.nativeLanes.length })}`
    )
    return
  }
  throw new Error('Usage: runtime-mapped-qualification.mjs <source|aggregate> ...')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
