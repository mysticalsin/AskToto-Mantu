import { resolve } from 'node:path'

export const titles = [
  'keeps measurement identity stable across labels and evidence status only',
  'validates a closed sorted implementation inventory and rejects duplicate keys',
  'accepts canonical repository-relative paths and rejects absolute or noncanonical paths on every host OS',
  'accepts only bounded QA candidate manifest schemas and fixed package identity',
  'requires a bounded, unique, sorted fixed QA case roster',
  'binds a proposed candidate to its catalog, implementation inventory, runtime tuples, and case roster',
  'distinguishes unrelated managed settings from malformed persistence policy attempts',
  'accepts the immutable candidate catalog only when every derived ceiling is exact',
  'resolves proposed budgets only as a qualification candidate and closes production admission',
  'rejects unsupported runtime identities and unknown renderer-selected profile IDs',
  'fails closed when required managed policy is absent and rejects a forged opaque admin receipt',
  'verifies domain-separated Ed25519 enterprise envelopes against an external trust anchor',
  'keeps enterprise epoch and version high-water monotonic through ABA restoration',
  'admits a real bundled qualification receipt only for its measured profile, source inventory, and runtime',
  'does not downgrade malformed administrative policy bytes to absence'
]
export const rowIds = [
  'M01',
  'M02',
  'M03',
  'M04',
  'M05',
  'M06',
  'M07',
  'M08',
  'M09',
  'M10',
  'C01',
  'C02',
  'C03',
  'C04',
  'C05',
  'C06',
  'C07',
  'C08'
]
const p15Keys = ['schema', 'hostPlatform', 'branchPlatform', 'boundary', 'fixtureReady', 'cleanup', 'rows']
const cleanupKeys = ['readerRestored', 'platformRestored', 'programDataRestored', 'tempRemoved']
const rowKeys = [
  'id',
  'entered',
  'terminal',
  'readerCalls',
  'readerArgs',
  'readerOutcome',
  'receipt',
  'optional',
  'required',
  'rejection'
]

function exact(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  )
}

function bounded(list, limit, array = false) {
  if (!list || (array && !Array.isArray(list)) || typeof list[Symbol.iterator] !== 'function') return null
  const values = []
  for (const item of list) {
    values.push(item)
    if (values.length > limit) return null
  }
  return values
}

export function validP15(value) {
  if (
    !exact(value, p15Keys) ||
    value.schema !== 'metis-persistence-policy-p15/v1' ||
    !['linux', 'darwin', 'win32'].includes(value.hostPlatform) ||
    value.branchPlatform !== 'win32' ||
    value.boundary !== 'trusted-byte-reader' ||
    typeof value.fixtureReady !== 'boolean' ||
    !exact(value.cleanup, cleanupKeys) ||
    Object.values(value.cleanup).some((item) => typeof item !== 'boolean') ||
    !Array.isArray(value.rows) ||
    value.rows.length !== rowIds.length
  )
    return null
  if (JSON.stringify(value.rows.map((row) => row?.id)) !== JSON.stringify(rowIds)) return null
  const allowed = [
    ['exact', 'wrong', 'missing'],
    ['present', 'absent', 'invalid', 'rejected', 'unexpected'],
    ['opaque', 'none', 'unexpected'],
    ['candidate', 'ENTERPRISE_INVALID', 'ENTERPRISE_REQUIRED', 'not-called', 'unexpected'],
    ['candidate', 'ENTERPRISE_INVALID', 'ENTERPRISE_REQUIRED', 'not-called', 'unexpected'],
    ['none', 'same-read-error', 'same-close-error', 'unexpected']
  ]
  if (
    !value.rows.every(
      (row) =>
        exact(row, rowKeys) &&
        typeof row.entered === 'boolean' &&
        typeof row.terminal === 'boolean' &&
        Number.isInteger(row.readerCalls) &&
        row.readerCalls >= 0 &&
        row.readerCalls <= 2 &&
        allowed.every((items, index) =>
          items.includes(
            [row.readerArgs, row.readerOutcome, row.receipt, row.optional, row.required, row.rejection][index]
          )
        )
    )
  )
    return null
  return value
}

function observedWrite(stream, bytes) {
  return new Promise((accept, reject) => {
    stream.write(bytes, (error) => (error ? reject(error) : accept()))
  })
}

