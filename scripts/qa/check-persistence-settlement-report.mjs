import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const requiredFiles = [
  'src/main/persistence/bootstrap-main-factory.integration.test.ts',
  'src/main/persistence/root-registry.test.ts'
]
const requiredSuites = new Map([
  [requiredFiles[0], 'main persistence factory source fixture'],
  [requiredFiles[1], 'persistence root registry']
])
const hashedSources = [
  ...requiredFiles,
  'src/main/persistence/bootstrap.ts',
  'src/main/persistence/bootstrap-speech-owner.ts',
  'src/main/persistence/root-registry.ts',
  'src/main/persistence/protected-meeting-keys.ts',
  'src/main/infra/process/meeting-speech-host.ts',
  'src/main/meeting-speech-worker.ts',
  'src/main/features/meetings/incremental-meeting-journal.ts',
  'src/main/features/meetings/incremental-record-receipt.ts',
  'src/main/auth-speech-lease.ts',
  'src/main/settings-authority-history.ts',
  'src/main/settings-observation.ts',
  'src/main/persistence/resource-policy.ts',
  'resources/persistence-profiles.v1.json',
  'scripts/qa/persistence-settlement-unhandled-reporter.mjs',
  'scripts/qa/check-persistence-settlement-report.mjs',
  '.github/workflows/persistence-settlement.yml'
]

const cases = [
  {
    file: requiredFiles[0],
    caseId: 'F01',
    title: 'holds new root/key admission while policy publication is pending',
    expected: 'passed'
  },
  {
    file: requiredFiles[0],
    caseId: 'F02',
    title: 'creates, appends, settles, freshly reopens read-only, and preserves the durable frontier',
    expected: 'passed',
    evidence: 'F02'
  },
  {
    file: requiredFiles[0],
    caseId: 'F03',
    title: 'keeps main settlement pending until a retired worker reports physical exit',
    expected: 'passed'
  },
  {
    file: requiredFiles[0],
    caseId: 'O01',
    title: 'admits speech work only after its exact policy owner is published',
    expected: 'passed',
    evidence: 'O01'
  },
  {
    file: requiredFiles[0],
    caseId: 'O02',
    title: 'retires the original speech and journal owners across a same-profile policy refresh',
    expected: 'passed',
    evidence: 'O02'
  },
  {
    file: requiredFiles[0],
    caseId: 'O03',
    title: 'rejects a held canonical reply after the original settings authority is replaced and restored',
    expected: 'passed',
    evidence: 'O03'
  },
  {
    file: requiredFiles[0],
    caseId: 'O04',
    title: 'keeps the original speech owner retired after an observed profile path replacement and restoration',
    expected: 'passed',
    evidence: 'O04'
  },
  {
    file: requiredFiles[0],
    caseId: 'O05',
    title: 'rejects a held canonical reply after the original session principal is replaced and restored',
    expected: 'passed',
    evidence: 'O05'
  },
  {
    file: requiredFiles[0],
    caseId: 'O06',
    title: 'permanently refuses expired or regressed speech owner clocks',
    expected: 'passed',
    evidence: 'O06'
  },
  {
    file: requiredFiles[0],
    caseId: 'F04',
    title: 'joins held key writer and root settlement before releasing ownership',
    expected: 'passed'
  },
  {
    file: requiredFiles[0],
    caseId: 'F05',
    title: 'retains a failed key settlement across repeated journal and bootstrap disposal',
    expected: 'failed',
    cause: 'injected protected-key settlement failure'
  },
  {
    file: requiredFiles[0],
    caseId: 'F06',
    title: 'retains a failed writer close across repeated journal and bootstrap disposal',
    expected: 'failed',
    cause: 'injected writer descriptor close failure'
  },
  {
    file: requiredFiles[0],
    caseId: 'F07',
    title: 'retains a failed root close across repeated journal and bootstrap disposal',
    expected: 'failed',
    cause: 'injected root descriptor close failure'
  },
  {
    file: requiredFiles[0],
    caseId: 'F08',
    title: 'retains failed open cleanup with the original operation error',
    expected: 'failed',
    cause: 'injected partial-open writer close failure'
  },
  {
    file: requiredFiles[0],
    caseId: 'F09',
    title: 'settles resources after an already completed append refusal',
    expected: 'passed'
  },
  {
    file: requiredFiles[1],
    caseId: 'R01',
    title: 'does not create any path while reopening a missing generation',
    expected: 'passed'
  },
  {
    file: requiredFiles[1],
    caseId: 'R02',
    title: 'holds one writer lease and permanently retires the exact scope after an ABA restoration',
    expected: 'passed'
  },
  {
    file: requiredFiles[1],
    caseId: 'R03',
    title: 'closes rejected gateway opens and enforces the configured max plus one root descriptor limit',
    expected: 'passed'
  },
  {
    file: requiredFiles[1],
    caseId: 'R04',
    title: 'retains the root charge when a rejected open cannot close its descriptor',
    expected: 'failed',
    cause: 'injected failed-open directory close failure'
  },
  {
    file: requiredFiles[1],
    caseId: 'R05',
    title: 'keeps the writer reservation after unlink until descriptor settlement',
    expected: 'failed',
    cause: 'injected held writer close failure'
  }
]

