#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const [reportPath, inputPath, outputPath, nativeCasesPath] = process.argv.slice(2)
if (!reportPath || !inputPath || !outputPath || !nativeCasesPath)
  throw new Error(
    'Usage: validate-native-platform-qualification.mjs <vitest-json> <inputs-json> <output-json> <native-cases-json>'
  )
const [reportBytes, inputBytes, nativeCasesBytes] = await Promise.all([
  readFile(reportPath),
  readFile(inputPath),
  readFile(nativeCasesPath)
])
const report = JSON.parse(reportBytes.toString('utf8'))
const inputs = JSON.parse(inputBytes.toString('utf8'))
const nativeCasesReport = JSON.parse(nativeCasesBytes.toString('utf8'))
const platform = process.env.EXPECTED_PLATFORM
const arch = process.env.EXPECTED_ARCH
const expectedSha = process.env.GITHUB_SHA
const expectedRunId = process.env.GITHUB_RUN_ID
const expectedAttempt = Number(process.env.GITHUB_RUN_ATTEMPT)
const testStepOutcome = process.env.NATIVE_TEST_STEP_OUTCOME
const root = process.cwd()
const windows = platform === 'win32'
const expectedFileCases = new Map([
  [
    'src/main/llm/local-runtime.native-qualification.test.ts',
    windows
      ? [
          'required native local-runtime qualification performs real health, auth, inference and owned-child shutdown through production resolver',
          'required native local-runtime qualification performs real health, auth, inference and owned-child shutdown with explicit CPU binary'
        ]
      : [
          'required native local-runtime qualification performs real health, auth, inference and owned-child shutdown through production resolver'
        ]
  ],
  ...(windows
    ? [
        [
          'src/main/features/components/speech-pack/runtime-archive.windows-pipe.test.ts',
          [
            'Windows runtime archive named-pipe refusal proves a real blocking pipe read, then rejects the held pipe before payload reads'
          ]
        ]
      ]
    : [])
])
const expectedTestCount = [...expectedFileCases.values()].reduce((total, cases) => total + cases.length, 0)

if (testStepOutcome !== 'success')
  throw new Error(`Native Vitest process did not succeed: step outcome=${testStepOutcome ?? 'missing'}`)
if (
  inputs.schema !== 1 ||
  inputs.sourceSha !== expectedSha ||
  inputs.runId !== expectedRunId ||
  inputs.attempt !== expectedAttempt ||
  inputs.platform !== platform ||
  inputs.arch !== arch
)
  throw new Error('Input evidence source/platform/architecture binding mismatch')
if (!Array.isArray(inputs.inputs) || !Array.isArray(inputs.runtimeInventories))
  throw new Error('Input evidence inventory is missing')

const archivePins = windows
  ? new Map([
      [
        'resources/llama/.cache/llama-b9957-bin-win-cpu-x64.zip',
        '422ad9b46f5ab60f7fd2e83783233eba2d9383e6f17d7ee916c80f19eb070e79'
      ],
      [
        'resources/llama/.cache/llama-b9957-bin-win-vulkan-x64.zip',
        'fcc0a8c0f0f3140122452ed2728cebb520c5fbc4fc921836ee3a45dd77e18c68'
      ]
    ])
  : new Map([
      [
        `resources/llama/.cache/llama-b9957-bin-macos-${arch}.tar.gz`,
        arch === 'arm64'
          ? '7a43fd3c4ddd30f3c408da7c80975503f18b829da023a7d0e34bdb6f1b1a056f'
          : 'f03f6669c7e34c2768ca4a318dd13e105dec46e1f87a2165d2be7fd6a0ee4716'
      ]
    ])