function errorInfo(result, expectedFailure) {
  const errors = result && Array.isArray(result.errors) ? result.errors : result?.errors === undefined ? [] : null
  if (!errors) return { count: null, kind: 'other', causal: false }
  if (!expectedFailure) return { count: errors.length, kind: errors.length === 0 ? 'none' : 'other', causal: false }
  if (errors.length !== 1) return { count: errors.length, kind: 'other', causal: false }
  const error = errors[0]
  const name = typeof error?.name === 'string' ? error.name : ''
  const message = typeof error?.message === 'string' ? error.message : ''
  return {
    count: 1,
    kind: name === 'AssertionError' ? 'assertion' : 'other',
    causal: name === 'AssertionError' && message.includes('P15_MALFORMED_AUTHORITY_MUST_REMAIN_INVALID')
  }
}

function inspectTest(test, index, suite) {
  const result = test?.result?.()
  const diagnostic = test?.diagnostic?.()
  const options = test?.options
  const errors = errorInfo(result, index === 14 && result?.state === 'failed')
  const state = result && ['passed', 'failed', 'pending', 'skipped'].includes(result.state) ? result.state : null
  const retryCount = Number.isInteger(diagnostic?.retryCount) ? diagnostic.retryCount : null
  const repeatCount = Number.isInteger(diagnostic?.repeatCount) ? diagnostic.repeatCount : null
  const flaky = typeof diagnostic?.flaky === 'boolean' ? diagnostic.flaky : null
  const durationMs = Number.isFinite(diagnostic?.duration) ? diagnostic.duration : null
  const startTime = Number.isFinite(diagnostic?.startTime) ? diagnostic.startTime : null
  const optionsValid =
    options &&
    options.mode === 'run' &&
    options.timeout === 30_000 &&
    options.fails !== true &&
    options.each !== true &&
    options.concurrent !== true &&
    options.shuffle !== true &&
    (options.retry === undefined || options.retry === 0) &&
    (options.repeats === undefined || options.repeats === 0)
  const valid =
    test?.name === titles[index] &&
    test?.parent === suite &&
    optionsValid &&
    state !== null &&
    diagnostic !== undefined &&
    retryCount === 0 &&
    repeatCount === 0 &&
    flaky === false &&
    durationMs !== null &&
    durationMs >= 0 &&
    startTime !== null &&
    errors.count !== null &&
    (index === 14 && state === 'failed' ? errors.causal : errors.count === 0)
  return {
    valid,
    entry: {
      title: titles[index],
      state: state ?? 'pending',
      retryCount,
      repeatCount,
      flaky,
      durationMs,
      startTime,
      errorCount: errors.count,
      errorKind: errors.kind,
      causalLabelMatched: errors.causal
    }
  }
}

function collectRuntime(testModules, unhandledErrors, reason) {
  let apiValid = true
  const modules = bounded(testModules, 1, true)
  const unhandled = bounded(unhandledErrors, 1024, true)
  if (!modules || modules.length !== 1 || !unhandled || !['passed', 'failed', 'interrupted'].includes(reason))
    apiValid = false
  const module = modules?.[0]
  let moduleErrors = null
  let suiteErrors = null
  let suites = null
  let tests = null
  if (module) {
    const rel = module.relativeModuleId?.replaceAll('\\', '/')
    const canonical =
      typeof module.moduleId === 'string' &&
      resolve(module.moduleId) === resolve('src/main/persistence/resource-policy.test.ts')
    const foundSuites = bounded(module.children?.allSuites?.(), 2)
    const foundTests = bounded(module.children?.allTests?.(), 16)
    const moduleFaults = module.errors?.()
    if (
      rel !== 'src/main/persistence/resource-policy.test.ts' ||
      !canonical ||
      !foundSuites ||
      foundSuites.length !== 1 ||
      !foundTests ||
      foundTests.length !== 15 ||
      !Array.isArray(moduleFaults)
    )
      apiValid = false
    moduleErrors = Array.isArray(moduleFaults) ? moduleFaults.length : null
    suites = foundSuites
    tests = foundTests
    if (suites?.length === 1) {
      const suiteFaults = suites[0].errors?.()
      suiteErrors = Array.isArray(suiteFaults) ? suiteFaults.length : null
      if (
        !Array.isArray(suiteFaults) ||
        suites[0].name !== 'persistence resource policy contracts' ||
        suites[0].parent !== module ||
        suites[0].options?.mode !== 'run' ||
        suites[0].options?.each === true ||
        suites[0].options?.shuffle === true ||
        suites[0].options?.concurrent === true ||
        suites[0].options?.fails === true
      )
        apiValid = false
    }
    if (moduleErrors !== 0 || suiteErrors !== 0) apiValid = false
  }
  const entries = []
  if (tests && suites?.length === 1) {
    for (const [index, test] of tests.entries()) {
      if (index >= titles.length) {
        apiValid = false
        break
      }
      const inspected = inspectTest(test, index, suites[0])
      entries.push(inspected.entry)
      if (!inspected.valid) apiValid = false
    }
  }
  const metadata = validP15(entries.length === 15 ? tests[14]?.meta?.()?.persistencePolicyP15 : null)
  if (entries.length !== 15 || unhandled?.length !== 0 || !metadata) apiValid = false
  return {
    schema: 'metis-persistence-policy-runtime/v1',
    sourceCommit: process.env.GITHUB_SHA || null,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: Number.isSafeInteger(Number(process.env.GITHUB_RUN_ATTEMPT))
      ? Number(process.env.GITHUB_RUN_ATTEMPT)
      : null,
    target: process.env.PERSISTENCE_QA_POLICY_TARGET || null,
    nonce: process.env.PERSISTENCE_QA_POLICY_NONCE || null,
    vitestVersion: '4.1.11',
    reason: ['passed', 'failed', 'interrupted'].includes(reason) ? reason : null,
    apiValid,
    unhandledErrors: unhandled ? unhandled.length : null,
    moduleErrors,
    suiteErrors,
    modules: modules?.length ?? null,
    suites: suites?.length ?? null,
    tests: entries,
    p15: metadata
  }
}