function requireValue(condition, message) {
  if (!condition) throw new Error(`persistence-settlement-report:${message}`)
}

function requireEvidenceKeys(evidence, keys, caseId) {
  requireValue(
    Object.keys(evidence).sort().join(',') === [...keys, 'caseId'].sort().join(','),
    `${caseId} witness fields differ from the closed schema`
  )
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function readReport(path) {
  const absolute = resolve(path)
  let info
  try {
    info = statSync(absolute)
  } catch {
    throw new Error('persistence-settlement-report:JSON report is missing')
  }
  requireValue(info.isFile() && info.size > 0 && info.size <= 16 * 1024 * 1024, 'JSON report size is invalid')
  const startedAt = Number(process.env.REPORT_STARTED_AT_MS)
  requireValue(Number.isSafeInteger(startedAt) && startedAt > 0, 'run start timestamp is missing')
  requireValue(info.mtimeMs >= startedAt, 'JSON report is stale')
  try {
    const bytes = readFileSync(absolute)
    return { bytes, report: JSON.parse(bytes.toString('utf8')) }
  } catch {
    throw new Error('persistence-settlement-report:JSON report is malformed')
  }
}

function readUnhandledReport(path) {
  let info
  try {
    info = lstatSync(resolve(path))
  } catch {
    throw new Error('persistence-settlement-report:unhandled report is missing')
  }
  requireValue(info.isFile() && info.size > 0 && info.size <= 4096, 'unhandled report size or file type is invalid')
  const startedAt = Number(process.env.REPORT_STARTED_AT_MS)
  requireValue(Number.isSafeInteger(startedAt) && startedAt > 0, 'run start timestamp is missing')
  requireValue(info.mtimeMs >= startedAt, 'unhandled report is stale')
  let bytes
  let report
  try {
    bytes = readFileSync(resolve(path))
    report = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('persistence-settlement-report:unhandled report is malformed')
  }
  const keys = [
    'schema',
    'sourceHead',
    'runId',
    'runAttempt',
    'job',
    'target',
    'observed',
    'inputKind',
    'unhandledCount',
    'recordedAtMs'
  ].sort()
  requireValue(
    report &&
      typeof report === 'object' &&
      !Array.isArray(report) &&
      Object.keys(report).sort().join(',') === keys.join(','),
    'unhandled report fields differ from the closed schema'
  )
  requireValue(report.schema === 'metis-persistence-settlement-unhandled/v1', 'unhandled report schema is invalid')
  requireValue(report.sourceHead === process.env.GITHUB_SHA, 'unhandled report source head differs from the run')
  requireValue(report.runId === process.env.GITHUB_RUN_ID, 'unhandled report run differs from the current run')
  requireValue(
    report.runAttempt === process.env.GITHUB_RUN_ATTEMPT,
    'unhandled report attempt differs from the current attempt'
  )
  requireValue(report.job === process.env.GITHUB_JOB, 'unhandled report job differs from the current job')
  requireValue(
    report.target === process.env.PERSISTENCE_SETTLEMENT_TARGET,
    'unhandled report target differs from the current target'
  )
  requireValue(
    report.observed === true && report.inputKind === 'array',
    'Vitest unhandled-error input was not observed as an array'
  )
  requireValue(integer(report.unhandledCount) && report.unhandledCount === 0, 'Vitest reported unhandled errors')
  requireValue(
    integer(report.recordedAtMs) && report.recordedAtMs >= startedAt,
    'unhandled report timestamp is invalid'
  )
  return { bytes, report }
}

function normalizedName(value) {
  return typeof value === 'string' ? value.replaceAll('\\', '/') : ''
}

function readCaseEvidence(log) {
  const marker = 'PERSISTENCE_SETTLEMENT_EVIDENCE '
  const evidence = new Map()
  for (const line of log.split(/\r?\n/)) {
    const index = line.indexOf(marker)
    if (index < 0) continue
    const payload = line.slice(index + marker.length).trim()
    requireValue(payload.length > 0 && payload.length <= 4096, 'case evidence size is invalid')
    let value
    try {
      value = JSON.parse(payload)
    } catch {
      throw new Error('persistence-settlement-report:case evidence is malformed')
    }
    requireValue(
      value && typeof value.caseId === 'string' && !evidence.has(value.caseId),
      'case evidence is unnamed or duplicated'
    )
    evidence.set(value.caseId, value)
  }
  return evidence
}

function validateStructuredEvidence(evidence, assertion) {
  const causeEvidence = evidence.get(assertion.caseId)
  requireValue(causeEvidence, `actual injected-boundary evidence is missing for ${assertion.caseId}`)

  if (assertion.caseId === 'F02') {
    const expectedKeys = [
      'caseId',
      'readyProfile',
      'openedRealJournal',
      'ownerPredicate',
      'journalOwnerBeforeControl',
      'journalOwnerAfterControl',
      'recordInputsEqual',
      'policyInputsEqual',
      'controlCanonicalDispatches',
      'controlReceiptValid',
      'copiedReceiptRejected',
      'controlDisposal',
      'controlBindingIdentitySame',
      'controlOwnerTokenIdentitySame',
      'controlCallbackIdentitySame',
      'controlPhysicalExit',
      'controlReceiptDiscarded',
      'bootstrapCanonicalCalls',
      'bootstrapCanonicalDispatches',
      'bootstrapHostError',
      'appendStatus',
      'appendReason'
    ].sort()
    requireValue(
      Object.keys(causeEvidence).sort().join(',') === expectedKeys.join(','),
      'F02 main-owned owner witness fields differ from the closed schema'
    )
    requireValue(
      causeEvidence.readyProfile === true &&
        causeEvidence.openedRealJournal === true &&
        causeEvidence.ownerPredicate === 'present' &&
        causeEvidence.journalOwnerBeforeControl === true &&
        causeEvidence.journalOwnerAfterControl === true &&
        causeEvidence.recordInputsEqual === true &&
        causeEvidence.policyInputsEqual === true &&
        causeEvidence.controlCanonicalDispatches === 1 &&
        causeEvidence.controlReceiptValid === true &&
        causeEvidence.copiedReceiptRejected === true &&
        causeEvidence.controlBindingIdentitySame === true &&
        causeEvidence.controlOwnerTokenIdentitySame === true &&
        causeEvidence.controlCallbackIdentitySame === true &&
        causeEvidence.controlDisposal === 'fulfilled' &&
        causeEvidence.controlPhysicalExit === true &&
        causeEvidence.controlReceiptDiscarded === true &&
        causeEvidence.bootstrapCanonicalCalls === 1 &&
        causeEvidence.bootstrapCanonicalDispatches === 1 &&
        causeEvidence.bootstrapHostError === 'NONE' &&
        causeEvidence.appendStatus === 'durable' &&
        causeEvidence.appendReason === null,
      'F02 did not prove the real control and main-owned durable append'
    )
  } else if (assertion.caseId === 'O01') {
    requireEvidenceKeys(
      causeEvidence,
      [
        'candidateFalseInFactory',
        'workerStartsBeforeAppend',
        'ownerCurrentAfterPublication',
        'appendStatus',
        'workerStartsAfterAppend',
        'ownerFalseAfterRetire',
        'ownerFalseAfterDispose'
      ],
      'O01'
    )
    requireValue(
      causeEvidence.candidateFalseInFactory === true &&
        causeEvidence.workerStartsBeforeAppend === 0 &&
        causeEvidence.ownerCurrentAfterPublication === true &&
        causeEvidence.appendStatus === 'durable' &&
        causeEvidence.workerStartsAfterAppend === 1 &&
        causeEvidence.ownerFalseAfterRetire === true &&
        causeEvidence.ownerFalseAfterDispose === true,
      'O01 did not witness candidate-to-published owner authority and sticky retirement'
    )
  } else if (assertion.caseId === 'O02') {
    requireEvidenceKeys(
      causeEvidence,
      [
        'initialAppendStatus',
        'oldOwnerFalseWhilePending',
        'newActionBlocked',
        'noReplacementBeforeExit',
        'physicalExitHeld',
        'physicalExitReleased',
        'sameProfileObject',
        'oldOwnerFalseAfterRefresh',
        'oldJournalStatus',
        'oldJournalReason',
        'freshOwnerCurrent',
        'freshAppendStatus'
      ],
      'O02'
    )
    requireValue(
      causeEvidence.initialAppendStatus === 'durable' &&
        causeEvidence.oldOwnerFalseWhilePending === true &&
        causeEvidence.newActionBlocked === true &&
        causeEvidence.noReplacementBeforeExit === true &&
        causeEvidence.physicalExitHeld === true &&
        causeEvidence.physicalExitReleased === true &&
        causeEvidence.sameProfileObject === true &&
        causeEvidence.oldOwnerFalseAfterRefresh === true &&
        causeEvidence.oldJournalStatus === 'refused' &&
        causeEvidence.oldJournalReason === 'STALE_OWNER' &&
        causeEvidence.freshOwnerCurrent === true &&
        causeEvidence.freshAppendStatus === 'durable',
      'O02 did not witness original-owner retirement and joined same-profile refresh'
    )
  } else if (assertion.caseId === 'O03' || assertion.caseId === 'O05') {
    requireEvidenceKeys(
      causeEvidence,
      [
        'heldActualReply',
        'canonicalDispatches',
        ...(assertion.caseId === 'O03' ? ['settingsChangedAndRestored'] : []),
        ...(assertion.caseId === 'O05' ? ['originalPrincipalRestored', 'originalAuthEpochChanged'] : []),
        'oldOwnerFalseAfterRestore',
        'hostError',
        'oldReceiptAccepted',
        'appendStatus',
        'appendReason',
        'durableRevisionUnchanged',
        'recordCountUnchanged'
      ],
      assertion.caseId
    )
    requireValue(
      causeEvidence.heldActualReply === true &&
        causeEvidence.canonicalDispatches === 1 &&
        causeEvidence.oldOwnerFalseAfterRestore === true &&
        causeEvidence.hostError === 'CANCELLED' &&
        causeEvidence.oldReceiptAccepted === false &&
        causeEvidence.appendStatus === 'refused' &&
        causeEvidence.appendReason === 'UNAVAILABLE' &&
        causeEvidence.durableRevisionUnchanged === true &&
        causeEvidence.recordCountUnchanged === true &&
        (assertion.caseId !== 'O05' ||
          (causeEvidence.originalPrincipalRestored === true && causeEvidence.originalAuthEpochChanged === true)),
      `${assertion.caseId} did not witness held-reply cancellation and unchanged durable frontier`
    )
    if (assertion.caseId === 'O03')
      requireValue(causeEvidence.settingsChangedAndRestored === true, 'O03 settings authority was not restored')
  } else if (assertion.caseId === 'O04') {
    requireEvidenceKeys(
      causeEvidence,
      [
        'initialAppendStatus',
        'bindingCaptured',
        'serviceCaptured',
        'ownerFalseAtReplacement',
        'ownerFalseAfterRestoration',
        'staleHostError',
        'dispatchesBeforeStaleCall',
        'dispatchesAfterStaleCall',
        'frontierUnchanged'
      ],
      'O04'
    )
    requireValue(
      causeEvidence.initialAppendStatus === 'durable' &&
        causeEvidence.bindingCaptured === true &&
        causeEvidence.serviceCaptured === true &&
        causeEvidence.ownerFalseAtReplacement === true &&
        causeEvidence.ownerFalseAfterRestoration === true &&
        causeEvidence.staleHostError === 'CANCELLED' &&
        causeEvidence.dispatchesBeforeStaleCall === 1 &&
        causeEvidence.dispatchesAfterStaleCall === 1 &&
        causeEvidence.frontierUnchanged === true,
      'O04 did not witness sticky profile-path retirement before dispatch'
    )
  } else if (assertion.caseId === 'O06') {
    requireEvidenceKeys(causeEvidence, ['clockCases'], 'O06')
    requireValue(
      Array.isArray(causeEvidence.clockCases) && causeEvidence.clockCases.length === 4,
      'O06 clock-case inventory is not exactly four'
    )
    const ids = ['enterprise-expiry', 'wall-clock-rollback', 'monotonic-clock-rollback', 'non-finite-clock']
    for (const [index, item] of causeEvidence.clockCases.entries()) {
      requireEvidenceKeys(
        item,
        [
          'ownerCurrentBeforeFault',
          'initialAppendStatus',
          'bindingCaptured',
          'ownerFalseAtFault',
          'staleHostError',
          'dispatchesBeforeFault',
          'dispatchesAfterFault',
          'ownerFalseAfterRestore'
        ],
        `O06/${ids[index]}`
      )
      requireValue(
        item.caseId === ids[index] &&
          item.ownerCurrentBeforeFault === true &&
          item.initialAppendStatus === 'durable' &&
          item.bindingCaptured === true &&
          item.ownerFalseAtFault === true &&
          item.staleHostError === 'CANCELLED' &&
          item.dispatchesBeforeFault === 1 &&
          item.dispatchesAfterFault === 1 &&
          item.ownerFalseAfterRestore === true,
        `O06 clock witness ${index} did not prove sticky pre-dispatch refusal`
      )
    }
  } else if (assertion.caseId === 'F05') {
    requireValue(
      causeEvidence.keySettlementAttemptsBeforeSuccessor === 1 &&
        causeEvidence.journalOutcome?.status === 'rejected' &&
        causeEvidence.journalOutcome.errorMessage?.includes('injected protected-key settlement failure') &&
        causeEvidence.keySettlementAttemptsAfterDisposal === 2 &&
        causeEvidence.successorAdmitted === true &&
        causeEvidence.successorOutcome?.status === 'fulfilled' &&
        causeEvidence.disposalOutcome?.status === 'fulfilled',
      'F05 did not show one injected key-settlement failure followed by false capacity/disposal success'
    )
  } else if (assertion.caseId === 'F06') {
    requireValue(
      causeEvidence.writerCloseAttemptsBeforeSuccessor === 1 &&
        causeEvidence.writerCloseAttemptsAfterDisposal === 1 &&
        causeEvidence.journalOutcome?.status === 'fulfilled' &&
        causeEvidence.successorAdmitted === true &&
        causeEvidence.successorOutcome?.status === 'fulfilled' &&
        causeEvidence.disposalOutcome?.status === 'fulfilled',
      'F06 did not show one injected writer-close failure followed by false settlement/capacity/disposal success'
    )
  } else if (assertion.caseId === 'F07') {
    requireValue(
      causeEvidence.rootCloseAttemptsBeforeSuccessor === 1 &&
        causeEvidence.rootCloseAttemptsAfterDisposal === 1 &&
        causeEvidence.journalOutcome?.status === 'fulfilled' &&
        causeEvidence.successorAdmitted === false &&
        causeEvidence.successorOutcome?.status === 'rejected' &&
        causeEvidence.disposalOutcome?.status === 'fulfilled',
      'F07 did not show one injected root-close failure followed by false journal/disposal success'
    )
  } else if (assertion.caseId === 'F08') {
    requireValue(
      causeEvidence.writerCloseAttemptsBeforeDisposal === 1 &&
        causeEvidence.writerCloseAttemptsAfterDisposal === 1 &&
        causeEvidence.openingOutcome?.status === 'rejected' &&
        causeEvidence.openingOutcome.errorName === 'Error' &&
        causeEvidence.openingOutcome.errorMessage === 'injected native key wrapping failure' &&
        Array.isArray(causeEvidence.aggregateMessages) &&
        causeEvidence.aggregateMessages.length === 0 &&
        causeEvidence.successorAdmitted === true &&
        causeEvidence.successorOutcome?.status === 'fulfilled' &&
        causeEvidence.disposalOutcome?.status === 'fulfilled',
      'F08 did not reach the close fault or did not preserve the original non-aggregate open outcome'
    )
  } else if (assertion.caseId === 'R04') {
    requireValue(
      causeEvidence.failedOpenCloseAttempts === 1 &&
        causeEvidence.gatewayRejected === true &&
        causeEvidence.successorAdmitted === true &&
        causeEvidence.successorOutcome?.status === 'fulfilled',
      'R04 did not show failed-open close injection followed by false root-capacity reuse'
    )
  } else if (assertion.caseId === 'R05') {
    requireValue(
      causeEvidence.closeAttempts === 1 &&
        causeEvidence.reopenedCapability === true &&
        causeEvidence.maxHeldRoots > 2 &&
        causeEvidence.heldOriginalAdmitted === true &&
        causeEvidence.heldReopenedAdmitted === true &&
        causeEvidence.failedOriginalAdmitted === true &&
        causeEvidence.failedReopenedAdmitted === true,
      'R05 did not show one close fault and physical-root writer admission through both capabilities'
    )
  }
}

function validate() {
  const reportPath = process.env.VITEST_REPORT_PATH
  const logPath = process.env.VITEST_LOG_PATH
  const unhandledReportPath = process.env.UNHANDLED_REPORT_PATH
  const receiptPath = process.env.SETTLEMENT_RECEIPT_PATH
  requireValue(
    reportPath && logPath && unhandledReportPath && receiptPath,
    'report/log/unhandled/receipt paths are missing'
  )
  requireValue(
    process.env.PERSISTENCE_SETTLEMENT_PHASE === 'settlement-red-with-owner',
    'phase is not settlement-red-with-owner'
  )
  requireValue(process.env.GITHUB_SHA && /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA), 'commit identity is invalid')
  requireValue(/^\d+$/.test(process.env.GITHUB_RUN_ID ?? ''), 'run identity is invalid')
  requireValue(/^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? ''), 'run attempt is invalid')
  requireValue(process.env.PERSISTENCE_SETTLEMENT_TARGET === 'ubuntu-latest', 'source target is not pinned Ubuntu')
  requireValue(process.env.VITEST_EXIT_CODE === '1', 'Vitest did not return the required settlement RED exit')

  let log
  try {
    const logInfo = statSync(resolve(logPath))
    requireValue(logInfo.isFile() && logInfo.size > 0 && logInfo.size <= 4 * 1024 * 1024, 'Vitest log size is invalid')
    log = readFileSync(resolve(logPath), 'utf8')
  } catch {
    throw new Error('persistence-settlement-report:Vitest log is missing or unreadable')
  }
  requireValue(!/unhandled errors?|unhandled rejections?/i.test(log), 'Vitest log records an unhandled error')
  const evidence = readCaseEvidence(log)
  const expectedWitnessIds = cases
    .filter((entry) => entry.evidence || entry.expected === 'failed')
    .map((entry) => entry.caseId)
    .sort()
  const requiredWitnessIds = ['F02', 'F05', 'F06', 'F07', 'F08', 'O01', 'O02', 'O03', 'O04', 'O05', 'O06', 'R04', 'R05']
  requireValue(
    expectedWitnessIds.join(',') === requiredWitnessIds.join(','),
    'closed case inventory does not produce the exact thirteen-witness roster'
  )
  requireValue(
    evidence.size === requiredWitnessIds.length && requiredWitnessIds.every((caseId) => evidence.has(caseId)),
    'actual evidence does not contain exactly the thirteen unique closed witnesses'
  )

  const { bytes, report } = readReport(reportPath)
  const { bytes: unhandledBytes, report: unhandledReport } = readUnhandledReport(unhandledReportPath)
  requireValue(report.success === false, 'Vitest JSON does not record a failed run')
  const expectedCounters = {
    numTotalTests: 20,
    numPassedTests: 14,
    numFailedTests: 6,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTestSuites: 4,
    numPendingTestSuites: 0
  }
  for (const [name, expected] of Object.entries(expectedCounters))
    requireValue(report[name] === expected, `${name} must equal ${expected}`)
  for (const name of ['numPassedTestSuites', 'numFailedTestSuites'])
    requireValue(integer(report[name]), `${name} is missing or invalid`)
  requireValue(
    report.numPassedTestSuites + report.numFailedTestSuites + report.numPendingTestSuites === 4,
    'recursive suite counts are inconsistent'
  )
  if ('numUnhandledErrors' in report)
    requireValue(
      report.numUnhandledErrors === unhandledReport.unhandledCount,
      'Vitest JSON unhandled count differs from actual reporter evidence'
    )
  if ('unhandledErrors' in report)
    requireValue(
      Array.isArray(report.unhandledErrors) && report.unhandledErrors.length === unhandledReport.unhandledCount,
      'Vitest JSON unhandled errors differ from actual reporter evidence'
    )

  requireValue(
    Array.isArray(report.testResults) && report.testResults.length === 2,
    'test file inventory is not exactly two files'
  )
  const files = new Map()
  for (const result of report.testResults) {
    const name = normalizedName(result.name)
    const file = requiredFiles.find((candidate) => name.endsWith(`/${candidate}`))
    requireValue(file && !files.has(file), 'unexpected or duplicate test file result')
    files.set(file, result)
  }
  requireValue(
    requiredFiles.every((file) => files.has(file)),
    'a required test file is missing'
  )

  const actualCases = new Map()
  const suiteTitles = new Set()
  for (const file of requiredFiles) {
    const result = files.get(file)
    requireValue(result.status === 'failed', `expected failed suite status for ${file}`)
    requireValue(Array.isArray(result.assertionResults), `assertion results are missing for ${file}`)
    for (const assertion of result.assertionResults) {
      requireValue(
        typeof assertion.title === 'string' && !actualCases.has(assertion.title),
        'duplicate or unnamed assertion'
      )
      requireValue(Array.isArray(assertion.ancestorTitles), 'recursive suite ancestry is missing')
      const topSuite = assertion.ancestorTitles[0]
      requireValue(
        typeof topSuite === 'string' && assertion.ancestorTitles.length === 1,
        'suite nesting differs from the closed inventory'
      )
      requireValue(topSuite === requiredSuites.get(file), `suite title differs from the closed inventory for ${file}`)
      suiteTitles.add(`${file}:${topSuite}`)
      actualCases.set(assertion.title, { file, assertion })
    }
    requireValue(!result.message, `runner or import error occurred in ${file}`)
  }
  requireValue(suiteTitles.size === 2, 'recursive describe inventory is not exactly two groups')
  requireValue(
    report.testResults.length + suiteTitles.size === report.numTotalTestSuites,
    'recursive suite total is not four'
  )
  requireValue(actualCases.size === cases.length, 'actual assertion count is not twenty')

  for (const expected of cases) {
    const found = actualCases.get(expected.title)
    requireValue(found && found.file === expected.file, `case inventory differs: ${expected.title}`)
    requireValue(found.assertion.status === expected.expected, `unexpected status for ${expected.title}`)
    if (expected.expected === 'failed') {
      requireValue(
        Array.isArray(found.assertion.failureMessages) && found.assertion.failureMessages.length === 1,
        `causal case ${expected.title} must have exactly one assertion failure`
      )
      const failureText = found.assertion.failureMessages[0]
      requireValue(
        failureText.startsWith('AssertionError:'),
        `causal case ${expected.title} is not an assertion failure`
      )
      requireValue(
        !/STACK_TRACE_ERROR|timed? ?out|timeout|Cannot find module|Failed to load module/i.test(failureText),
        `causal case ${expected.title} contains a runner/import/timeout error`
      )
      validateStructuredEvidence(evidence, expected)
      requireValue(failureText.includes(expected.cause), `assertion location omits its case label: ${expected.title}`)
    } else {
      requireValue(!found.assertion.failureMessages?.length, `positive control failed: ${expected.title}`)
      if (expected.evidence) validateStructuredEvidence(evidence, expected)
    }
  }
  requireValue(
    [...actualCases.keys()].every((title) => cases.some((entry) => entry.title === title)),
    'unexpected assertion was reported'
  )

  const sourceHashes = Object.fromEntries(hashedSources.map((file) => [file, sha256(readFileSync(file))]))
  const receipt = {
    schema: 'metis-persistence-settlement-source-receipt/v1',
    disposition: 'EXPECTED_SETTLEMENT_RED_OWNER_VERIFIED',
    phase: 'settlement-red-with-owner',
    commit: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    target: process.env.PERSISTENCE_SETTLEMENT_TARGET,
    node: process.version,
    vitestExitCode: 1,
    reportSha256: sha256(bytes),
    unhandledReportSha256: sha256(unhandledBytes),
    unhandledReporterCount: unhandledReport.unhandledCount,
    sourceHashes,
    counts: {
      total: report.numTotalTests,
      passed: report.numPassedTests,
      failed: report.numFailedTests,
      pending: report.numPendingTests,
      todo: report.numTodoTests,
      files: report.testResults.length,
      recursiveSuites: report.numTotalTestSuites,
      unhandled: 0
    },
    cases: cases.map((entry) => ({ file: entry.file, title: entry.title, status: entry.expected }))
  }
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log(
    'persistence-settlement:EXPECTED_SETTLEMENT_RED_OWNER_VERIFIED 20 cases; 14 passed; 6 named settlement failures'
  )
  console.log(`persistence-settlement:REPORT_SHA256 ${receipt.reportSha256}`)
}

try {
  validate()
} catch (error) {
  console.error(error instanceof Error ? error.message : 'persistence-settlement-report:validation failed')
  process.exitCode = 1
}