const modelPins = new Map([
  [
    'resources/local-llm/models/qwen3.5-0.8b/model.gguf',
    [558_772_480, '3177ebd67afe4438374da19e690bc1b98756f7e0fea9240e1be404336156a7b5']
  ],
  [
    'resources/local-llm/models/qwen3.5-0.8b/mmproj.gguf',
    [204_987_232, '56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453']
  ],
  [
    'resources/local-llm/LICENSE.QWEN3.5-APACHE-2.0.txt',
    [11_344, '2410613f992aef11cab1ca584d5732068b6038da37bd140092f09f61dd1c31bd']
  ]
])
const inputByPath = new Map()
for (const input of inputs.inputs) {
  if (!input || typeof input.path !== 'string' || inputByPath.has(input.path))
    throw new Error('Input evidence has a malformed or duplicate path')
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 1 || !/^[0-9a-f]{64}$/.test(input.sha256 ?? ''))
    throw new Error(`Input evidence has invalid file metadata: ${input.path}`)
  inputByPath.set(input.path, input)
}
for (const [path, sha256] of archivePins) {
  const input = inputByPath.get(path)
  if (!input || input.sha256 !== sha256)
    throw new Error(`Pinned runtime archive evidence is missing or mismatched: ${path}`)
}
for (const [path, [bytes, sha256]] of modelPins) {
  const input = inputByPath.get(path)
  if (!input || input.bytes !== bytes || input.sha256 !== sha256)
    throw new Error(`Pinned model input evidence is missing or mismatched: ${path}`)
}
if (inputs.runtimeInventories.length !== archivePins.size) throw new Error('Runtime archive inventory count mismatch')
const expectedRuntimePaths = new Set()
const seenRuntimeArchives = new Set()
for (const inventory of inputs.runtimeInventories) {
  if (!archivePins.has(inventory.archive))
    throw new Error(`Runtime inventory references an unpinned archive: ${inventory.archive}`)
  if (seenRuntimeArchives.has(inventory.archive))
    throw new Error(`Runtime archive inventory is duplicated: ${inventory.archive}`)
  seenRuntimeArchives.add(inventory.archive)
  if (!Array.isArray(inventory.members) || inventory.members.length < 2)
    throw new Error(`Runtime archive inventory is empty or lacks libraries: ${inventory.archive}`)
  const names = inventory.members.map((member) => member.archiveMember)
  if (new Set(names).size !== names.length)
    throw new Error(`Runtime archive inventory has duplicate members: ${inventory.archive}`)
  const winVariant = inventory.archive.includes('-win-cpu-') ? 'cpu' : 'vulkan'
  const binaryName = windows ? 'llama-server.exe' : 'llama-server'
  const librarySuffix = windows ? '.dll' : '.dylib'
  if (!names.includes(binaryName) || !names.some((name) => name.endsWith(librarySuffix)))
    throw new Error(`Runtime archive inventory lacks its executable or libraries: ${inventory.archive}`)
  for (const member of inventory.members) {
    if (
      typeof member.archiveMember !== 'string' ||
      (member.archiveMember !== binaryName && !member.archiveMember.endsWith(librarySuffix)) ||
      !Number.isSafeInteger(member.bytes) ||
      member.bytes < 1 ||
      !/^[0-9a-f]{64}$/.test(member.sha256 ?? '')
    )
      throw new Error(`Runtime archive inventory has invalid member metadata: ${inventory.archive}`)
    const expectedPath = windows
      ? `resources/llama/win/${winVariant}/${member.archiveMember}`
      : `resources/llama/${arch === 'arm64' ? 'mac/arm64' : 'mac/x64'}/${member.archiveMember}`
    if (member.path !== expectedPath)
      throw new Error(`Runtime member is outside its pinned destination: ${member.path}`)
    const input = inputByPath.get(member.path)
    if (!input || input.bytes !== member.bytes || input.sha256 !== member.sha256)
      throw new Error(`Runtime member does not match input file evidence: ${member.path}`)
    expectedRuntimePaths.add(member.path)
  }
}
if (
  seenRuntimeArchives.size !== archivePins.size ||
  [...archivePins.keys()].some((path) => !seenRuntimeArchives.has(path))
)
  throw new Error('Runtime archive inventory omitted a pinned platform archive')
const expectedInputPaths = new Set([...archivePins.keys(), ...modelPins.keys(), ...expectedRuntimePaths])
if (
  inputByPath.size !== expectedInputPaths.size ||
  [...inputByPath.keys()].some((path) => !expectedInputPaths.has(path))
)
  throw new Error('Input report has an extra or missing file outside the pinned native inventory')

// Vitest counts each file suite and each nested describe suite in these totals. The
// strict file inventory below remains one Mac file / two Windows files; each file
// currently has exactly one describe, so recursive suite totals are two / four.
const expectedRecursiveSuiteCount = expectedFileCases.size * 2

if (
  report.success !== true ||
  report.numTotalTestSuites !== expectedRecursiveSuiteCount ||
  report.numPassedTestSuites !== expectedRecursiveSuiteCount ||
  report.numFailedTestSuites !== 0 ||
  report.numPendingTestSuites !== 0 ||
  report.numTotalTests !== expectedTestCount ||
  report.numPassedTests !== expectedTestCount ||
  report.numFailedTests !== 0 ||
  report.numPendingTests !== 0 ||
  report.numTodoTests !== 0
) {
  throw new Error(
    `Strict native inventory failed: recursiveSuites=${report.numTotalTestSuites}/${report.numPassedTestSuites}/${report.numFailedTestSuites}/${report.numPendingTestSuites} expected=${expectedRecursiveSuiteCount} tests=${report.numTotalTests}/${report.numPassedTests}/${report.numFailedTests}/${report.numPendingTests}/${report.numTodoTests}`
  )
}
if (
  report.unhandledErrors !== undefined &&
  (!Array.isArray(report.unhandledErrors) || report.unhandledErrors.length !== 0)
)
  throw new Error('Vitest reported unhandled errors')
if (!Array.isArray(report.testResults) || report.testResults.length !== expectedFileCases.size)
  throw new Error('Vitest file inventory is missing, duplicated, or contains extra suites')
