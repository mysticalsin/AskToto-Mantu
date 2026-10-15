import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const requiredFiles = [
  'src/main/persistence/bootstrap-main-factory.integration.test.ts',
  'src/main/persistence/root-registry.test.ts',
  'src/main/persistence/protected-meeting-keys.test.ts',
  'src/main/persistence/legacy-file-key.test.ts'
]
const requiredSuites = new Map([
  [requiredFiles[0], 'main persistence factory source fixture'],
  [requiredFiles[1], 'persistence root registry'],
  [requiredFiles[2], 'protected meeting-key lifecycle'],
  [requiredFiles[3], 'profile-bound legacy file-key access']
])
const hashedSources = [
  ...requiredFiles,
  'src/main/persistence/bootstrap.ts',
  'src/main/persistence/bootstrap-settlement.ts',
  'src/main/persistence/bootstrap-speech-owner.ts',
  'src/main/persistence/root-registry.ts',
  'src/main/persistence/protected-meeting-keys.ts',
  'src/main/persistence/legacy-file-key.ts',
  'src/main/infra/process/meeting-speech-host.ts',
  'src/main/meeting-speech-worker.ts',
  'src/main/features/meetings/incremental-meeting-journal.ts',
  'src/main/features/meetings/incremental-meeting-journal-files.ts',
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
    expected: 'passed',
    evidence: 'F05'
  },
  {
    file: requiredFiles[0],
    caseId: 'F06',
    title: 'retains a failed writer close across repeated journal and bootstrap disposal',
    expected: 'passed',
    evidence: 'F06'
  },
  {
    file: requiredFiles[0],
    caseId: 'F07',
    title: 'retains a failed root close across repeated journal and bootstrap disposal',
    expected: 'passed',
    evidence: 'F07'
  },
  {
    file: requiredFiles[0],
    caseId: 'F08',
    title: 'retains failed open cleanup with the original operation error',
    expected: 'passed',
    evidence: 'F08'
  },
  {
    file: requiredFiles[0],
    caseId: 'F10',
    title: 'retains the root owner when writer acquisition fails before returning a lease',
    expected: 'passed',
    evidence: 'F10'
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
    expected: 'passed',
    evidence: 'R04'
  },
  {
    file: requiredFiles[1],
    caseId: 'R05',
    title: 'keeps the writer reservation after unlink until descriptor settlement',
    expected: 'passed',
    evidence: 'R05'
  },
  {
    file: requiredFiles[1],
    caseId: 'R06',
    title: 'retains owned cleanup failure for foreign writer entries before and after lease return',
    expected: 'passed',
    evidence: 'R06'
  },
  {
    file: requiredFiles[1],
    caseId: 'R07',
    title: 'joins one failed-open root close through the captured binder capability',
    expected: 'passed',
    evidence: 'R07'
  },
  ...[
    ['P01', 'retires a held key publication permanently, then admits a live successor'],
    ['P02', 'reopen is read-only and a corrupt key record is preserved'],
    ['P03', 'fails closed when the native backend becomes unavailable and preserves the valid key record'],
    ['P04', 'does not publish a key or unlink a replacement after a held ACL proof'],
    ['P05', 'retires the original scope during a held ACL proof before any key bytes are written']
  ].map(([caseId, title]) => ({ file: requiredFiles[2], caseId, title, expected: 'passed' })),
  {
    file: requiredFiles[3],
    caseId: 'L01',
    title: 'reads only an admitted original profile, with no process-global cached key',
    expected: 'passed'
  },
  ...[
    ['K01', 'joins protected key admission before disposing the key owner', 'passed'],
    ['K02', 'keeps protected key disposal pending while the admitted callback is held', 'passed'],
    ['K03', 'joins protected key post-use checks and wipes before disposal completes', 'passed'],
    ['K04', 'disposes a protected key after a physically completed callback refusal', 'passed'],
    ['K05', 'joins legacy key admission before disposing the key owner', 'passed'],
    ['K06', 'keeps legacy key disposal pending while the admitted callback is held', 'passed'],
    ['K07', 'joins legacy key post-use checks and wipes before disposal completes', 'passed'],
    ['K08', 'disposes a legacy key after a physically completed callback refusal', 'passed'],
    ['K09', 'cleans a constructed journal store when the key post-use guard rejects', 'passed'],
    ['K10', 'retains the constructed journal store until successful owner handoff', 'passed']
  ].map(([caseId, title, expected]) => ({
    file:
      caseId === 'K09' || caseId === 'K10'
        ? requiredFiles[0]
        : ['K01', 'K02', 'K03', 'K04'].includes(caseId)
          ? requiredFiles[2]
          : requiredFiles[3],
    caseId,
    title,
    expected,
    evidence: caseId
  }))
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
    info = lstatSync(absolute)
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
    requireValue(payload.length > 0 && Buffer.byteLength(line, 'utf8') + 1 <= 4096, 'case evidence size is invalid')
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
        causeEvidence.keySettlementAttemptsAfterDisposal === 1 &&
        causeEvidence.journalOutcome?.status === 'rejected' &&
        causeEvidence.journalOutcome.errorMessage?.includes('injected protected-key settlement failure') &&
        causeEvidence.journalMemoized === true &&
        causeEvidence.successorAdmitted === false &&
        causeEvidence.successorOutcome?.status === 'rejected' &&
        causeEvidence.disposalMemoized === true &&
        causeEvidence.disposalOutcome?.status === 'rejected' &&
        causeEvidence.disposalOutcome.errorMessage?.includes('injected protected-key settlement failure'),
      'F05 did not retain the failed key settlement and parent ownership'
    )
  } else if (assertion.caseId === 'F06') {
    requireValue(
      causeEvidence.writerCloseAttemptsBeforeSuccessor === 1 &&
        causeEvidence.writerCloseAttemptsAfterDisposal === 1 &&
        causeEvidence.journalOutcome?.status === 'rejected' &&
        causeEvidence.journalOutcome.errorMessage?.includes('injected writer descriptor close failure') &&
        causeEvidence.journalMemoized === true &&
        causeEvidence.successorAdmitted === false &&
        causeEvidence.successorOutcome?.status === 'rejected' &&
        causeEvidence.disposalMemoized === true &&
        causeEvidence.disposalOutcome?.status === 'rejected' &&
        causeEvidence.disposalOutcome.errorMessage?.includes('injected writer descriptor close failure'),
      'F06 did not retain the failed writer close and parent ownership'
    )
  } else if (assertion.caseId === 'F07') {
    requireValue(
      causeEvidence.rootCloseAttemptsBeforeSuccessor === 1 &&
        causeEvidence.rootCloseAttemptsAfterDisposal === 1 &&
        causeEvidence.journalOutcome?.status === 'rejected' &&
        causeEvidence.journalOutcome.errorMessage?.includes('injected root descriptor close failure') &&
        causeEvidence.journalMemoized === true &&
        causeEvidence.successorAdmitted === false &&
        causeEvidence.successorOutcome?.status === 'rejected' &&
        causeEvidence.disposalMemoized === true &&
        causeEvidence.disposalOutcome?.status === 'rejected' &&
        causeEvidence.disposalOutcome.errorMessage?.includes('injected root descriptor close failure'),
      'F07 did not retain one injected root-close failure through journal and disposal rejection'
    )
  } else if (assertion.caseId === 'F08') {
    requireValue(
      causeEvidence.writerCloseAttemptsBeforeDisposal === 1 &&
        causeEvidence.writerCloseAttemptsAfterDisposal === 1 &&
        causeEvidence.openingOutcome?.status === 'rejected' &&
        causeEvidence.openingOutcome.errorName === 'AggregateError' &&
        Array.isArray(causeEvidence.aggregateMessages) &&
        JSON.stringify(causeEvidence.aggregateMessages) ===
          JSON.stringify(['injected native key wrapping failure', 'injected partial-open writer close failure']) &&
        causeEvidence.successorAdmitted === false &&
        causeEvidence.successorOutcome?.status === 'rejected' &&
        /descriptor limit/i.test(causeEvidence.successorOutcome.errorMessage ?? '') &&
        causeEvidence.disposalOutcome?.status === 'rejected' &&
        causeEvidence.disposalOutcome.errorName === 'AggregateError' &&
        Array.isArray(causeEvidence.disposalOutcome.aggregateMessages) &&
        causeEvidence.disposalOutcome.aggregateMessages.length > 0 &&
        causeEvidence.disposalOutcome.aggregateMessages.length <= 4 &&
        causeEvidence.disposalOutcome.aggregateMessages.every(
          (value) => typeof value === 'string' && value.length <= 240
        ) &&
        causeEvidence.disposalOutcome.aggregateMessages.includes('injected partial-open writer close failure'),
      'F08 did not retain original native-wrap and writer-close failures with root capacity and disposal rejection'
    )
  } else if (assertion.caseId === 'F10') {
    requireEvidenceKeys(causeEvidence, ['confirmedClose', 'failedClose'], 'F10')
    const subcaseKeys = [
      'primeReady',
      'realOpenObserved',
      'writeHandleMatchesOpen',
      'closeHandleMatchesOpen',
      'writeFaultCount',
      'writerLeaseFulfillments',
      'keyWrapsBeforePostSuccessor',
      'openingStatusWhileCloseHeld',
      'openingOutcome',
      'openingAggregateMessages',
      'originalErrorIdentity',
      'cleanupErrorIdentity',
      'originalRootClosesWhileWriterHeld',
      'originalRootClosesBeforePostSuccessor',
      'originalRootClosesBeforeDisposal',
      'originalRootClosesAfterDisposal',
      'heldSuccessorOutcome',
      'heldSuccessorAdmitted',
      'postSuccessorOutcome',
      'postSuccessorAdmitted',
      'postSuccessorSettlement',
      'writerClosesBeforePostSuccessor',
      'writerClosesBeforeDisposal',
      'writerClosesAfterDisposal',
      'disposalOutcome',
      'disposalMemoized',
      'disposalSameRejection'
    ]
    const control = causeEvidence.confirmedClose
    const failure = causeEvidence.failedClose
    for (const [name, item] of [
      ['confirmedClose', control],
      ['failedClose', failure]
    ]) {
      requireValue(item && typeof item === 'object' && !Array.isArray(item), `F10/${name} is not a closed subrecord`)
      requireValue(
        Object.keys(item).sort().join(',') === subcaseKeys.slice().sort().join(','),
        `F10/${name} fields differ from the closed schema`
      )
      requireValue(
        item.primeReady === true &&
          item.realOpenObserved === true &&
          item.writeHandleMatchesOpen === true &&
          item.closeHandleMatchesOpen === true &&
          item.writeFaultCount === 1 &&
          item.writerLeaseFulfillments === 0 &&
          item.keyWrapsBeforePostSuccessor === 0 &&
          item.originalErrorIdentity === true &&
          item.writerClosesBeforePostSuccessor === 1 &&
          item.writerClosesBeforeDisposal === 1 &&
          item.writerClosesAfterDisposal === 1 &&
          item.disposalMemoized === true &&
          Array.isArray(item.openingAggregateMessages) &&
          item.openingAggregateMessages.length <= 4 &&
          item.openingAggregateMessages.every((value) => typeof value === 'string' && value.length <= 120),
        `F10/${name} did not reach one real delegated writer fault with stable ownership observations`
      )
      const exactOutcome = (value, keys) =>
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(value).sort().join(',') === keys.slice().sort().join(',')
      requireValue(
        exactOutcome(
          item.openingOutcome,
          name === 'failedClose'
            ? ['status', 'errorName', 'errorMessage', 'aggregateMessages']
            : ['status', 'errorName', 'errorMessage']
        ) &&
          (item.heldSuccessorOutcome === null ||
            exactOutcome(item.heldSuccessorOutcome, ['status', 'errorName', 'errorMessage'])) &&
          exactOutcome(
            item.postSuccessorOutcome,
            item.postSuccessorAdmitted ? ['status'] : ['status', 'errorName', 'errorMessage']
          ) &&
          exactOutcome(
            item.disposalOutcome,
            name === 'failedClose' ? ['status', 'errorName', 'errorMessage', 'aggregateMessages'] : ['status']
          ) &&
          (item.postSuccessorSettlement === null || exactOutcome(item.postSuccessorSettlement, ['status'])),
        `F10/${name} nested outcome fields differ from the closed GREEN schema`
      )
    }
    requireValue(
      control.openingOutcome?.status === 'rejected' &&
        control.openingOutcome.errorName === 'Error' &&
        control.openingOutcome.errorMessage === 'injected unreturned-writer write failure' &&
        control.openingAggregateMessages.length === 0 &&
        control.cleanupErrorIdentity === false &&
        control.originalRootClosesBeforePostSuccessor === 1 &&
        control.originalRootClosesBeforeDisposal === 1 &&
        control.originalRootClosesAfterDisposal === 1 &&
        control.heldSuccessorOutcome === null &&
        control.heldSuccessorAdmitted === null &&
        control.postSuccessorOutcome?.status === 'fulfilled' &&
        control.postSuccessorAdmitted === true &&
        control.postSuccessorSettlement?.status === 'fulfilled' &&
        control.disposalOutcome?.status === 'fulfilled' &&
        control.disposalSameRejection === false,
      'F10 confirmed-close control did not release the original root after its real writer close'
    )
    requireValue(
      failure.openingStatusWhileCloseHeld === 'pending' &&
        failure.originalRootClosesWhileWriterHeld === 0 &&
        failure.heldSuccessorOutcome?.status === 'rejected' &&
        /descriptor limit/i.test(failure.heldSuccessorOutcome.errorMessage ?? '') &&
        failure.heldSuccessorAdmitted === false &&
        failure.openingOutcome?.status === 'rejected' &&
        failure.openingOutcome.errorName === 'AggregateError' &&
        JSON.stringify(failure.openingAggregateMessages) ===
          JSON.stringify(['injected unreturned-writer write failure', 'injected unreturned-writer close failure']) &&
        JSON.stringify(failure.openingOutcome.aggregateMessages) ===
          JSON.stringify(['injected unreturned-writer write failure', 'injected unreturned-writer close failure']) &&
        failure.cleanupErrorIdentity === true &&
        failure.originalRootClosesBeforePostSuccessor === 0 &&
        failure.postSuccessorOutcome?.status === 'rejected' &&
        failure.postSuccessorOutcome.errorName === 'Error' &&
        /descriptor limit/i.test(failure.postSuccessorOutcome.errorMessage ?? '') &&
        failure.postSuccessorAdmitted === false &&
        failure.postSuccessorSettlement === null &&
        failure.originalRootClosesBeforeDisposal === 0 &&
        failure.originalRootClosesAfterDisposal === 0 &&
        failure.disposalOutcome?.status === 'rejected' &&
        failure.disposalOutcome.errorName === 'AggregateError' &&
        Array.isArray(failure.disposalOutcome.aggregateMessages) &&
        failure.disposalOutcome.aggregateMessages.length > 0 &&
        failure.disposalOutcome.aggregateMessages.length <= 4 &&
        failure.disposalOutcome.aggregateMessages.every((value) => typeof value === 'string' && value.length <= 240) &&
        failure.disposalOutcome.aggregateMessages.includes('injected unreturned-writer close failure') &&
        failure.disposalSameRejection === true &&
        failure.heldSuccessorOutcome.errorName === 'Error',
      'F10 did not retain the original and failed-close causes with the original root and successor capacity'
    )
  } else if (assertion.caseId === 'R04') {
    requireValue(
      causeEvidence.failedOpenCloseAttempts === 1 &&
        causeEvidence.gatewayRejected === true &&
        causeEvidence.successorAdmitted === false &&
        causeEvidence.successorOutcome?.status === 'rejected' &&
        /descriptor limit/i.test(causeEvidence.successorOutcome.errorMessage ?? ''),
      'R04 did not retain failed-open root capacity after the close error'
    )
  } else if (assertion.caseId === 'R05') {
    requireValue(
      causeEvidence.closeAttempts === 1 &&
        causeEvidence.reopenedCapability === true &&
        causeEvidence.maxHeldRoots > 2 &&
        causeEvidence.heldOriginalAdmitted === false &&
        causeEvidence.heldReopenedAdmitted === false &&
        causeEvidence.failedOriginalAdmitted === false &&
        causeEvidence.failedReopenedAdmitted === false,
      'R05 did not retain physical-root writer exclusion through both capabilities'
    )
  } else if (assertion.caseId === 'R06') {
    requireEvidenceKeys(causeEvidence, ['cases'], 'R06')
    requireValue(
      Array.isArray(causeEvidence.cases) && causeEvidence.cases.length === 4,
      'R06 must contain four ordered subcases'
    )
    const ids = ['returned-owned', 'returned-foreign', 'prereturn-owned', 'prereturn-foreign']
    const exactKeys = (value, keys) =>
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === keys.slice().sort().join(',')
    for (const [index, item] of causeEvidence.cases.entries()) {
      requireValue(
        exactKeys(item, ['id', 'boundary', 'entry', 'settlement', 'root']),
        `R06/${ids[index]} fields are invalid`
      )
      requireValue(item.id === ids[index], 'R06 subcase order differs from the fixed roster')
      requireValue(
        exactKeys(item.boundary, ['exclusive', 'writeCalls', 'writeFaults', 'leases', 'sameHandle', 'named']),
        `R06/${item.id} boundary fields are invalid`
      )
      requireValue(
        exactKeys(item.entry, ['foreignSurvived', 'originalSurvived', 'lockAbsent']),
        `R06/${item.id} entry fields are invalid`
      )
      requireValue(
        exactKeys(item.settlement, [
          'status',
          'originalError',
          'cleanupError',
          'aggregate',
          'repeat',
          'closes',
          'confirmed',
          'extraIo'
        ]),
        `R06/${item.id} settlement fields are invalid`
      )
      requireValue(
        exactKeys(item.root, [
          'heldProbe',
          'status',
          'sameCleanupError',
          'repeat',
          'closes',
          'extraIo',
          'postProbe',
          'successorSettled'
        ]),
        `R06/${item.id} root fields are invalid`
      )
      const preReturn = item.id.startsWith('prereturn')
      const foreign = item.id.endsWith('foreign')
      const smallCounters = [
        item.boundary.writeCalls,
        item.boundary.writeFaults,
        item.boundary.leases,
        item.settlement.confirmed,
        item.settlement.extraIo,
        item.root.extraIo,
        ...(Array.isArray(item.settlement.closes) ? item.settlement.closes : []),
        ...(Array.isArray(item.root.closes) ? item.root.closes : [])
      ]
      requireValue(
        smallCounters.every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 8),
        `R06/${item.id} counters exceed the finite schema`
      )
      requireValue(
        item.boundary.exclusive === true &&
          item.boundary.writeCalls === 1 &&
          item.boundary.writeFaults === (preReturn ? 1 : 0) &&
          item.boundary.leases === (preReturn ? 0 : 1) &&
          item.boundary.sameHandle === true &&
          item.boundary.named === (foreign ? 'foreign-inode' : 'owned'),
        `R06/${item.id} did not reach the delegated matching boundary`
      )
      requireValue(
        item.entry.foreignSurvived === (foreign ? true : null) &&
          item.entry.originalSurvived === (foreign ? true : null) &&
          item.entry.lockAbsent === !foreign,
        `R06/${item.id} entry identity witness is invalid`
      )
      requireValue(
        ['fulfilled', 'rejected'].includes(item.settlement.status) &&
          typeof item.settlement.originalError === 'boolean' &&
          typeof item.settlement.cleanupError === 'boolean' &&
          (JSON.stringify(item.settlement.aggregate) === '[]' ||
            JSON.stringify(item.settlement.aggregate) === '["write","cleanup"]') &&
          ['fulfilled', 'same-rejection', 'not-applicable'].includes(item.settlement.repeat) &&
          Array.isArray(item.settlement.closes) &&
          item.settlement.closes.length === 2 &&
          item.settlement.closes[0] === 1 &&
          item.settlement.closes[1] === 1 &&
          item.settlement.confirmed === 1 &&
          item.settlement.extraIo === 0,
        `R06/${item.id} writer descriptor settlement differs`
      )
      requireValue(
        item.root.heldProbe === 'descriptor-limit' &&
          ['fulfilled', 'rejected'].includes(item.root.status) &&
          (item.root.sameCleanupError === null || typeof item.root.sameCleanupError === 'boolean') &&
          ['fulfilled', 'same-rejection'].includes(item.root.repeat) &&
          Array.isArray(item.root.closes) &&
          item.root.closes.length === 2 &&
          item.root.closes[0] === (foreign ? 0 : 1) &&
          item.root.closes[1] === (foreign ? 0 : 1) &&
          ['descriptor-limit', 'admitted', 'other'].includes(item.root.postProbe) &&
          (item.root.successorSettled === true || item.root.successorSettled === null) &&
          item.root.extraIo === 0,
        `R06/${item.id} root cleanup schema is invalid`
      )
      if (!foreign) {
        requireValue(
          item.settlement.status === (preReturn ? 'rejected' : 'fulfilled') &&
            item.settlement.originalError === preReturn &&
            item.settlement.cleanupError === false &&
            item.settlement.aggregate.length === 0 &&
            item.settlement.repeat === (preReturn ? 'not-applicable' : 'fulfilled') &&
            item.root.status === 'fulfilled' &&
            item.root.sameCleanupError === null &&
            item.root.repeat === 'fulfilled' &&
            item.root.postProbe === 'admitted' &&
            item.root.successorSettled === true,
          `R06/${item.id} healthy control failed`
        )
      } else {
        requireValue(
          item.settlement.status === 'rejected' &&
            item.settlement.originalError === preReturn &&
            item.settlement.cleanupError === true &&
            JSON.stringify(item.settlement.aggregate) === (preReturn ? '["write","cleanup"]' : '[]') &&
            item.settlement.repeat === (preReturn ? 'not-applicable' : 'same-rejection') &&
            item.root.status === 'rejected' &&
            item.root.sameCleanupError === true &&
            item.root.repeat === 'same-rejection' &&
            item.root.postProbe === 'descriptor-limit' &&
            item.root.successorSettled === null,
          `R06/${item.id} did not retain observed foreign-entry cleanup failure`
        )
      }
    }
  } else if (assertion.caseId === 'R07') {
    requireEvidenceKeys(causeEvidence, ['confirmedClose', 'failedClose'], 'R07')
    const expectedFields = [
      'captured',
      'sameHandle',
      'maxRoots',
      'openingAtHold',
      'heldProbe',
      'publicAtHold',
      'closeAttempts',
      'confirmed',
      'openingOriginalError',
      'openingCleanupError',
      'openingAggregate',
      'publicOutcomes',
      'samePublicError',
      'firstCloseError',
      'repeatExtraIo',
      'postProbe',
      'successorSettled'
    ]
    for (const id of ['confirmedClose', 'failedClose']) {
      const item = causeEvidence[id]
      requireValue(
        item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          Object.keys(item).sort().join(',') === expectedFields.slice().sort().join(','),
        `R07/${id} fields differ from the closed schema`
      )
      requireValue(
        item.captured === true &&
          item.sameHandle === true &&
          item.maxRoots === 1 &&
          item.openingAtHold === 'pending' &&
          item.heldProbe === 'descriptor-limit' &&
          item.openingOriginalError === true &&
          item.repeatExtraIo === 0,
        `R07/${id} did not reach the real held root boundary`
      )
      const smallCounters = [
        ...(Array.isArray(item.closeAttempts) ? item.closeAttempts : []),
        item.confirmed,
        item.repeatExtraIo
      ]
      requireValue(
        smallCounters.every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 8) &&
          Array.isArray(item.closeAttempts) &&
          item.closeAttempts.length === 3 &&
          item.closeAttempts.join(',') === '1,1,1' &&
          Array.isArray(item.publicAtHold) &&
          Array.isArray(item.publicOutcomes) &&
          [...item.publicAtHold, ...item.publicOutcomes].every((value) =>
            ['pending', 'fulfilled', 'rejected'].includes(value)
          ) &&
          (JSON.stringify(item.openingAggregate) === '[]' ||
            JSON.stringify(item.openingAggregate) === '["bind","close"]') &&
          ['descriptor-limit', 'admitted', 'other'].includes(item.postProbe) &&
          (item.successorSettled === true || item.successorSettled === null),
        `R07/${id} counters, enums, or outcome arrays are invalid`
      )
    }
    const control = causeEvidence.confirmedClose
    const failure = causeEvidence.failedClose
    requireValue(
      control.publicAtHold.length === 0 &&
        control.closeAttempts.join(',') === '1,1,1' &&
        control.confirmed === 1 &&
        control.openingCleanupError === false &&
        control.openingAggregate.length === 0 &&
        control.publicOutcomes.join(',') === 'fulfilled,fulfilled' &&
        control.samePublicError === false &&
        control.firstCloseError === false &&
        control.postProbe === 'admitted' &&
        control.successorSettled === true,
      'R07 confirmed-close control failed'
    )
    requireValue(
      failure.publicAtHold.join(',') === 'pending,pending' &&
        failure.closeAttempts.join(',') === '1,1,1' &&
        failure.confirmed === 0 &&
        failure.openingCleanupError === true &&
        failure.openingAggregate.join(',') === 'bind,close' &&
        failure.publicOutcomes.join(',') === 'rejected,rejected,rejected,rejected' &&
        failure.samePublicError === true &&
        failure.firstCloseError === true &&
        failure.postProbe === 'descriptor-limit' &&
        failure.successorSettled === null,
      'R07 did not retain one memoized failed-open close dependency'
    )
  }
}

