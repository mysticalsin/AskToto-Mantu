#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const BASE = '15fcfa376feda44531596218a3751c6ea37f98ef'
const HARNESS_BASELINE = 'c7901c5551c820171401ff4669b5af4b394eb5b9'
const IMAGE_POLICY_COMMIT = '0b10ac4badd4811685bb376f1a6ee8aab8212490'
const IMAGE_POLICY_PATH = 'src/renderer/src/components/Markdown.tsx'
const IMAGE_POLICY_SHA256 = '5f1d8910947f5b33de58b759d7bebf72088c1dfab26d013a8c9724640a62d994'
const HARNESS_BASELINE_FILES = Object.freeze([
  '.github/workflows/renderer-katex-security.yml',
  'scripts/ci/renderer-katex-provenance.mjs',
  'scripts/ci/renderer-katex-unhandled-reporter.mjs',
  'src/renderer/src/components/Markdown.katex.browser.test.ts',
  'src/renderer/src/components/Markdown.mermaid.browser.test.ts',
  'src/renderer/src/components/Markdown.security.browser.test.ts',
  'src/renderer/src/components/__tests__/renderer-security-browser-harness.ts'
])
const HARNESS_REPAIR_FILES = Object.freeze([
  '.github/workflows/renderer-katex-security.yml',
  'scripts/ci/renderer-katex-provenance.mjs',
  'src/renderer/src/components/Markdown.mermaid.browser.test.ts',
  'src/renderer/src/components/Markdown.security.browser.test.ts',
  'src/renderer/src/components/__tests__/renderer-security-browser-harness.ts'
])
const BASE_HASHES = Object.freeze({
  'package.json': '143e15a11a6b4285a02cb385a0701e85e2a001c0b2b0ed8560283ef12e938122',
  'package-lock.json': '88425a099d638387d1bf14fd06348002e3ced36f29ca25296d00f7e5b92b0393'
})
const OLD_KATEX = Object.freeze({
  version: '0.16.47',
  resolved: 'https://registry.npmjs.org/katex/-/katex-0.16.47.tgz',
  integrity: 'sha512-Eeo8Ys1doU1z+x8AZsPpQu+p/QcZBI5PeOo7QGQdy2x2m0MU/hYagBbGOmXwr5KVbEfVuWv9LpnQWeehogurjg=='
})
const FROZEN_RENDERER_PACKAGES = Object.freeze({
  'node_modules/mermaid': {
    version: '11.17.0',
    integrity: 'sha512-Jo9N377Wb4MSnHFPTbLi2SxFpsQl4eVHoxnW5U1Md9EazvgMp3s+4ohDxr81YNTgbn5Kj7HJ3yslrSJ52kwpbA=='
  },
  'node_modules/streamdown': {
    version: '2.5.0',
    integrity: 'sha512-/tTnURfIOxZK/pqJAxsfCvETG/XCJHoWnk3jq9xLcuz6CSpnjjuxSRBTTL4PKGhxiZQf0lqPxGhImdpwcZ2XwA=='
  }
})
const VULNERABLE_RESIDUE = Object.freeze([
  'node_modules/mermaid/dist/chunks/mermaid.esm/katex-HNBAO5SE.mjs',
  'node_modules/mermaid/dist/chunks/mermaid.esm/katex-HNBAO5SE.mjs.map',
  'node_modules/mermaid/dist/chunks/mermaid.esm.min/katex-CZ4GXH2S.mjs',
  'node_modules/mermaid/dist/chunks/mermaid.esm.min/katex-CZ4GXH2S.mjs.map'
])
const FILES = Object.freeze([
  'src/renderer/src/components/Markdown.security.browser.test.ts',
  'src/renderer/src/components/Markdown.katex.browser.test.ts',
  'src/renderer/src/components/Markdown.mermaid.browser.test.ts',
  'src/renderer/src/components/Markdown.warmup.test.ts',
  'src/renderer/src/components/CodeBlock.test.ts'
])
const IDS = Object.freeze([
  ...Array.from({ length: 9 }, (_, index) => `M${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `K${index + 1}`),
  ...Array.from({ length: 5 }, (_, index) => `D${index + 1}`),
  'C1'
])
const CAUSAL_RED = Object.freeze(['K1', 'K2', 'K3', 'K4', 'K9'])
const EXPECTED_OLD_NAMESPACE_RED = Object.freeze(['K5', 'K6'])

function fail(code) {
  throw new Error(`renderer-katex-provenance:${code}`)
}
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
function parseArgs(args) {
  const values = new Map()
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (!value.startsWith('--') || !args[index + 1]) fail('ARGUMENTS')
    values.set(value.slice(2), args[++index])
  }
  if (
    values.get('mode') !== 'baseline-red' ||
    !values.get('report') ||
    !values.get('log') ||
    !values.get('run-errors') ||
    !values.get('out') ||
    !values.has('test-exit')
  )
    fail('ARGUMENTS')
  return values
}
function fileHash(root, path) {
  const bytes = readFileSync(resolve(root, path))
  return { bytes: bytes.byteLength, sha256: sha256(bytes) }
}
function gitText(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function gitBytes(root, args) {
  return execFileSync('git', args, { cwd: root, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}
function changedPaths(root, range) {
  return gitText(root, ['diff', '--name-only', range]).split('\n').filter(Boolean).sort()
}
function requireExactPaths(actual, expected, code) {
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) fail(code)
}
function requireAncestor(root, ancestor, head, code) {
  try {
    gitText(root, ['merge-base', '--is-ancestor', ancestor, head])
  } catch {
    fail(code)
  }
}
function checkSourceLineage(root) {
  const head = gitText(root, ['rev-parse', 'HEAD'])
  if (head !== (process.env.GITHUB_SHA || head)) fail('CHECKOUT_SHA_MISMATCH')
  if (gitText(root, ['rev-parse', `${IMAGE_POLICY_COMMIT}^`]) !== HARNESS_BASELINE)
    fail('IMAGE_POLICY_PARENT')
  requireAncestor(root, BASE, head, 'DEPENDENCY_BASELINE_ANCESTRY')
  requireAncestor(root, HARNESS_BASELINE, head, 'HARNESS_BASELINE_ANCESTRY')
  requireAncestor(root, IMAGE_POLICY_COMMIT, head, 'IMAGE_POLICY_ANCESTRY')
  requireExactPaths(changedPaths(root, `${BASE}..${HARNESS_BASELINE}`), HARNESS_BASELINE_FILES, 'HARNESS_BASELINE_PATHS')
  requireExactPaths(changedPaths(root, `${HARNESS_BASELINE}..${IMAGE_POLICY_COMMIT}`), [IMAGE_POLICY_PATH], 'IMAGE_POLICY_PATHS')
  requireExactPaths(changedPaths(root, `${IMAGE_POLICY_COMMIT}..${head}`), HARNESS_REPAIR_FILES, 'HARNESS_REPAIR_PATHS')
  requireExactPaths(changedPaths(root, `${BASE}..${head}`), [...HARNESS_BASELINE_FILES, IMAGE_POLICY_PATH], 'COMPOSED_CHANGE_PATHS')
  const reviewedBytes = gitBytes(root, ['show', `${IMAGE_POLICY_COMMIT}:${IMAGE_POLICY_PATH}`])
  const currentBytes = readFileSync(resolve(root, IMAGE_POLICY_PATH))
  const parentBytes = gitBytes(root, ['show', `${HARNESS_BASELINE}:${IMAGE_POLICY_PATH}`])
  if (
    sha256(reviewedBytes) !== IMAGE_POLICY_SHA256 ||
    sha256(currentBytes) !== IMAGE_POLICY_SHA256 ||
    sha256(parentBytes) !== 'b012099ba2a8d66cc29caee8555d5a92ff82b3c7b32c205273a90de2c5d67eaa'
  )
    fail('IMAGE_POLICY_BYTES')
  return {
    dependencyBaseline: BASE,
    originalHarnessBaseline: HARNESS_BASELINE,
    reviewedImagePolicyCommit: IMAGE_POLICY_COMMIT,
    imagePolicyParent: HARNESS_BASELINE,
    imagePolicyPath: IMAGE_POLICY_PATH,
    imagePolicySha256: IMAGE_POLICY_SHA256,
    harnessRepairFiles: [...HARNESS_REPAIR_FILES],
    composedPaths: changedPaths(root, `${BASE}..${head}`)
  }
}
function assertionId(assertion) {
  const name = assertion.title || assertion.fullName || ''
  return IDS.find((id) => name.startsWith(`${id} `) || name.startsWith(`${id}:`)) || null
}
function checkReport(reportPath, exitCode) {
  let report
  if (statSync(reportPath).size > 16 * 1024 * 1024) fail('VITEST_REPORT_SIZE')
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch {
    fail('VITEST_REPORT_INVALID')
  }
  const results = Array.isArray(report.testResults) ? report.testResults : fail('SUITE_INVENTORY_MISSING')
  const fileNames = results.map((file) => relative(process.cwd(), resolve(file.name)).replaceAll('\\', '/')).sort()
  if (JSON.stringify(fileNames) !== JSON.stringify([...FILES].sort())) fail('SUITE_INVENTORY')
  if (
    !Number.isInteger(report.numTotalTestSuites) ||
    !Number.isInteger(report.numPassedTestSuites) ||
    !Number.isInteger(report.numFailedTestSuites) ||
    !Number.isInteger(report.numPendingTestSuites)
  )
    fail('SUITE_SUMMARY_SCHEMA')
  const suiteStates = new Map()
  function recordSuitePrefix(prefix, failed) {
    const key = JSON.stringify(prefix)
    suiteStates.set(key, suiteStates.get(key) || false || failed)
  }
  for (const file of results) {
    if (!['passed', 'failed'].includes(file.status) || typeof file.message !== 'string') fail('SUITE_RESULT_SCHEMA')
    // Vitest 4's JSON reporter puts hook/runtime suite errors in testResults[].message;
    // assertion-only failures stay in assertionResults and leave that message empty.
    if (file.message.length !== 0) fail('INDEPENDENT_SUITE_OR_HOOK_ERROR')
    const fileAssertions = Array.isArray(file.assertionResults) ? file.assertionResults : []
    const hasFailedAssertion = fileAssertions.some((entry) => entry.status === 'failed')
    if ((file.status === 'failed') !== hasFailedAssertion) fail('SUITE_STATUS_ASSERTION_MISMATCH')
    const relativeName = relative(process.cwd(), resolve(file.name)).replaceAll('\\', '/')
    recordSuitePrefix([relativeName], hasFailedAssertion)
    for (const assertion of fileAssertions) {
      const ancestors = assertion.ancestorTitles
      if (
        !Array.isArray(ancestors) ||
        ancestors.length === 0 ||
        ancestors.some((title) => typeof title !== 'string' || !title)
      )
        fail('SUITE_ANCESTOR_INVENTORY')
      for (let index = 1; index <= ancestors.length; index += 1)
        recordSuitePrefix([relativeName, ...ancestors.slice(0, index)], assertion.status === 'failed')
    }
  }
  const failedSuiteCount = [...suiteStates.values()].filter(Boolean).length
  if (
    report.numTotalTestSuites !== suiteStates.size ||
    report.numFailedTestSuites !== failedSuiteCount ||
    report.numPassedTestSuites !== suiteStates.size - failedSuiteCount ||
    report.numPendingTestSuites !== 0
  )
    fail('SUITE_SUMMARY_MISMATCH')
  const assertions = results.flatMap((file) => (Array.isArray(file.assertionResults) ? file.assertionResults : []))
  if (assertions.length !== 30 || report.numTotalTests !== 30) fail('TOTAL_TEST_COUNT')
  if (
    (report.numPendingTests ?? 0) !== 0 ||
    (report.numTodoTests ?? 0) !== 0 ||
    (report.numSkippedTests ?? 0) !== 0 ||
    (report.numCancelledTests ?? 0) !== 0
  )
    fail('SKIPPED_TODO_OR_PENDING')
  if (
    assertions.some(
      (entry) => !['passed', 'failed'].includes(entry.status) || entry.retryReason || Number(entry.retryCount || 0) > 0
    )
  )
    fail('STATUS_OR_RETRY')
  const identified = assertions.map(assertionId).filter(Boolean)
  if (
    identified.length !== IDS.length ||
    new Set(identified).size !== IDS.length ||
    IDS.some((id) => !identified.includes(id))
  )
    fail('CASE_ROSTER')
  const failed = assertions.filter((entry) => entry.status === 'failed')
  const failedIds = failed.map(assertionId).sort()
  if (JSON.stringify(failedIds) !== JSON.stringify([...CAUSAL_RED, ...EXPECTED_OLD_NAMESPACE_RED].sort()))
    fail('UNEXPECTED_FAILURE_SET')
  for (const id of CAUSAL_RED) {
    const causal = failed.filter((entry) => assertionId(entry) === id)
    if (causal.length !== 1 || !Array.isArray(causal[0].failureMessages) || causal[0].failureMessages.length !== 1)
      fail('RED_CAUSAL_ASSERTION_CARDINALITY')
  }
  if (
    exitCode !== 1 ||
    report.success !== false ||
    report.numFailedTests !== failedIds.length ||
    report.numPassedTests !== 30 - failedIds.length
  )
    fail('NOT_ACTUAL_NONZERO_RED')
  for (const failure of failed) {
    const message = (failure.failureMessages || []).join('\n')
    if (!message || message.length > 16_384 || !/AssertionError|toEqual|toBe/u.test(message)) fail('RED_NOT_ASSERTION')
    if (/pageerror|unhandledrejection|browser.*closed|timeout|launch.*failed/iu.test(message))
      fail('RED_IS_HARNESS_FAILURE')
    const id = assertionId(failure)
    if (['K1', 'K2', 'K3', 'K4'].includes(id) && !/javascript:alert\(1\)/u.test(message))
      fail('RED_CAUSAL_UNSAFE_HREF_MISSING')
    if (id === 'K5' && (!/rendererInheritedSentinel/iu.test(message) || !/rendered:\s*true/iu.test(message)))
      fail('RED_INHERITED_MACRO_CAUSE_MISSING')
    if (id === 'K6' && (!/own:\s*true|Received:\s*true/iu.test(message) || !/after:\s*['"]rendered/iu.test(message)))
      fail('RED_INHERITED_UNDO_CAUSE_MISSING')
    if (id === 'K9' && !/Too many expansions/iu.test(message)) fail('RED_INHERITED_BOUND_CAUSE_MISSING')
  }
  return {
    selectedFiles: fileNames,
    total: assertions.length,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numPendingTests ?? 0,
    todo: report.numTodoTests ?? 0,
    retries: 0,
    failedCases: failed
      .map((entry) => ({
        id: assertionId(entry),
        title: entry.fullName || entry.title,
        failureSha256: sha256(Buffer.from((entry.failureMessages || []).join('\n'), 'utf8')),
        causalFailureExcerpt:
          CAUSAL_RED.includes(assertionId(entry)) || EXPECTED_OLD_NAMESPACE_RED.includes(assertionId(entry))
            ? (entry.failureMessages || []).join('\n').slice(0, 2_000)
            : undefined,
        observedUnsafeOutput: ['K1', 'K2', 'K3', 'K4'].includes(assertionId(entry))
          ? /javascript:alert\(1\)/u.exec((entry.failureMessages || []).join('\n'))?.[0] || null
          : undefined
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    assertionCases: assertions
      .map((entry) => ({ id: assertionId(entry), status: entry.status }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
  }
}
function checkHarnessOrigins(directory) {
  const names = readdirSync(directory)
    .filter((name) => /^harness-origin-[0-9a-f-]{36}\.json$/u.test(name))
    .sort()
  if (names.length !== 3) fail('HARNESS_ORIGIN_COUNT')
  const origins = names.map((name) => {
    const path = resolve(directory, name)
    const stat = statSync(path)
    if (stat.size > 65_536) fail('HARNESS_ORIGIN_SIZE')
    let value
    try {
      value = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      fail('HARNESS_ORIGIN_JSON')
    }
    if (value.katexVersion !== OLD_KATEX.version || !/^\d+\.\d+\.\d+\.\d+(?:-.*)?$/u.test(value.browserVersion || ''))
      fail('HARNESS_RUNTIME_IDENTITY')
    const directEdge = value.directEdge
    const mermaidEdge = value.mermaidEdge
    const normalize = (text) => String(text || '').replaceAll('\\', '/')
    const validCandidate = (candidate) =>
      candidate &&
      typeof candidate.importer === 'string' &&
      typeof candidate.target === 'string' &&
      ['static', 'dynamic'].includes(candidate.kind) &&
      ['asset', 'runtime', 'other'].includes(candidate.assetKind) &&
      (candidate.chunk === null || typeof candidate.chunk === 'string') &&
      Number.isSafeInteger(candidate.renderedLength) &&
      candidate.renderedLength >= 0 &&
      Array.isArray(candidate.renderedExports) &&
      candidate.renderedExports.every((name) => typeof name === 'string')
    if (
      value.directImporterPresent !== true ||
      !Array.isArray(value.directCandidates) ||
      value.directCandidates.length === 0 ||
      value.directCandidates.length > 64 ||
      !value.directCandidates.every((candidate) => validCandidate(candidate) && candidate.importer === '\0renderer-katex-security-harness') ||
      !Array.isArray(value.mermaidCandidates) ||
      value.mermaidCandidates.length === 0 ||
      value.mermaidCandidates.length > 128 ||
      !value.mermaidCandidates.every(
        (candidate) =>
          validCandidate(candidate) &&
          /\/node_modules\/mermaid\/dist\/chunks\/mermaid\.core\//u.test(normalize(candidate.importer))
      )
    )
      fail('HARNESS_CANDIDATE_INVENTORY')
    const directRuntimeCandidates = value.directCandidates.filter(
      (candidate) =>
        candidate.assetKind === 'runtime' &&
        typeof candidate.chunk === 'string' &&
        candidate.chunk &&
        candidate.renderedLength > 0
    )
    const mermaidRuntimeCandidates = value.mermaidCandidates.filter(
      (candidate) =>
        candidate.assetKind === 'runtime' &&
        typeof candidate.chunk === 'string' &&
        candidate.chunk &&
        candidate.renderedLength > 0
    )
    if (
      directRuntimeCandidates.length !== 1 ||
      mermaidRuntimeCandidates.length !== 1 ||
      !value.directCandidates.some(
        (candidate) => candidate.assetKind === 'asset' && /katex\.min\.css(?:$|[?#])/iu.test(candidate.target)
      )
    )
      fail('HARNESS_RUNTIME_EDGE_CARDINALITY')
    const selectedDirect = directRuntimeCandidates[0]
    const selectedMermaid = mermaidRuntimeCandidates[0]
    if (
      !directEdge ||
      directEdge.importer !== '\0renderer-katex-security-harness' ||
      !directEdge.target ||
      !directEdge.chunk ||
      !mermaidEdge ||
      !mermaidEdge.importer ||
      !mermaidEdge.target ||
      !mermaidEdge.chunk ||
      JSON.stringify(directEdge) !== JSON.stringify(selectedDirect) ||
      JSON.stringify(mermaidEdge) !== JSON.stringify(selectedMermaid) ||
      directEdge.target !== mermaidEdge.target ||
      directEdge.chunk !== mermaidEdge.chunk ||
      !directEdge.renderedExports.includes('renderToString') ||
      !directEdge.renderedExports.includes('version') ||
      !mermaidEdge.renderedExports.includes('renderToString') ||
      !mermaidEdge.renderedExports.includes('version') ||
      value.katexDirect !== directEdge.target ||
      value.katexFromMermaid !== mermaidEdge.target ||
      !/(?:^|\/)node_modules\/katex\//u.test(normalize(directEdge.target)) ||
      !/\/node_modules\/mermaid\/dist\/chunks\/mermaid\.core\//u.test(normalize(mermaidEdge.importer))
    )
      fail('HARNESS_KATEX_MODULE_IDENTITY')
    if (!/node_modules[\\/]mermaid[\\/]dist[\\/]mermaid\.core\.mjs$/u.test(value.mermaidCore || ''))
      fail('HARNESS_MERMAID_CORE_IDENTITY')
    if (
      !Array.isArray(value.shikiChunks) ||
      value.shikiChunks.length === 0 ||
      value.shikiChunks.some((chunk) => typeof chunk !== 'string' || !chunk)
    )
      fail('HARNESS_SHIKI_CHUNK_MAP')
    return {
      name,
      sha256: sha256(readFileSync(path)),
      katexVersion: value.katexVersion,
      browserVersion: value.browserVersion,
      katexDirect: value.katexDirect,
      katexFromMermaid: value.katexFromMermaid,
      mermaidCore: value.mermaidCore,
      directImporterPresent: value.directImporterPresent,
      directCandidates: value.directCandidates,
      mermaidCandidates: value.mermaidCandidates,
      directEdge,
      mermaidEdge,
      shikiChunks: value.shikiChunks
    }
  })
  const first = JSON.stringify({ ...origins[0], name: undefined, sha256: undefined })
  if (origins.some((origin) => JSON.stringify({ ...origin, name: undefined, sha256: undefined }) !== first))
    fail('HARNESS_ORIGIN_DIVERGENCE')
  return origins
}
function checkRunErrors(reportPath, expectedPath) {
  if (reportPath !== expectedPath) fail('RUN_ERRORS_PATH')
  const stat = statSync(reportPath)
  if (stat.size > 32 * 1024) fail('RUN_ERRORS_SIZE')
  let report
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'))
  } catch {
    fail('RUN_ERRORS_INVALID')
  }
  if (
    report.schema !== 1 ||
    report.runId !== (process.env.GITHUB_RUN_ID || null) ||
    report.runAttempt !== (process.env.GITHUB_RUN_ATTEMPT || null) ||
    report.job !== (process.env.GITHUB_JOB || null) ||
    report.runnerOs !== (process.env.RUNNER_OS || process.platform) ||
    report.fileCount !== FILES.length ||
    !Number.isInteger(report.errorCount) ||
    report.errorCount !== 0 ||
    !Array.isArray(report.errors) ||
    report.errors.length !== 0 ||
    report.omittedErrors !== 0
  )
    fail('UNHANDLED_ERRORS_PRESENT_OR_RUN_MISMATCH')
  return { bytes: stat.size, sha256: sha256(readFileSync(reportPath)), errorCount: report.errorCount, errorCodes: [] }
}
function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = process.cwd()
  const lineage = checkSourceLineage(root)
  const manifest = Object.fromEntries(Object.keys(BASE_HASHES).map((path) => [path, fileHash(root, path)]))
  for (const [path, expected] of Object.entries(BASE_HASHES))
    if (manifest[path].sha256 !== expected) fail(`BASELINE_${path.replaceAll('.', '_').toUpperCase()}_MISMATCH`)
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'))
  const locked = lock.packages?.['node_modules/katex']
  if (
    !locked ||
    locked.version !== OLD_KATEX.version ||
    locked.resolved !== OLD_KATEX.resolved ||
    locked.integrity !== OLD_KATEX.integrity
  )
    fail('OLD_LOCK_IDENTITY')
  for (const [path, expected] of Object.entries(FROZEN_RENDERER_PACKAGES)) {
    const record = lock.packages?.[path]
    if (!record || record.version !== expected.version || record.integrity !== expected.integrity)
      fail(`FROZEN_${path.replaceAll('/', '_').toUpperCase()}`)
  }
  const installedPath = realpathSync(resolve(root, 'node_modules/katex'))
  const installed = JSON.parse(readFileSync(resolve(installedPath, 'package.json'), 'utf8'))
  if (installed.version !== OLD_KATEX.version) fail('OLD_INSTALLED_IDENTITY')
  const installedStat = statSync(resolve(installedPath, 'package.json'))
  const residue = VULNERABLE_RESIDUE.map((path) => ({ path, ...fileHash(root, path) }))
  const testExit = Number(args.get('test-exit'))
  if (!Number.isInteger(testExit) || testExit < 0 || testExit > 255) fail('TEST_EXIT_CODE')
  const tests = checkReport(resolve(root, args.get('report')), testExit)
  const runErrorsPath = resolve(root, args.get('run-errors'))
  const outPath = resolve(root, args.get('out'))
  const runErrors = checkRunErrors(runErrorsPath, resolve(dirname(outPath), 'vitest-run-errors.json'))
  const logPath = resolve(root, args.get('log'))
  const logStat = statSync(logPath)
  if (logStat.size > 4 * 1024 * 1024) fail('VITEST_LOG_SIZE')
  if (process.version !== 'v22.22.3' || process.env.NPM_VERSION !== '10.9.8') fail('TOOLCHAIN_PIN')
  const origins = checkHarnessOrigins(dirname(resolve(root, args.get('out'))))
  const result = {
    schema: 1,
    evidence: 'EXPECTED_BASELINE_RED_ONLY',
    securityQualification: false,
    source: {
      commit: process.env.GITHUB_SHA || null,
      baseline: BASE,
      originalHarnessBaseline: HARNESS_BASELINE,
      reviewedImagePolicyCommit: IMAGE_POLICY_COMMIT,
      productionUnchangedReplayOfDependencyBaseline: false,
      lineage,
      runId: process.env.GITHUB_RUN_ID || null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
      job: process.env.GITHUB_JOB || null,
      runnerOs: process.env.RUNNER_OS || process.platform
    },
    toolchain: {
      node: process.version,
      npm: process.env.NPM_VERSION,
      browser: 'installed Playwright Chromium from frozen lockfile',
      vitestJsonReporter: '4.1.11 JsonTestResults'
    },
    baselineManifest: manifest,
    installedOldKaTeX: {
      ...OLD_KATEX,
      realpath: installedPath,
      packageJsonBytes: installedStat.size,
      packageJsonSha256: fileHash(installedPath, 'package.json').sha256
    },
    browserOrigins: origins,
    knownVulnerableInputs: {
      advisory: 'GHSA-238p-pmpm-9mq7 / CVE-2026-103923',
      mermaidVersion: lock.packages?.['node_modules/mermaid']?.version || null,
      alternateBundledKaTeX: residue,
      status: 'installed-package-residue-is-known; shipping-bundle-not-measured-in-this-RED-stage'
    },
    testExitCode: testExit,
    testReport: {
      bytes: statSync(resolve(root, args.get('report'))).size,
      sha256: sha256(readFileSync(resolve(root, args.get('report'))))
    },
    testLog: { bytes: logStat.size, sha256: sha256(readFileSync(logPath)) },
    unhandledErrors: runErrors,
    tests
  }
  const out = outPath
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  console.log('renderer-katex-provenance:EXPECTED_BASELINE_RED_ONLY')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'renderer-katex-provenance:UNKNOWN')
    process.exitCode = 1
  }
}