export default class PersistencePolicyReporter {
  async onUserConsoleLog(log) {
    const stream = log?.type === 'stdout' ? process.stdout : log?.type === 'stderr' ? process.stderr : null
    if (!stream || typeof log.content !== 'string' || (log.origin !== undefined && typeof log.origin !== 'string'))
      throw new Error('invalid worker console log')
    const byteLength = Buffer.byteLength(log.content) + (log.origin ? Buffer.byteLength(log.origin) + 2 : 0)
    if (byteLength > 64 * 1024) throw new Error('worker console log exceeds bound')
    await observedWrite(stream, Buffer.from(log.origin ? `${log.content}\n${log.origin}\n` : log.content))
  }

  async onTestRunEnd(testModules, unhandledErrors, reason) {
    let record
    try {
      record = collectRuntime(testModules, unhandledErrors, reason)
    } catch {
      record = {
        schema: 'metis-persistence-policy-runtime/v1',
        sourceCommit: process.env.GITHUB_SHA || null,
        runId: process.env.GITHUB_RUN_ID || null,
        runAttempt: Number.isSafeInteger(Number(process.env.GITHUB_RUN_ATTEMPT))
          ? Number(process.env.GITHUB_RUN_ATTEMPT)
          : null,
        target: process.env.PERSISTENCE_QA_POLICY_TARGET || null,
        nonce: process.env.PERSISTENCE_QA_POLICY_NONCE || null,
        vitestVersion: '4.1.11',
        reason: ['passed', 'failed', 'interrupted'].includes(reason) ? reason : null,
        apiValid: false,
        unhandledErrors: null,
        moduleErrors: null,
        suiteErrors: null,
        modules: null,
        suites: null,
        tests: [],
        p15: null
      }
    }
    const nonce = process.env.PERSISTENCE_QA_POLICY_NONCE
    if (
      !exact(record, [
        'schema',
        'sourceCommit',
        'runId',
        'runAttempt',
        'target',
        'nonce',
        'vitestVersion',
        'reason',
        'apiValid',
        'unhandledErrors',
        'moduleErrors',
        'suiteErrors',
        'modules',
        'suites',
        'tests',
        'p15'
      ]) ||
      record.schema !== 'metis-persistence-policy-runtime/v1' ||
      !/^[0-9a-f]{40}$/.test(record.sourceCommit || '') ||
      !/^[0-9]{1,32}$/.test(record.runId || '') ||
      !Number.isSafeInteger(record.runAttempt) ||
      record.runAttempt < 1 ||
      record.runAttempt > 1000 ||
      !['ubuntu-latest', 'macos-latest', 'windows-latest'].includes(record.target) ||
      !/^[0-9a-f]{32}$/.test(nonce || '') ||
      record.nonce !== nonce ||
      record.vitestVersion !== '4.1.11' ||
      !Array.isArray(record.tests) ||
      record.tests.length > 15 ||
      (record.p15 !== null && !validP15(record.p15))
    )
      throw new Error('invalid bounded runtime observation')
    const payload = Buffer.from(`${JSON.stringify(record)}\n`)
    if (payload.length > 64 * 1024) throw new Error('runtime observation exceeds bound')
    await observedWrite(process.stdout, Buffer.concat([Buffer.from(`METIS_P15_RUNTIME_V1 ${nonce} `), payload]))
  }
}