const seenFiles = new Set()
const caseRoster = []
for (const suite of report.testResults) {
  if (typeof suite.name !== 'string') throw new Error('Vitest suite has no source file path')
  const absolute = isAbsolute(suite.name) ? resolve(suite.name) : resolve(root, suite.name)
  const local = relative(root, absolute)
  if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
    throw new Error(`Vitest suite path escapes checkout: ${suite.name}`)
  const file = local.split(sep).join('/')
  const expectedCases = expectedFileCases.get(file)
  if (!expectedCases || seenFiles.has(file)) throw new Error(`Unexpected or duplicate Vitest suite: ${file}`)
  seenFiles.add(file)
  if (suite.status !== 'passed') throw new Error(`Vitest suite did not pass: ${file} (${suite.status})`)
  if (!Array.isArray(suite.assertionResults) || suite.assertionResults.length !== expectedCases.length)
    throw new Error(`Vitest assertion count mismatch for ${file}`)
  const actualCases = suite.assertionResults.map((test) => test.fullName)
  if (
    new Set(actualCases).size !== actualCases.length ||
    expectedCases.some((name) => actualCases.filter((actual) => actual === name).length !== 1)
  )
    throw new Error(`Vitest case roster mismatch for ${file}: ${JSON.stringify(actualCases)}`)
  for (const test of suite.assertionResults) {
    if (test.status !== 'passed')
      throw new Error(`Vitest assertion failed or skipped: ${test.fullName} (${test.status})`)
    caseRoster.push({ file, fullName: test.fullName, status: test.status })
  }
}
if (seenFiles.size !== expectedFileCases.size) throw new Error('Vitest report omitted a required source file')

const expectedWitnesses = windows
  ? new Map([
      [
        'native-resolver',
        {
          fullName:
            'required native local-runtime qualification performs real health, auth, inference and owned-child shutdown through production resolver',
          selection: 'production-resolver',
          variants: new Set(['cpu', 'vulkan'])
        }
      ],
      [
        'native-explicit-cpu',
        {
          fullName:
            'required native local-runtime qualification performs real health, auth, inference and owned-child shutdown with explicit CPU binary',
          selection: 'explicit-cpu',
          variants: new Set(['cpu'])
        }
      ]
    ])
  : new Map([
      [
        'native-resolver',
        {
          fullName:
            'required native local-runtime qualification performs real health, auth, inference and owned-child shutdown through production resolver',
          selection: 'production-resolver',
          variants: new Set(['mac'])
        }
      ]
    ])
const witnesses = nativeCasesReport
if (!Array.isArray(witnesses)) throw new Error('Native case witness report is not an array')
if (witnesses.length !== expectedWitnesses.size) throw new Error('Observed native case witness count mismatch')
const seenWitnesses = new Set()
for (const witness of witnesses) {
  const expected = expectedWitnesses.get(witness.caseId)
  if (!expected || seenWitnesses.has(witness.caseId))
    throw new Error(`Unexpected or duplicate native case witness: ${witness.caseId}`)
  if (
    witness.platform !== platform ||
    witness.arch !== arch ||
    witness.testFullName !== expected.fullName ||
    witness.selection !== expected.selection ||
    !expected.variants.has(witness.variant) ||
    witness.gpuQualification !== 'NOT_QUALIFIED' ||
    witness.inference !== 'NONEMPTY' ||
    (platform === 'darwin' && witness.macSupervision !== 'DIRECT_FALLBACK_NOT_HELPER_QUALIFIED') ||
    (windows && witness.macSupervision !== 'NOT_APPLICABLE')
  )
    throw new Error(`Native case witness classification mismatch: ${JSON.stringify(witness)}`)
  seenWitnesses.add(witness.caseId)
}

const reportDigest = createHash('sha256').update(reportBytes).digest('hex')
const inputDigest = createHash('sha256').update(inputBytes).digest('hex')
const nativeCasesDigest = createHash('sha256').update(nativeCasesBytes).digest('hex')
const evidence = {
  schema: 1,
  status: 'PASS',
  sourceSha: expectedSha,
  runId: expectedRunId,
  attempt: expectedAttempt,
  platform,
  arch,
  nativeTestStepOutcome: testStepOutcome,
  macSupervision: platform === 'darwin' ? 'DIRECT_FALLBACK_NOT_HELPER_QUALIFIED' : 'NOT_APPLICABLE',
  windowsRuntimeVariant: windows ? 'PRODUCTION_RESOLVER_AND_EXPLICIT_CPU_OBSERVED' : 'NOT_APPLICABLE',
  windowsGpuQualification: windows ? 'NOT_QUALIFIED_NO_GPU_HARDWARE_CLAIM' : 'NOT_APPLICABLE',
  tests: {
    total: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    pending: report.numPendingTests,
    todo: report.numTodoTests,
    files: [...seenFiles].sort(),
    cases: caseRoster
  },
  nativeCases: witnesses,
  inputEvidenceSha256: inputDigest,
  testReportSha256: reportDigest,
  nativeCasesSha256: nativeCasesDigest,
  runtimeInventories: inputs.runtimeInventories,
  inputs: inputs.inputs
}
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' })
console.log(
  `NATIVE_PLATFORM_QUALIFICATION_PASS ${JSON.stringify({ sourceSha: expectedSha, runId: evidence.runId, attempt: evidence.attempt, platform, arch, tests: expectedTestCount, inputEvidenceSha256: inputDigest, testReportSha256: reportDigest, nativeCasesSha256: nativeCasesDigest })}`
)