function closedObject(value, keys, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} is not an object`)
  requireValue(
    Object.keys(value).sort().join(',') === [...keys].sort().join(','),
    `${label} fields differ from the closed schema`
  )
}

function validateK1Evidence(witness) {
  const id = witness.caseId
  const protectedIds = new Set(['K01', 'K02', 'K03', 'K04'])
  if (['K01', 'K02', 'K03', 'K04', 'K05', 'K06', 'K07', 'K08'].includes(id)) {
    closedObject(
      witness,
      ['caseId', 'stage', 'keyReady', 'physical', 'observed', 'settled', 'postUseBorrowAtDisposal', 'parents'],
      id
    )
    closedObject(witness.physical, ['rawMatchesRoot', 'realStatCompleted', 'held', 'entries'], `${id}.physical`)
    closedObject(
      witness.observed,
      ['operation', 'callbackCalls', 'callbackCompleted', 'borrow', 'disposals', 'checkpoint'],
      `${id}.observed`
    )
    closedObject(
      witness.settled,
      [
        'use',
        'originalCallbackError',
        'callbackCalls',
        'borrow',
        'disposals',
        'repeat',
        'lateUse',
        'lateCallbackCalls',
        'extraPhysicalChecks'
      ],
      `${id}.settled`
    )
    closedObject(
      witness.parents,
      ['writerCloseAttempts', 'writerCloseConfirmed', 'rootCloseAttempts', 'rootCloseConfirmed'],
      `${id}.parents`
    )
    const admission = id === 'K01' || id === 'K05'
    const callback = id === 'K02' || id === 'K06'
    const postUse = id === 'K03' || id === 'K07'
    const refusal = id === 'K04' || id === 'K08'
    const observedDisposals = refusal ? ['fulfilled', 'fulfilled'] : ['pending', 'pending']
    requireValue(
      witness.stage === (admission ? 'admission' : callback ? 'callback' : postUse ? 'post-use' : 'completed-refusal'),
      `${id} stage is invalid`
    )
    requireValue(
      witness.keyReady === true &&
        witness.physical.rawMatchesRoot === true &&
        witness.physical.realStatCompleted === true &&
        witness.physical.held === (admission || postUse) &&
        witness.physical.entries === (admission || postUse ? 1 : 0),
      `${id} physical gate evidence is invalid`
    )
    requireValue(
      witness.observed.operation === (refusal ? 'rejected' : 'pending') &&
        witness.observed.callbackCalls === (admission ? 0 : 1) &&
        witness.observed.callbackCompleted === (postUse || refusal) &&
        witness.observed.borrow === (admission ? 'absent' : refusal ? 'zero' : 'nonzero') &&
        JSON.stringify(witness.observed.disposals) === JSON.stringify(observedDisposals) &&
        witness.observed.checkpoint === true,
      `${id} pending observation differs from the fixed GREEN schedule`
    )
    requireValue(
      witness.settled.use === (refusal ? 'callback-error' : 'retired') &&
        witness.settled.originalCallbackError === refusal &&
        witness.settled.callbackCalls === (admission ? 0 : 1) &&
        witness.settled.borrow === (admission ? 'absent' : 'zero') &&
        JSON.stringify(witness.settled.disposals) === '["fulfilled","fulfilled"]' &&
        witness.settled.repeat === 'fulfilled' &&
        witness.settled.lateUse === 'retired' &&
        witness.settled.lateCallbackCalls === 0 &&
        witness.settled.extraPhysicalChecks === 0,
      `${id} joined lifecycle evidence differs from the fixed GREEN schedule`
    )
    requireValue(
      witness.postUseBorrowAtDisposal === (postUse ? 'zero' : null),
      `${id} borrow-at-disposal observation is invalid`
    )
    requireValue(
      witness.parents.writerCloseAttempts === (protectedIds.has(id) ? 1 : 0) &&
        witness.parents.writerCloseConfirmed === (protectedIds.has(id) ? 1 : 0) &&
        witness.parents.rootCloseAttempts === 1 &&
        witness.parents.rootCloseConfirmed === 1,
      `${id} parent custody counters are invalid`
    )
    for (const count of [
      witness.physical.entries,
      witness.observed.callbackCalls,
      witness.settled.callbackCalls,
      witness.settled.lateCallbackCalls,
      witness.settled.extraPhysicalChecks,
      ...Object.values(witness.parents)
    ])
      requireValue(integer(count) && count <= 8, `${id} contains an invalid bounded counter`)
    return
  }
  if (id === 'K09') {
    closedObject(witness, ['caseId', 'physical', 'store', 'opening', 'parents', 'bootstrap'], id)
    closedObject(witness.physical, ['rawMatchesRoot', 'realStatCompleted', 'entries'], `${id}.physical`)
    closedObject(
      witness.store,
      [
        'constructorCalls',
        'actualObject',
        'borrowZeroAtGate',
        'initializeAtGate',
        'disposeAtGate',
        'disposeAfterOpen',
        'disposeAfterBootstrap',
        'extraDisposeAfterRepeat',
        'disposedSameObject'
      ],
      `${id}.store`
    )
    closedObject(witness.opening, ['atGate', 'outcome', 'sameError'], `${id}.opening`)
    closedObject(
      witness.parents,
      ['keySettlements', 'writerCloseAttempts', 'writerCloseConfirmed', 'rootCloseAttempts', 'rootCloseConfirmed'],
      `${id}.parents`
    )
    closedObject(
      witness.bootstrap,
      ['first', 'repeat', 'samePromise', 'workersStarted', 'workerExits'],
      `${id}.bootstrap`
    )
    requireValue(
      JSON.stringify(witness.physical) === '{"rawMatchesRoot":true,"realStatCompleted":true,"entries":1}' &&
        JSON.stringify(witness.store) ===
          '{"constructorCalls":1,"actualObject":true,"borrowZeroAtGate":true,"initializeAtGate":0,"disposeAtGate":0,"disposeAfterOpen":1,"disposeAfterBootstrap":1,"extraDisposeAfterRepeat":0,"disposedSameObject":true}' &&
        JSON.stringify(witness.opening) === '{"atGate":"pending","outcome":"original-stat-error","sameError":true}' &&
        JSON.stringify(witness.parents) ===
          '{"keySettlements":1,"writerCloseAttempts":1,"writerCloseConfirmed":1,"rootCloseAttempts":1,"rootCloseConfirmed":1}' &&
        JSON.stringify(witness.bootstrap) ===
          '{"first":"fulfilled","repeat":"fulfilled","samePromise":true,"workersStarted":1,"workerExits":1}',
      'K09 evidence differs from the fixed causal GREEN schedule'
    )
    return
  }
  if (id === 'K10') {
    closedObject(witness, ['caseId', 'physical', 'store', 'opening', 'append', 'parents', 'bootstrap', 'journal'], id)
    closedObject(witness.physical, ['rawMatchesRoot', 'realStatCompleted', 'entries'], `${id}.physical`)
    closedObject(
      witness.store,
      [
        'constructorCalls',
        'actualObject',
        'borrowZeroAtGate',
        'initializeAtGate',
        'disposeAtGate',
        'initializeAfterOpen',
        'disposeAfterOpen',
        'disposeAfterAppend',
        'disposeAfterJournal',
        'disposeAfterBootstrap',
        'extraDisposeAfterRepeat',
        'disposedSameObject'
      ],
      `${id}.store`
    )
    closedObject(witness.opening, ['atGate', 'outcome'], `${id}.opening`)
    closedObject(witness.append, ['status', 'revision'], `${id}.append`)
    closedObject(
      witness.parents,
      ['keySettlements', 'writerCloseAttempts', 'writerCloseConfirmed', 'rootCloseAttempts', 'rootCloseConfirmed'],
      `${id}.parents`
    )
    closedObject(
      witness.bootstrap,
      ['first', 'repeat', 'samePromise', 'workersStarted', 'workerExits'],
      `${id}.bootstrap`
    )
    closedObject(witness.journal, ['first', 'repeat', 'samePromise'], `${id}.journal`)
    requireValue(
      JSON.stringify(witness.physical) === '{"rawMatchesRoot":true,"realStatCompleted":true,"entries":1}' &&
        JSON.stringify(witness.store) ===
          '{"constructorCalls":1,"actualObject":true,"borrowZeroAtGate":true,"initializeAtGate":0,"disposeAtGate":0,"initializeAfterOpen":1,"disposeAfterOpen":0,"disposeAfterAppend":0,"disposeAfterJournal":1,"disposeAfterBootstrap":1,"extraDisposeAfterRepeat":0,"disposedSameObject":true}' &&
        JSON.stringify(witness.opening) === '{"atGate":"pending","outcome":"fulfilled"}' &&
        JSON.stringify(witness.append) === '{"status":"durable","revision":1}' &&
        JSON.stringify(witness.parents) ===
          '{"keySettlements":1,"writerCloseAttempts":1,"writerCloseConfirmed":1,"rootCloseAttempts":1,"rootCloseConfirmed":1}' &&
        JSON.stringify(witness.bootstrap) ===
          '{"first":"fulfilled","repeat":"fulfilled","samePromise":true,"workersStarted":1,"workerExits":1}' &&
        JSON.stringify(witness.journal) === '{"first":"fulfilled","repeat":"fulfilled","samePromise":true}',
      'K10 evidence differs from the fixed successful handoff control'
    )
    return
  }
  requireValue(false, `${id} is not a K1 witness`)
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
    process.env.PERSISTENCE_SETTLEMENT_PHASE === 'persistence-k1-green',
    'phase is not the fixed persistence-k1-green phase'
  )
  requireValue(process.env.GITHUB_SHA && /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA), 'commit identity is invalid')
  requireValue(/^\d+$/.test(process.env.GITHUB_RUN_ID ?? ''), 'run identity is invalid')
  requireValue(/^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? ''), 'run attempt is invalid')
  requireValue(process.env.PERSISTENCE_SETTLEMENT_TARGET === 'ubuntu-latest', 'source target is not pinned Ubuntu')
  requireValue(
    hashedSources.length === 23 && new Set(hashedSources).size === 23,
    'source receipt roster is not exactly 23 unique paths'
  )
  requireValue(process.env.VITEST_EXIT_CODE === '0', 'Vitest did not return the required actual K1 GREEN exit')
  requireValue(process.env.GITHUB_JOB === 'test-first', 'reporter job binding is not test-first')
  requireValue(
    process.env.PERSISTENCE_SETTLEMENT_PARENT_COMMIT === '52c97ca175fccea6db51ab01c912d46d3876d6b4',
    'reviewed parent commit binding is invalid'
  )
  requireValue(process.version === 'v22.22.3', 'Node runtime is not the pinned 22.22.3')

  let log
  try {
    const logInfo = lstatSync(resolve(logPath))
    requireValue(logInfo.isFile() && logInfo.size > 0 && logInfo.size <= 4 * 1024 * 1024, 'Vitest log size is invalid')
    log = readFileSync(resolve(logPath), 'utf8')
  } catch {
    throw new Error('persistence-settlement-report:Vitest log is missing or unreadable')
  }
  requireValue(!/unhandled errors?|unhandled rejections?/i.test(log), 'Vitest log records an unhandled error')
  const evidence = readCaseEvidence(log)
  const expectedWitnessIds = cases
    .filter((entry) => entry.evidence)
    .map((entry) => entry.evidence)
    .sort()
  const requiredWitnessIds = [
    'F02',
    'F05',
    'F06',
    'F07',
    'F08',
    'F10',
    'O01',
    'O02',
    'O03',
    'O04',
    'O05',
    'O06',
    'R04',
    'R05',
    'R06',
    'R07',
    'K01',
    'K02',
    'K03',
    'K04',
    'K05',
    'K06',
    'K07',
    'K08',
    'K09',
    'K10'
  ].sort()
  requireValue(
    expectedWitnessIds.join(',') === requiredWitnessIds.join(','),
    'closed case inventory does not produce the exact twenty-six-witness roster'
  )
  requireValue(
    evidence.size === requiredWitnessIds.length && requiredWitnessIds.every((caseId) => evidence.has(caseId)),
    'actual evidence does not contain exactly the twenty-six unique closed witnesses'
  )
  for (const caseId of requiredWitnessIds.filter((id) => id.startsWith('K'))) validateK1Evidence(evidence.get(caseId))

  const { bytes, report } = readReport(reportPath)
  const { bytes: unhandledBytes, report: unhandledReport } = readUnhandledReport(unhandledReportPath)
  requireValue(report.success === true, 'Vitest JSON does not record the expected K1 GREEN run')
  const expectedCounters = {
    numTotalTests: 39,
    numPassedTests: 39,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTestSuites: 8,
    numPassedTestSuites: 8,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0
  }
  for (const [name, expected] of Object.entries(expectedCounters))
    requireValue(report[name] === expected, `${name} must equal ${expected}`)
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
    Array.isArray(report.testResults) && report.testResults.length === 4,
    'test file inventory is not exactly four files'
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
  requireValue(suiteTitles.size === 4, 'recursive describe inventory is not exactly four groups')
  requireValue(
    report.testResults.length + suiteTitles.size === report.numTotalTestSuites,
    'recursive suite total is not eight'
  )
  requireValue(actualCases.size === cases.length && cases.length === 39, 'actual assertion count is not thirty-nine')

  for (const expected of cases) {
    const found = actualCases.get(expected.title)
    requireValue(found && found.file === expected.file, `case inventory differs: ${expected.title}`)
    requireValue(found.assertion.status === expected.expected, `unexpected status for ${expected.title}`)
    const failures = found.assertion.failureMessages
    requireValue(Array.isArray(failures), `failure-message array is missing for ${expected.title}`)
    if (expected.expected === 'passed')
      requireValue(failures.length === 0, `passing case has failure messages: ${expected.title}`)
    else requireValue(false, `unexpected failure in the fixed GREEN run: ${expected.title}`)
    if (expected.evidence) validateStructuredEvidence(evidence, expected)
  }
  for (const file of requiredFiles) {
    const result = files.get(file)
    const expectedFileStatus = 'passed'
    requireValue(result.status === expectedFileStatus, `file suite status differs from the fixed GREEN run for ${file}`)
  }
  requireValue(
    [...actualCases.keys()].every((title) => cases.some((entry) => entry.title === title)),
    'unexpected assertion was reported'
  )

  const logBytes = readFileSync(resolve(logPath))
  const sourceHashes = Object.fromEntries(hashedSources.map((file) => [file, sha256(readFileSync(file))]))
  const receipt = {
    schema: 'metis-persistence-k1-source-receipt/v1',
    disposition: 'K1_GREEN_COMPLETE_KEY_USE',
    phase: 'persistence-k1-green',
    parentCommit: process.env.PERSISTENCE_SETTLEMENT_PARENT_COMMIT,
    commit: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    job: process.env.GITHUB_JOB,
    target: process.env.PERSISTENCE_SETTLEMENT_TARGET,
    node: process.version,
    vitestExitCode: Number(process.env.VITEST_EXIT_CODE),
    reportSha256: sha256(bytes),
    logSha256: sha256(logBytes),
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
    cases: cases.map((entry) => ({
      caseId: entry.caseId,
      file: entry.file,
      title: entry.title,
      status: entry.expected
    })),
    witnessIds: requiredWitnessIds
  }
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log('persistence-settlement:K1_GREEN_COMPLETE_KEY_USE 39 cases; 39 passed; 0 failed; 26 witnesses')
  console.log(`persistence-settlement:REPORT_SHA256 ${receipt.reportSha256}`)
}

try {
  validate()
} catch (error) {
  console.error(error instanceof Error ? error.message : 'persistence-settlement-report:validation failed')
  process.exitCode = 1
}
