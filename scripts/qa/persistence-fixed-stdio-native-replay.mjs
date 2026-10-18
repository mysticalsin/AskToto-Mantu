import fs from 'node:fs'
import path from 'node:path'
import {
  BASE,
  SCHEMA,
  ENTRY,
  WORKFLOW,
  IDS,
  NAMES,
  SOCKET,
  BULK,
  OP,
  PHASE,
  STATES,
  OUTCOMES,
  MAX_TOTAL,
  MAX_META,
  MAX_CASE,
  MAX_STDERR,
  MAX_PEER_OUT,
  MAX_PAYLOAD,
  MAX_ENVELOPE,
  assert,
  hash,
  digestText,
  exactKeys,
  provenance,
  sourceFence,
  hashExecutable,
  runnerDirectory,
  bindingFor,
  guardRoot,
  guardFile,
  guardClosedVersion,
  parseCustody,
  custodyText,
  readCustodyFile,
  parseAggregate,
  writeNextArtifact,
  namesFor,
  artifactLimit,
  readClosedArtifact,
  writeReplayReport,
  emitWorkflowOutputs,
  readBounded,
  replayEventShape,
  verifySourceBinding,
  verifyCaseSummary,
  verifyReplayCaseClaims,
  readFooter
} from './persistence-fixed-stdio-native-evidence.mjs'

function parseCaseReplay(id, eventBytes, checkpoint) {
  assert(eventBytes.length <= MAX_CASE, 'case raw byte budget')
  const envelopes = []
  const result = {
    envelopes,
    timeline: [],
    child: [],
    childEvents: [],
    parent: [],
    commands: [],
    acks: new Map(),
    barriers: new Map(),
    terminals: [],
    nativeStarts: new Map(),
    nativeDone: new Map(),
    childSeq: 0,
    parentSeq: 0,
    commandSeq: 0,
    ordinal: 0,
    childPhase: -1,
    finalSeen: false,
    binding: null,
    samples: []
  }
  let rawBoundary = 0
  while (rawBoundary < eventBytes.length) {
    const newline = eventBytes.indexOf(10, rawBoundary)
    assert(newline >= 0 && newline - rawBoundary + 1 <= MAX_ENVELOPE, 'case line boundary')
    assert(envelopes.length < 192, 'case envelope count')
    const wire = new TextDecoder('utf-8', { fatal: true }).decode(eventBytes.subarray(rawBoundary, newline))
    const envelope = JSON.parse(wire)
    assert(JSON.stringify(envelope) === wire, 'canonical case envelope')
    rawBoundary = newline + 1
    exactKeys(envelope, ['ordinal', 'origin', 'payload'], 'raw envelope')
    assert(envelope.ordinal === ++result.ordinal && ['parent', 'child'].includes(envelope.origin), 'raw ordinal/origin')
    assert(
      typeof envelope.payload === 'string' &&
        envelope.payload.length <= MAX_PAYLOAD &&
        Buffer.byteLength(envelope.payload) <= MAX_PAYLOAD,
      'raw payload bound'
    )
    const item = JSON.parse(envelope.payload)
    assert(JSON.stringify(item) === envelope.payload, 'canonical application payload')
    result.timeline.push({ ordinal: envelope.ordinal, origin: envelope.origin, item, bytes: rawBoundary })
    if (envelope.origin === 'child') {
      assert(!result.finalSeen, 'child record after final')
      assert(
        item &&
          item.v === 1 &&
          item.caseId === id &&
          Number.isSafeInteger(item.seq) &&
          item.seq === result.childSeq + 1,
        'child message sequence'
      )
      result.childSeq = item.seq
      if (item.kind === 'binding') {
        exactKeys(
          item,
          [
            'v',
            'kind',
            'caseId',
            'seq',
            'sourceHead',
            'entryGitSha256',
            'entryCheckoutSha256',
            'sourceSetSha256',
            'execPathSha256',
            'nodeVersion',
            'platform',
            'arch',
            'versions'
          ],
          'replay binding'
        )
        assert(item.seq === 1 && /^[0-9a-f]{40}$/.test(item.sourceHead), 'replay binding head')
        assert(
          /^[0-9a-f]{64}$/.test(item.entryGitSha256) &&
            /^[0-9a-f]{64}$/.test(item.entryCheckoutSha256) &&
            /^[0-9a-f]{64}$/.test(item.execPathSha256) &&
            /^[0-9a-f]{64}$/.test(item.sourceSetSha256),
          'replay binding hashes'
        )
        exactKeys(item.versions, ['v8', 'modules', 'uv'], 'replay versions')
        for (const value of Object.values(item.versions))
          assert(
            typeof value === 'string' && value.length <= 64 && Buffer.byteLength(value) <= 64,
            'replay version text'
          )
        result.binding = item
      } else if (item.kind === 'event') {
        replayEventShape(item, id, result.childSeq)
        if (item.op === 'api-write' && item.state === 'start')
          assert(!result.barriers.has('armed'), 'public write started after arm boundary')
        if (item.op === 'acquire') assert(!result.barriers.has('armed'), 'acquisition after arm boundary')
        if (['reader3', 'writer4'].includes(item.endpoint) && item.op !== 'acquire') {
          assert(
            result.childEvents.some(
              (prior) => prior.op === 'acquire' && prior.endpoint === item.endpoint && prior.state === 'fulfilled'
            ),
            'event before acquired endpoint'
          )
          if (item.state === 'start' || item.op === 'local-destroy')
            assert(
              !result.childEvents.some((prior) => prior.op === 'stream-close' && prior.endpoint === item.endpoint),
              'new operation after endpoint close'
            )
        }
        assert(
          SOCKET.has(id) ? !item.op.startsWith('fs-') && item.op !== 'peer-read' : item.op !== 'socket-read',
          'fixed case API family'
        )
        if (item.op === 'acquire') assert(item.phase === 'setup', 'acquisition phase')
        if (item.op === 'fs-close' && item.state === 'start')
          assert(
            !result.childEvents.some(
              (prior) => prior.op === 'fs-close' && prior.endpoint === item.endpoint && prior.state === 'start'
            ),
            'duplicate native close lifetime'
          )
        if (['fs-read', 'fs-write', 'fs-writev'].includes(item.op) && item.state === 'start')
          assert(
            !result.childEvents.some(
              (prior) =>
                prior.endpoint === item.endpoint &&
                ((prior.op === 'fs-close' && prior.state === 'start') || prior.op === 'local-destroy')
            ),
            'ordinary native operation after close or containment'
          )
        if (item.op === 'goal')
          assert(item.phase === 'goal' || (item.phase === 'setup' && item.state === 'rejected'), 'goal phase')
        if (item.op === 'local-destroy') assert(['goal', 'rescue'].includes(item.phase), 'destroy phase')
        const rank = ['setup', 'goal', 'rescue', 'finish'].indexOf(item.phase)
        assert(rank >= result.childPhase, 'child phase regression')
        result.childPhase = rank
        if (item.op.startsWith('fs-')) {
          if (item.state === 'start') {
            assert(
              item.id === result.nativeStarts.size + 1 && !result.nativeStarts.has(item.id),
              'native IDs must increase'
            )
            result.nativeStarts.set(item.id, item)
          } else if (['fulfilled', 'rejected', 'threw'].includes(item.state)) {
            const start = result.nativeStarts.get(item.id)
            assert(
              start && start.op === item.op && start.endpoint === item.endpoint && !result.nativeDone.has(item.id),
              'native completion pairing'
            )
            if (item.state === 'fulfilled' && item.op !== 'fs-close')
              assert(
                Number.isSafeInteger(start.bytes) &&
                  Number.isSafeInteger(item.bytes) &&
                  item.bytes >= 0 &&
                  item.bytes <= start.bytes,
                'native completion exceeds original request'
              )
            result.nativeDone.set(item.id, item.state)
          }
        }
        result.childEvents.push(item)
      } else if (item.kind === 'command-ack') {
        exactKeys(
          item,
          ['v', 'kind', 'caseId', 'seq', 'commandSeq', 'command', 'phase', 'lastEventSeq'],
          'command acknowledgment'
        )
        assert(
          item.commandSeq === result.acks.size + 1 &&
            item.commandSeq <= result.commands.length &&
            result.commands[item.commandSeq - 1].command === item.command &&
            item.lastEventSeq === item.seq - 1 &&
            PHASE.has(item.phase),
          'command ack identity'
        )
        result.acks.set(item.commandSeq, { ...item, ordinal: envelope.ordinal })
      } else if (['armed', 'sample', 'final'].includes(item.kind)) {
        exactKeys(item, ['v', 'kind', 'caseId', 'seq', 'phase', 'lastEventSeq'], 'replay barrier')
        assert(
          PHASE.has(item.phase) &&
            item.lastEventSeq === item.seq - 1 &&
            !result.barriers.has(item.kind) &&
            (item.kind !== 'armed' || item.phase === 'setup') &&
            (item.kind !== 'sample' || (item.phase === 'goal' && result.barriers.has('armed'))) &&
            (item.kind !== 'final' || item.phase === 'finish'),
          'barrier frontier/duplicate'
        )
        result.barriers.set(item.kind, item)
        if (item.kind === 'sample')
          result.samples.push({
            ordinal: envelope.ordinal,
            bytes: rawBoundary,
            sha256: hash(eventBytes.subarray(0, rawBoundary))
          })
        if (item.kind === 'final') result.finalSeen = true
      } else throw new Error('replay child record kind')
      if (typeof item.phase === 'string') {
        const rank = ['setup', 'goal', 'rescue', 'finish'].indexOf(item.phase)
        assert(rank >= result.childPhase, 'child ACK/barrier/event phase regression')
        result.childPhase = rank
      }
      assert(result.binding || item.kind === 'binding', 'child binding is not first')
      result.child.push(item)
    } else {
      if (item.kind === 'command') {
        exactKeys(item, ['v', 'kind', 'caseId', 'seq', 'command'], 'replay command')
        assert(
          item.v === 1 &&
            item.caseId === id &&
            item.seq === result.commandSeq + 1 &&
            [
              'begin',
              'arm',
              'goal',
              'peer-closed',
              'rescue-destroy',
              'rescue-drain',
              'rescue-input-eof',
              'finish'
            ].includes(item.command),
          'command sequence/enum'
        )
        result.commandSeq = item.seq
        result.commands.push(item)
      } else if (item.kind === 'parent') {
        exactKeys(
          item,
          [
            'v',
            'kind',
            'caseId',
            'seq',
            'phase',
            'op',
            'endpoint',
            'id',
            'state',
            'bytes',
            'dataSha256',
            'result',
            'error',
            'childSeq'
          ],
          'replay parent event'
        )
        replayEventShape(item, id, result.parentSeq + 1, 'parent')
        if (item.op === 'peer-pause') assert(item.phase === 'setup', 'pause phase')
        if (item.op === 'peer-resume' || item.op === 'infra-term') assert(item.phase === 'rescue', 'rescue phase')
        assert(item.childSeq === (result.childSeq || null), 'parent child frontier')
        assert(['reader3', 'writer4', 'ipc', 'process', 'none'].includes(item.endpoint), 'parent endpoint')
        assert(Number.isSafeInteger(item.id) && item.id >= 0 && item.id <= 32, 'parent id')
        assert(
          item.bytes === null || (Number.isSafeInteger(item.bytes) && item.bytes >= 0 && item.bytes <= 524288),
          'parent byte count'
        )
        assert(item.dataSha256 === null || /^[0-9a-f]{64}$/.test(item.dataSha256), 'parent digest')
        assert(item.result === null || typeof item.result === 'boolean', 'parent result')
        if (item.error !== null)
          exactKeys(item.error, ['name', 'code', 'syscall', 'errno', 'messageSha256'], 'parent error')
        result.parentSeq = item.seq
        result.parent.push(item)
      } else if (item.kind === 'process-terminal') {
        exactKeys(item, ['v', 'kind', 'caseId', 'seq', 'event', 'code', 'signal'], 'process terminal')
        assert(
          item.v === 1 &&
            item.caseId === id &&
            item.seq === result.parentSeq + 1 &&
            ['exit', 'close'].includes(item.event),
          'process terminal sequence'
        )
        assert(item.code === null || Number.isSafeInteger(item.code), 'process terminal code')
        assert(
          item.signal === null ||
            (typeof item.signal === 'string' && item.signal.length <= 16 && Buffer.byteLength(item.signal) <= 16),
          'process signal'
        )
        result.parentSeq = item.seq
        assert(!result.terminals.some((entry) => entry.event === item.event), 'duplicate process terminal')
        result.terminals.push(item)
      } else throw new Error('replay parent record kind')
    }
    envelopes.push(envelope)
    checkpoint.ordinal = result.ordinal
    checkpoint.bytes = rawBoundary
    checkpoint.sha256 = hash(eventBytes.subarray(0, rawBoundary))
  }
  assert(result.child.length <= 128 && result.commands.length <= 12 && envelopes.length <= 192, 'case record count')
  assert(result.child.filter((item) => item.kind === 'binding').length <= 1, 'binding duplicate')
  assert(result.nativeStarts.size <= 32, 'native operation cap')
  assert(result.acks.size <= 12, 'command acknowledgement cap')
  const exit = result.terminals.find((item) => item.event === 'exit')
  const close = result.terminals.find((item) => item.event === 'close')
  if (exit && close)
    assert(
      exit.code === close.code &&
        exit.signal === close.signal &&
        result.terminals.indexOf(exit) < result.terminals.indexOf(close),
      'process exit/close mismatch'
    )
  return result
}

function pairWrites(rows, origin) {
  const pairs = new Map()
  for (const row of rows.filter((item) => item.op === 'api-write')) {
    assert([1, 2].includes(row.id), 'public write id')
    if (row.state === 'start') {
      assert(!pairs.has(row.id) && pairs.size < 2, 'duplicate public write start')
      pairs.set(row.id, { start: row, observed: null, terminal: null })
      continue
    }
    const pair = pairs.get(row.id)
    assert(pair, 'public write without start')
    if (row.state === 'observed') {
      assert(!pair.observed && !pair.terminal?.state?.includes('threw'), 'duplicate write return')
      pair.observed = row
    } else {
      assert(!pair.terminal, 'duplicate write terminal')
      pair.terminal = row
      if (row.state !== 'threw')
        assert(
          row.bytes === pair.start.bytes && row.dataSha256 === pair.start.dataSha256,
          'original write callback bytes'
        )
    }
  }
  for (const [id, pair] of pairs) {
    const value =
      origin === 'child'
        ? id === 1
          ? Buffer.from([0x62])
          : Buffer.alloc(524288, 0xa5)
        : Buffer.from([id === 1 ? 0x61 : 0x63])
    assert(pair.start.bytes === value.length && pair.start.dataSha256 === hash(value), 'original public write input')
    if (pair.terminal?.state === 'threw') assert(!pair.observed, 'throw had Boolean return')
    if (pair.terminal && pair.terminal.state !== 'threw') assert(pair.observed, 'callback without write return')
  }
  return pairs
}

function validateCaseTimeline(id, raw) {
  const timeline = raw.timeline
  const at = (predicate) => timeline.find(({ item, origin }) => predicate(item, origin))?.ordinal ?? null
  const count = (predicate) => timeline.filter(({ item, origin }) => predicate(item, origin)).length
  const beginAt = at((item, origin) => origin === 'parent' && item.kind === 'command' && item.command === 'begin')
  const bindingAt = at((item, origin) => origin === 'child' && item.kind === 'binding')
  if (beginAt !== null) assert(bindingAt !== null && bindingAt < beginAt, 'begin before child binding')
  const acquired = raw.childEvents.filter((item) => item.op === 'acquire')
  assert(
    acquired.filter((item) => item.endpoint === 'reader3').length <= 1 &&
      acquired.filter((item) => item.endpoint === 'writer4').length <= 1,
    'unique acquisitions'
  )
  if (acquired.some((item) => item.endpoint === 'writer4'))
    assert(acquired[0]?.endpoint === 'reader3' && acquired[0].state === 'fulfilled', 'acquisition order')
  const rejected = acquired.find((item) => item.state === 'rejected')
  if (rejected)
    assert(
      !raw.barriers.has('armed') &&
        !raw.barriers.has('sample') &&
        !raw.childEvents.some((item) => item.op === 'goal' && item.state === 'start'),
      'rejected acquisition claimed goal'
    )
  const childRecord = (op, endpoint, state) =>
    raw.childEvents.find((item) => item.op === op && item.endpoint === endpoint && item.state === state)
  const bulkStart = raw.childEvents.find((item) => item.op === 'api-write' && item.id === 2 && item.state === 'start')
  const bulkTerminal = raw.childEvents.find(
    (item) => item.op === 'api-write' && item.id === 2 && ['fulfilled', 'rejected', 'threw'].includes(item.state)
  )
  const pendingAt = (operations, endpoint, boundary, since = 0) =>
    raw.childEvents.some(
      (start) =>
        operations.includes(start.op) &&
        start.endpoint === endpoint &&
        start.state === 'start' &&
        start.seq > since &&
        start.seq < (bulkTerminal?.seq ?? Infinity) &&
        start.seq < boundary &&
        !raw.childEvents.some(
          (end) =>
            end.op === start.op &&
            end.id === start.id &&
            ['fulfilled', 'rejected', 'threw'].includes(end.state) &&
            end.seq < boundary
        )
    )
  const pendingSecondReadAt = (boundaries) => {
    const first = raw.childEvents.find(
      (item) =>
        item.op === 'fs-read' &&
        item.endpoint === 'reader3' &&
        item.state === 'fulfilled' &&
        item.bytes === 1 &&
        item.dataSha256 === hash(Buffer.from([0x61]))
    )
    return Boolean(
      first &&
        raw.childEvents.some(
          (start) =>
            start.op === 'fs-read' &&
            start.endpoint === 'reader3' &&
            start.state === 'start' &&
            start.seq > first.seq &&
            boundaries.every(
              (boundary) =>
                start.seq < boundary &&
                !raw.childEvents.some(
                  (done) =>
                    done.op === 'fs-read' &&
                    done.id === start.id &&
                    ['fulfilled', 'rejected', 'threw'].includes(done.state) &&
                    done.seq < boundary
                )
            )
        )
    )
  }
  const armed = raw.barriers.get('armed')
  const armCommand = raw.commands.find((item) => item.command === 'arm')
  const armCommandAt = at((item) => item === armCommand)
  const armAck = [...raw.acks.values()].find((item) => item.command === 'arm')
  const armedAt = at((item, origin) => origin === 'child' && item.kind === 'armed')
  const pauseAt = at((item, origin) => origin === 'parent' && item.op === 'peer-pause')
  if (bulkStart)
    assert(
      BULK.has(id) &&
        armAck &&
        armAck.ordinal < at((item) => item === bulkStart) &&
        pauseAt !== null &&
        pauseAt < at((item) => item === bulkStart),
      'bulk public write before pause or arm admission'
    )
  const before = (origin, boundary, op, endpoint, state, predicate = () => true) =>
    boundary !== null &&
    timeline.some(
      (entry) =>
        entry.origin === origin &&
        entry.ordinal < boundary &&
        entry.item.op === op &&
        entry.item.endpoint === endpoint &&
        entry.item.state === state &&
        predicate(entry.item)
    )
  if (acquired.length) {
    const beginAck = [...raw.acks.values()].find((item) => item.command === 'begin')
    assert(
      beginAck && acquired.every((item) => at((entry) => entry === item) > beginAck.ordinal),
      'acquisition before acknowledged begin'
    )
  }
  if (armCommand) {
    assert(armCommandAt !== null && (!armAck || armCommandAt < armAck.ordinal), 'arm admission order')
    const childBeforeArm = (op, endpoint, state, predicate = () => true) =>
      before('child', armCommandAt, op, endpoint, state, predicate)
    const parentBeforeArm = (op, endpoint, state, predicate = () => true) =>
      before('parent', armCommandAt, op, endpoint, state, predicate)
    assert(
      acquired.length === 2 &&
        acquired.every((item) => item.state === 'fulfilled' && at((entry) => entry === item) < armCommandAt),
      'arm admission without both acquired objects'
    )
    assert(
      childBeforeArm(
        SOCKET.has(id) ? 'socket-read' : 'peer-read',
        'reader3',
        'observed',
        (item) => item.bytes === 1 && item.dataSha256 === hash(Buffer.from([0x61]))
      ),
      'arm admission before child input'
    )
    assert(
      childBeforeArm(
        'api-write',
        'writer4',
        'fulfilled',
        (item) => item.id === 1 && item.bytes === 1 && item.dataSha256 === hash(Buffer.from([0x62]))
      ) &&
        ['start', 'observed'].every((state) =>
          childBeforeArm('api-write', 'writer4', state, (item) => item.id === 1)
        ) &&
        parentBeforeArm(
          'api-write',
          'reader3',
          'fulfilled',
          (item) => item.id === 1 && item.bytes === 1 && item.dataSha256 === hash(Buffer.from([0x61]))
        ) &&
        ['start', 'observed'].every((state) =>
          parentBeforeArm('api-write', 'reader3', state, (item) => item.id === 1)
        ) &&
        parentBeforeArm('peer-read', 'writer4', 'observed', (item) => item.bytes >= 1),
      'arm admission before healthy a/b'
    )
    if (SOCKET.has(id))
      assert(
        childBeforeArm(
          'socket-read',
          'writer4',
          'observed',
          (item) => item.bytes === 1 && item.dataSha256 === hash(Buffer.from([0x63]))
        ) &&
          parentBeforeArm(
            'api-write',
            'writer4',
            'fulfilled',
            (item) => item.id === 2 && item.bytes === 1 && item.dataSha256 === hash(Buffer.from([0x63]))
          ) &&
          ['start', 'observed'].every((state) =>
            parentBeforeArm('api-write', 'writer4', state, (item) => item.id === 2)
          ),
        'arm admission before reverse c'
      )
  }
  if (armed) {
    assert(armAck && armedAt !== null && armAck.ordinal < armedAt, 'armed before admitted arm')
    if (BULK.has(id)) assert(!bulkTerminal || bulkTerminal.seq > armed.seq, 'bulk callback before armed')
    if (BULK.has(id))
      assert(
        before('parent', armedAt, 'peer-pause', 'writer4', 'requested') &&
          before(
            'child',
            armedAt,
            'api-write',
            'writer4',
            'observed',
            (item) => item.id === 2 && item.result === false
          ),
        'bulk arm without false return/pause'
      )
    if (!SOCKET.has(id)) assert(pendingSecondReadAt([armed.seq]), 'FS arm without second read pending')
    if (id === 'N05')
      assert(
        bulkStart && pendingAt(['fs-write', 'fs-writev'], 'writer4', armed.seq, bulkStart.seq),
        'FS bulk arm without native bulk-interval pending'
      )
  }
  const goal = childRecord('goal', 'none', 'start')
  const refusal = raw.childEvents.find((item) => item.op === 'goal' && item.state === 'rejected')
  const goalAck = [...raw.acks.values()].find((item) => item.command === 'goal')
  const goalCommand = raw.commands.find((item) => item.command === 'goal')
  if (goalCommand) assert(armedAt !== null && armedAt < at((item) => item === goalCommand), 'goal command before armed')
  assert(
    count((item) => item.op === 'goal' && item.state === 'start') <= 1 &&
      count((item) => item.op === 'goal' && item.state === 'rejected') <= 1 &&
      !(goal && refusal),
    'goal uniqueness'
  )
  if (goal) assert(goal.id === 0 && goal.endpoint === 'none' && goal.phase === 'goal', 'actual goal shape')
  if (refusal)
    assert(
      (refusal.phase === 'setup' && BULK.has(id) && refusal.endpoint === 'writer4' && refusal.id === 2) ||
        (refusal.phase === 'goal' &&
          ((!SOCKET.has(id) && refusal.endpoint === 'reader3' && refusal.id === 0) ||
            (BULK.has(id) && refusal.endpoint === 'writer4' && refusal.id === 2))),
      'typed arm or goal refusal'
    )
  if (goal)
    assert(
      armed && goal.seq > armed.seq && goalAck && goalAck.ordinal < at((item) => item === goal),
      'goal before acknowledged arm'
    )
  if (goal && !SOCKET.has(id)) assert(pendingSecondReadAt([armed.seq, goal.seq]), 'goal without second read pending')
  if (goal && BULK.has(id)) assert(!bulkTerminal || bulkTerminal.seq > goal.seq, 'bulk callback before goal')
  if (goal && id === 'N05')
    assert(
      bulkStart && pendingAt(['fs-write', 'fs-writev'], 'writer4', goal.seq, bulkStart.seq),
      'goal without native bulk-interval pending'
    )
  if (refusal) {
    const command = refusal.phase === 'setup' ? 'arm' : 'goal'
    assert(
      !raw.barriers.has('sample') &&
        (refusal.phase !== 'setup' || !armed) &&
        [...raw.acks.values()].some(
          (item) =>
            item.command === command && item.ordinal < at((row, origin) => origin === 'child' && row === refusal)
        ),
      'refused goal missing admitted command'
    )
  }
  const goalAt = at((item) => item === goal)
  const goalPeerAction = timeline.filter(
    ({ origin, item }) => origin === 'parent' && item.op === 'peer-destroy' && item.phase === 'goal'
  )
  assert(goalPeerAction.length <= 1, 'unique goal peer action')
  for (const action of goalPeerAction)
    assert(
      (id === 'N03' || id === 'N04') &&
        action.item.endpoint === 'writer4' &&
        goalAt !== null &&
        goalAt < action.ordinal,
      'goal output action cause'
    )
  const peerClosedCommand = raw.commands.find((item) => item.command === 'peer-closed')
  if (peerClosedCommand) {
    const commandAt = at((item) => item === peerClosedCommand)
    const actionAt = goalPeerAction[0]?.ordinal ?? null
    const closeAt = at((item, origin) => origin === 'parent' && item.op === 'peer-close' && item.endpoint === 'writer4')
    assert(
      (id === 'N03' || id === 'N04') &&
        actionAt !== null &&
        closeAt !== null &&
        actionAt < closeAt &&
        closeAt < commandAt,
      'peer-close command before actual goal action/close'
    )
  }
  if (raw.barriers.has('sample'))
    assert(
      goal &&
        !refusal &&
        raw.barriers.get('sample').seq > goal.seq &&
        ((id !== 'N03' && id !== 'N04') ||
          [...raw.acks.values()].some(
            (item) => item.command === 'peer-closed' && item.ordinal < at((row) => row.kind === 'sample')
          )),
      'sample before actual goal and output peer-close ACK'
    )
  if (raw.barriers.has('final')) {
    const finishAck = [...raw.acks.values()].find((item) => item.command === 'finish')
    assert(
      rejected
        ? !finishAck && at((item) => item === rejected) < at((item) => item.kind === 'final')
        : finishAck && finishAck.ordinal < at((item) => item.kind === 'final'),
      'final before admitted finish or acquisition cleanup'
    )
  }
  for (const endpoint of ['reader3', 'writer4']) {
    const destroys = raw.childEvents.filter((item) => item.op === 'local-destroy' && item.endpoint === endpoint)
    assert(
      destroys.length <= 1 &&
        (!destroys.length || acquired.some((item) => item.endpoint === endpoint && item.state === 'fulfilled')),
      'destroyed unacquired endpoint'
    )
    if (destroys[0]?.phase === 'goal')
      assert(
        id !== 'N03' && id !== 'N04' && goal && destroys[0].seq > goal.seq,
        'local destroy before actual local goal'
      )
    if (destroys[0]?.phase === 'goal' && !SOCKET.has(id))
      assert(pendingSecondReadAt([armed.seq, goal.seq, destroys[0].seq]), 'FS destroy without read pending')
    if (destroys[0]?.phase === 'goal' && id === 'N05')
      assert(
        bulkStart && pendingAt(['fs-write', 'fs-writev'], 'writer4', destroys[0].seq, bulkStart.seq),
        'FS bulk destroy without native bulk-interval pending'
      )
    if (destroys[0]?.phase === 'goal' && BULK.has(id) && endpoint === 'writer4')
      assert(!bulkTerminal || bulkTerminal.seq > destroys[0].seq, 'bulk callback before writer destroy')
    const closes = raw.childEvents.filter((item) => item.op === 'stream-close' && item.endpoint === endpoint)
    const readableEnds = raw.childEvents.filter((item) => item.op === 'stream-end' && item.endpoint === endpoint)
    const checks = raw.childEvents.filter((item) => item.op === 'fd-check' && item.endpoint === endpoint)
    assert(
      closes.length <= 1 &&
        readableEnds.length <= 1 &&
        checks.length <= 1 &&
        (!readableEnds.length || !closes.length || readableEnds[0].seq < closes[0].seq) &&
        (!checks.length || (closes.length && checks[0].seq > closes[0].seq)),
      'endpoint close/fstat order'
    )
    if (!SOCKET.has(id)) {
      const nativeClose = raw.childEvents.find(
        (item) => item.op === 'fs-close' && item.endpoint === endpoint && item.state === 'start'
      )
      if (nativeClose) {
        const closeAt = at((item) => item === nativeClose)
        const acquiredAt = at(
          (item) => item.op === 'acquire' && item.endpoint === endpoint && item.state === 'fulfilled'
        )
        const automaticAt = at(
          (item, origin) =>
            origin === 'child' &&
            item.endpoint === endpoint &&
            (item.op === 'local-destroy' ||
              (item.op === 'stream-end' && endpoint === 'reader3') ||
              (item.state === 'rejected' && ['fs-read', 'fs-write', 'fs-writev', 'stream-error'].includes(item.op)))
        )
        const peerGoalAt =
          endpoint === 'writer4' && (id === 'N03' || id === 'N04') ? (goalPeerAction[0]?.ordinal ?? null) : null
        assert(
          acquiredAt !== null &&
            acquiredAt < closeAt &&
            ((automaticAt !== null && acquiredAt < automaticAt && automaticAt < closeAt) ||
              (peerGoalAt !== null && peerGoalAt < closeAt) ||
              (rejected && at((item) => item === rejected) < closeAt)),
          'native close without acquired endpoint and legal cause'
        )
      }
    }
  }
  const sends = raw.parent.filter((item) => item.op === 'ipc-send')
  assert(sends.filter((item) => item.state === 'start').length === raw.commands.length, 'one IPC send per command')
  for (const command of raw.commands) {
    const matches = sends.filter((item) => item.id === command.seq)
    assert(
      matches.length <= 2 &&
        matches[0]?.state === 'start' &&
        matches[1] &&
        ['fulfilled', 'rejected', 'threw'].includes(matches[1].state),
      'original send pair'
    )
    const commandAt = at((item) => item === command)
    const sendAt = at((item) => item === matches[0])
    const terminalAt = at((item) => item === matches[1])
    const ackAt = raw.acks.get(command.seq)?.ordinal ?? null
    assert(
      commandAt !== null &&
        sendAt !== null &&
        terminalAt !== null &&
        commandAt < sendAt &&
        sendAt < terminalAt &&
        (ackAt === null || sendAt < ackAt),
      'command/send order'
    )
  }
  for (const ack of raw.acks.values()) {
    const command = raw.commands[ack.commandSeq - 1]
    const ackAt = at((item) => item.kind === 'command-ack' && item.commandSeq === ack.commandSeq)
    const earlierRescue = [...raw.acks.values()].some(
      (item) => item.ordinal < ackAt && item.command.startsWith('rescue-')
    )
    const expectedPhase =
      ack.command === 'begin' || ack.command === 'arm' || ack.command === 'goal'
        ? 'setup'
        : ack.command === 'peer-closed'
          ? 'goal'
          : earlierRescue
            ? 'rescue'
            : refusal?.phase === 'setup'
              ? 'setup'
              : 'goal'
    assert(
      command?.command === ack.command &&
        ack.phase === expectedPhase &&
        at((item) => item === command) !== null &&
        at((item) => item === command) <
          at((item) => item.kind === 'command-ack' && item.commandSeq === ack.commandSeq),
      'ACK original command'
    )
    if (ack.command === 'goal') assert(armed && at((item) => item.kind === 'armed') < ackAt, 'goal ACK before armed')
    if (ack.command.startsWith('rescue-'))
      assert(
        at((item) => item.op === 'frontier-fsync') !== null &&
          at((item) => item.op === 'frontier-fsync') < ackAt &&
          (raw.barriers.get('sample')
            ? at((item) => item.kind === 'sample') < ackAt
            : refusal && at((item) => item === refusal) < ackAt),
        'rescue ACK before sample/refusal and durable cut'
      )
    if (ack.command === 'finish') assert(raw.barriers.has('sample') || refusal, 'finish ACK before sample/refusal')
  }
  const spawn = raw.parent.filter((item) => item.op === 'spawn')
  assert(
    spawn[0]?.state === 'start' &&
      spawn.length <= 2 &&
      (spawn.length === 1 || ['fulfilled', 'rejected', 'threw'].includes(spawn[1].state)),
    'per-case spawn start/terminal'
  )
  const ends = raw.parent.filter(
    (item) => item.op === 'peer-end' && ['requested', 'fulfilled', 'rejected', 'threw'].includes(item.state)
  )
  assert(
    count((item, origin) => origin === 'parent' && item.op === 'ipc-disconnect') <= 1 &&
      count((item, origin) => origin === 'parent' && item.op === 'peer-end' && item.state === 'observed') <= 1,
    'parent IPC/finish terminal uniqueness'
  )
  const finishAt = at((item, origin) => origin === 'parent' && item.op === 'peer-end' && item.state === 'observed')
  const inputCloseAt = at(
    (item, origin) => origin === 'parent' && item.op === 'peer-close' && item.endpoint === 'reader3'
  )
  if (finishAt !== null)
    assert(inputCloseAt === null || finishAt < inputCloseAt, 'automatic writable finish after close')
  if (ends.length)
    assert(
      ends[0].state === 'requested' &&
        ends.length <= 2 &&
        (ends.length === 1 || ['fulfilled', 'rejected', 'threw'].includes(ends[1].state)) &&
        (finishAt === null || at((item) => item === ends[0]) < finishAt),
      'original end callback order'
    )
  const signalStarts = raw.parent.filter((item) => item.op === 'infra-term' && item.state === 'start')
  assert(signalStarts.length <= 2, 'TERM/KILL schedule')
  for (const start of signalStarts) {
    const startAt = at((item) => item === start)
    const next = signalStarts.find((item) => at((row) => row === item) > startAt)
    const nextAt = next ? at((item) => item === next) : null
    const later = timeline.filter((entry) => entry.ordinal > startAt && (nextAt === null || entry.ordinal < nextAt))
    assert(
      later.some(
        ({ item }) =>
          (item.op === 'infra-term' && item.state === 'requested') ||
          (item.op === 'fatal' && item.endpoint === 'process')
      ),
      'signal result or actual error'
    )
  }
}

function summarizeCase(id, raw, files) {
  const timeline = raw.timeline
  const sampleRecord = raw.barriers.get('sample')
  const sample =
    sampleRecord && raw.samples[0]
      ? { seq: sampleRecord.seq, ordinal: raw.samples[0].ordinal, bytes: raw.samples[0].bytes }
      : null
  const prefix = sample ? timeline.filter((entry) => entry.ordinal <= sample.ordinal) : []
  const childPre = prefix
    .filter((entry) => entry.origin === 'child' && entry.item.kind === 'event')
    .map((entry) => entry.item)
  const parentPre = prefix
    .filter((entry) => entry.origin === 'parent' && entry.item.kind === 'parent')
    .map((entry) => entry.item)
  const allChild = raw.childEvents
  const allParent = raw.parent
  const find = (list, op, endpoint, test = () => true) =>
    list.find((item) => item.op === op && item.endpoint === endpoint && test(item))
  const has = (list, op, endpoint, test) => Boolean(find(list, op, endpoint, test))
  const ordinal = (predicate) => timeline.find((entry) => predicate(entry.item, entry.origin))?.ordinal ?? null
  const childWrites = pairWrites(allChild, 'child')
  const parentWrites = pairWrites(allParent, 'parent')
  const writeOK = (pairs, opId) => pairs.get(opId)?.observed && pairs.get(opId)?.terminal?.state === 'fulfilled'
  let outputOffset = 0
  for (const item of allParent.filter((entry) => entry.op === 'peer-read' && entry.endpoint === 'writer4')) {
    assert(item.bytes > 0 && outputOffset + item.bytes <= files.output.length, 'output chunk span')
    assert(
      hash(files.output.subarray(outputOffset, outputOffset + item.bytes)) === item.dataSha256,
      'output chunk digest'
    )
    outputOffset += item.bytes
  }
  assert(outputOffset === files.output.length, 'unrecorded output bytes')
  const inputIssued = parentWrites.get(1)?.observed !== null && parentWrites.has(1)
  assert(
    files.input.length === (inputIssued ? 1 : 0) && (!inputIssued || files.input[0] === 0x61),
    'actual parent input transcript'
  )
  if (files.output.length)
    assert(
      files.output[0] === 0x62 &&
        (!BULK.has(id) ? files.output.length === 1 : files.output.subarray(1).every((byte) => byte === 0xa5)),
      'output shape'
    )
  const sends = new Map()
  for (const item of allParent.filter((entry) => entry.op === 'ipc-send')) {
    if (item.state === 'start') {
      assert(!sends.has(item.id), 'duplicate send start')
      sends.set(item.id, { start: item, terminal: null })
    } else {
      const pair = sends.get(item.id)
      assert(pair && !pair.terminal, 'send terminal identity')
      pair.terminal = item
    }
  }
  for (const command of raw.commands) assert(sends.has(command.seq), 'command missing actual send')
  const ends = allParent.filter(
    (item) => item.op === 'peer-end' && ['requested', 'fulfilled', 'rejected', 'threw'].includes(item.state)
  )
  assert(
    ends.filter((item) => item.state === 'requested').length <= 1 &&
      ends.filter((item) => item.state !== 'requested').length <= 1,
    'parent end identity'
  )
  const parentJoined =
    [...parentWrites.values()].every((pair) => pair.terminal) &&
    [...sends.values()].every((pair) => pair.terminal) &&
    ends.filter((item) => item.state === 'requested').length ===
      ends.filter((item) => item.state !== 'requested').length
  const childJoined =
    [...childWrites.values()].every((pair) => pair.terminal) && raw.nativeStarts.size === raw.nativeDone.size
  const exit = raw.terminals.find((item) => item.event === 'exit')
  const close = raw.terminals.find((item) => item.event === 'close')
  const peer3Closed = has(allParent, 'peer-close', 'reader3')
  const peer4Closed = has(allParent, 'peer-close', 'writer4')
  const stderrClosed = has(allParent, 'stream-close', 'process')
  const stderrEnded = has(allParent, 'stream-end', 'process')
  const peer3Ended = has(allParent, 'stream-end', 'reader3')
  const peer4Ended = has(allParent, 'stream-end', 'writer4')
  const ipcDisconnected = has(allParent, 'ipc-disconnect', 'ipc')
  const spawned = has(allParent, 'spawn', 'process', (item) => item.state === 'fulfilled')
  const spawnStart = has(allParent, 'spawn', 'process', (item) => item.state === 'start')
  const syncSpawnThrow =
    spawnStart &&
    has(allParent, 'spawn', 'process', (item) => item.state === 'threw') &&
    !spawned &&
    raw.child.length === 0 &&
    raw.terminals.length === 0
  const asyncSpawnRejected =
    spawnStart &&
    has(allParent, 'spawn', 'process', (item) => item.state === 'rejected') &&
    !spawned &&
    !raw.terminals.some((item) => item.event === 'exit')
  const closeOrdinal = ordinal((item) => item.kind === 'process-terminal' && item.event === 'close')
  const peerCloseBefore = ['reader3', 'writer4'].every((endpoint) => {
    const seen = ordinal((item) => item.op === 'peer-close' && item.endpoint === endpoint)
    return seen !== null && closeOrdinal !== null && seen < closeOrdinal
  })
  const parentReadableEpoch = ['reader3', 'writer4'].every((endpoint) => {
    const closeRows = allParent.filter((item) => item.op === 'peer-close' && item.endpoint === endpoint)
    const endRows = allParent.filter((item) => item.op === 'stream-end' && item.endpoint === endpoint)
    const closeAt = ordinal((item) => item === closeRows[0])
    const endAt = ordinal((item) => item === endRows[0])
    return (
      closeRows.length <= 1 &&
      endRows.length <= 1 &&
      (!closeRows.length || closeOrdinal === null || closeAt < closeOrdinal) &&
      (endAt === null || closeAt === null || endAt < closeAt)
    )
  })
  const stderrEndRows = allParent.filter((item) => item.op === 'stream-end' && item.endpoint === 'process')
  const stderrCloseRows = allParent.filter((item) => item.op === 'stream-close' && item.endpoint === 'process')
  const stderrEpoch =
    stderrEndRows.length <= 1 &&
    stderrCloseRows.length <= 1 &&
    (!stderrCloseRows.length ||
      ((stderrEndRows.length === 0 ||
        ordinal((item) => item === stderrEndRows[0]) < ordinal((item) => item === stderrCloseRows[0])) &&
        (closeOrdinal === null || ordinal((item) => item === stderrCloseRows[0]) < closeOrdinal)))
  assert(parentReadableEpoch && stderrEpoch, 'parent readable endpoint terminal epoch')
  const natural = Boolean(
    exit && close && exit.code === 0 && close.code === 0 && exit.signal === null && close.signal === null
  )
  const footer = readFooter(files.stderr, id)
  const finalJoined = Boolean(
    footer &&
      footer.finalSendState === 'callback-fulfilled' &&
      footer.issuedSends === footer.completedSends &&
      footer.issuedSends === raw.child.length &&
      footer.exitCode === exit?.code &&
      footer.uncaughtExceptionCount === 0 &&
      footer.unhandledRejectionCount === 0
  )
  const endpointClosed = (endpoint) => {
    const stream = find(allChild, 'stream-close', endpoint)
    const fd = find(
      allChild,
      'fd-check',
      endpoint,
      (item) => item.seq > (stream?.seq ?? Infinity) && item.state === 'rejected' && item.error?.code === 'EBADF'
    )
    const native =
      SOCKET.has(id) ||
      find(allChild, 'fs-close', endpoint, (item) => item.state === 'fulfilled' && item.seq < (stream?.seq ?? Infinity))
    return Boolean(stream && fd && native)
  }
  const acquisition =
    has(allChild, 'acquire', 'reader3', (item) => item.state === 'rejected') ||
    has(allChild, 'acquire', 'writer4', (item) => item.state === 'rejected')
  const acquired = ['reader3', 'writer4'].every((endpoint) =>
    has(childPre, 'acquire', endpoint, (item) => item.state === 'fulfilled')
  )
  const inputRead = has(
    childPre,
    SOCKET.has(id) ? 'socket-read' : 'peer-read',
    'reader3',
    (item) => item.bytes === 1 && item.dataSha256 === hash(Buffer.from([0x61]))
  )
  const reverseRead =
    !SOCKET.has(id) ||
    has(childPre, 'socket-read', 'writer4', (item) => item.bytes === 1 && item.dataSha256 === hash(Buffer.from([0x63])))
  const healthy = Boolean(
    acquired &&
      inputRead &&
      reverseRead &&
      has(childPre, 'api-write', 'writer4', (item) => item.id === 1 && item.state === 'fulfilled') &&
      has(parentPre, 'api-write', 'reader3', (item) => item.id === 1 && item.state === 'fulfilled') &&
      (!SOCKET.has(id) ||
        has(parentPre, 'api-write', 'writer4', (item) => item.id === 2 && item.state === 'fulfilled')) &&
      has(
        parentPre,
        'peer-read',
        'writer4',
        (item) => item.bytes > 0 && item.dataSha256 === hash(files.output.subarray(0, item.bytes))
      ) &&
      writeOK(childWrites, 1) &&
      writeOK(parentWrites, 1) &&
      files.output[0] === 0x62
  )
  const arm = raw.barriers.get('armed')
  const goal = find(childPre, 'goal', 'none', (item) => item.state === 'start')
  const readerDestroy = find(childPre, 'local-destroy', 'reader3', (item) => item.state === 'requested')
  const destroy = find(childPre, 'local-destroy', 'writer4', (item) => item.state === 'requested')
  const localBoth = Boolean(readerDestroy && destroy && readerDestroy.seq < destroy.seq)
  const fsPendingRead = (boundaries) => {
    const first = allChild.find(
      (item) =>
        item.op === 'fs-read' &&
        item.endpoint === 'reader3' &&
        item.state === 'fulfilled' &&
        item.bytes === 1 &&
        item.dataSha256 === hash(Buffer.from([0x61]))
    )
    return Boolean(
      first &&
        allChild.some(
          (item) =>
            item.op === 'fs-read' &&
            item.endpoint === 'reader3' &&
            item.state === 'start' &&
            item.seq > first.seq &&
            boundaries.every(
              (boundary) =>
                item.seq < boundary &&
                !allChild.some(
                  (done) =>
                    done.op === 'fs-read' &&
                    done.id === item.id &&
                    ['fulfilled', 'rejected', 'threw'].includes(done.state) &&
                    done.seq < boundary
                )
            )
        )
    )
  }
  const pendingRead =
    SOCKET.has(id) || Boolean(arm && goal && fsPendingRead([arm.seq, goal.seq, ...(destroy ? [destroy.seq] : [])]))
  const bulk = childWrites.get(2)
  const bulkFalse =
    !BULK.has(id) ||
    Boolean(
      bulk?.observed?.result === false &&
        arm &&
        goal &&
        destroy &&
        bulk.observed.seq < arm.seq &&
        bulk.start.seq < goal.seq &&
        (!bulk.terminal || bulk.terminal.seq > destroy.seq)
    )
  const pendingNativeWrite =
    id !== 'N05' ||
    Boolean(
      arm &&
        goal &&
        destroy &&
        [arm.seq, goal.seq, destroy.seq].every((boundary) =>
          [...raw.nativeStarts.entries()].some(
            ([nativeId, start]) =>
              start.endpoint === 'writer4' &&
              ['fs-write', 'fs-writev'].includes(start.op) &&
              bulk?.start &&
              start.seq > bulk.start.seq &&
              start.seq < (bulk.terminal?.seq ?? Infinity) &&
              start.seq < boundary &&
              !allChild.some(
                (item) =>
                  item.id === nativeId &&
                  item.op === start.op &&
                  ['fulfilled', 'rejected', 'threw'].includes(item.state) &&
                  item.seq < boundary
              )
          )
        )
    )
  const pausedBeforeBulk =
    !BULK.has(id) ||
    (() => {
      const pause = ordinal((item) => item.op === 'peer-pause')
      const start = ordinal(
        (item) => item.kind === 'event' && item.op === 'api-write' && item.id === 2 && item.state === 'start'
      )
      return pause !== null && start !== null && pause < start
    })()
  const fsClosed = (endpoint) => {
    const native = find(childPre, 'fs-close', endpoint, (item) => item.state === 'fulfilled')
    const stream = find(childPre, 'stream-close', endpoint, (item) => item.seq > (native?.seq ?? Infinity))
    const fd = find(
      childPre,
      'fd-check',
      endpoint,
      (item) => item.seq > (stream?.seq ?? Infinity) && item.state === 'rejected' && item.error?.code === 'EBADF'
    )
    const cause =
      id === 'N03' ? peerDestroy : find(childPre, 'local-destroy', endpoint, (item) => item.state === 'requested')?.seq
    return Boolean(
      native && stream && fd && (id === 'N03' ? ordinal((item) => item === native) > cause : native.seq > cause)
    )
  }
  const socketClosed = (endpoint) => {
    const stream = find(childPre, 'stream-close', endpoint)
    const cause =
      id === 'N04' ? peerDestroy : find(childPre, 'local-destroy', endpoint, (item) => item.state === 'requested')?.seq
    return Boolean(
      stream &&
        (stream.result === false ||
          (id === 'N06' &&
            endpoint === 'writer4' &&
            stream.result === true &&
            childPre.some(
              (item) =>
                item.op === 'api-write' &&
                item.id === 2 &&
                item.state === 'rejected' &&
                ['ECANCELED', 'ERR_STREAM_DESTROYED'].includes(item.error?.code)
            ))) &&
        (id === 'N04' ? ordinal((item) => item === stream) > cause : stream.seq > cause) &&
        has(
          childPre,
          'fd-check',
          endpoint,
          (item) => item.seq > stream.seq && item.state === 'rejected' && item.error?.code === 'EBADF'
        )
    )
  }
  const frontierEntry = timeline.find((entry) => entry.item.op === 'frontier-fsync')
  assert(timeline.filter((entry) => entry.item.op === 'frontier-fsync').length <= 1, 'multiple durable frontiers')
  const peerDestroy = ordinal((item) => item.op === 'peer-destroy' && item.endpoint === 'writer4')
  const peerClosed = ordinal((item) => item.op === 'peer-close' && item.endpoint === 'writer4')
  const goalOrdinal = ordinal((item) => item.op === 'goal' && item.state === 'start')
  const refusalOrdinal = ordinal((item) => item.op === 'goal' && item.state === 'rejected')
  const peerClosedCommand = ordinal((item) => item.kind === 'command' && item.command === 'peer-closed')
  const peerClosedAck = [...raw.acks.values()].find((item) => item.command === 'peer-closed')?.ordinal ?? null
  const outputCut =
    (id !== 'N03' && id !== 'N04') ||
    (goalOrdinal !== null &&
      peerDestroy !== null &&
      peerClosed !== null &&
      peerClosedCommand !== null &&
      peerClosedAck !== null &&
      sample !== null &&
      goalOrdinal < peerDestroy &&
      peerDestroy < peerClosed &&
      peerClosed < peerClosedCommand &&
      peerClosedCommand < peerClosedAck &&
      peerClosedAck < sample.ordinal &&
      !timeline.some(
        (entry) =>
          entry.ordinal > peerDestroy &&
          entry.ordinal < sample.ordinal &&
          entry.origin === 'child' &&
          entry.item.op === 'api-write' &&
          entry.item.state === 'start'
      ) &&
      !has(parentPre, 'peer-end', 'reader3', (item) => item.state === 'requested') &&
      !has(parentPre, 'peer-destroy', 'reader3') &&
      !has(parentPre, 'stream-end', 'reader3') &&
      !has(parentPre, 'peer-close', 'reader3') &&
      !has(childPre, 'stream-end', 'reader3') &&
      !has(childPre, 'stream-close', 'reader3'))
  const frontier = frontierEntry
    ? {
        bytes: frontierEntry.item.bytes,
        sha256: frontierEntry.item.dataSha256,
        ordinal: frontierEntry.ordinal,
        childSeq: frontierEntry.item.childSeq
      }
    : null
  if (sample)
    assert(
      frontier &&
        frontier.ordinal > sample.ordinal &&
        frontier.bytes === sample.bytes &&
        frontier.sha256 === hash(files.events.subarray(0, sample.bytes)) &&
        frontier.childSeq >= sample.seq,
      'immutable durable sample'
    )
  else if (frontierEntry) {
    const previous = timeline[frontierEntry.ordinal - 2]
    const acceptedChildSeq =
      timeline
        .slice(0, frontierEntry.ordinal - 1)
        .filter((entry) => entry.origin === 'child')
        .at(-1)?.item.seq ?? null
    assert(
      frontierEntry.item.bytes === (previous?.bytes ?? 0) &&
        frontierEntry.item.dataSha256 === hash(files.events.subarray(0, previous?.bytes ?? 0)) &&
        frontierEntry.item.childSeq === acceptedChildSeq,
      'durable no-sample prefix'
    )
  }
  for (const entry of timeline)
    if (
      entry.item.kind === 'command' &&
      ['rescue-destroy', 'rescue-drain', 'rescue-input-eof', 'finish'].includes(entry.item.command)
    )
      assert(
        frontier &&
          entry.ordinal > frontier.ordinal &&
          (sample ? sample.ordinal < entry.ordinal : refusalOrdinal !== null && refusalOrdinal < entry.ordinal),
        'rescue before sample/refusal and durable frontier'
      )
  for (const entry of timeline)
    if (
      entry.item.kind === 'parent' &&
      (['peer-destroy', 'peer-resume', 'infra-term'].includes(entry.item.op) ||
        (entry.item.op === 'peer-end' && entry.item.state === 'requested'))
    )
      assert(
        ((id === 'N03' || id === 'N04') &&
          entry.item.op === 'peer-destroy' &&
          entry.item.endpoint === 'writer4' &&
          entry.item.phase === 'goal' &&
          goalOrdinal !== null &&
          goalOrdinal < entry.ordinal &&
          (!frontier || entry.ordinal < frontier.ordinal) &&
          (sample === null || (entry.ordinal < sample.ordinal && outputCut))) ||
          (entry.item.phase === 'rescue' && frontier && entry.ordinal > frontier.ordinal),
        'parent goal action or post-cut rescue'
      )
  const endOrdinal = ordinal((item) => item.op === 'peer-end' && item.state === 'requested')
  const resumes = timeline.filter((entry) => entry.origin === 'parent' && entry.item.op === 'peer-resume')
  const expiries = timeline.filter((entry) => entry.origin === 'parent' && entry.item.op === 'drain-expiry')
  const pauses = timeline.filter((entry) => entry.origin === 'parent' && entry.item.op === 'peer-pause')
  const drainCommand = raw.commands.find((item) => item.command === 'rescue-drain')
  const drainAck = [...raw.acks.values()].find((item) => item.command === 'rescue-drain')?.ordinal ?? null
  const resume = resumes[0]?.ordinal ?? null
  const expiry = expiries[0]?.ordinal ?? null
  const bulkTerminal = childWrites.get(2)?.terminal
  const callback = ordinal(
    (item, origin) =>
      origin === 'child' &&
      item === bulkTerminal &&
      item.endpoint === 'writer4' &&
      ['fulfilled', 'rejected'].includes(item.state)
  )
  const writerClose = ordinal((item) => item.op === 'stream-close' && item.endpoint === 'writer4')
  assert(pauses.length <= 1 && resumes.length <= 1 && expiries.length <= 1, 'unique bulk lifetime')
  assert(BULK.has(id) || (!pauses.length && !resumes.length && !expiries.length), 'nonbulk drain lifetime')
  if (drainCommand)
    assert(
      BULK.has(id) && pauses.length === 1 && pauses[0].ordinal < ordinal((item) => item === drainCommand),
      'drain before actual pause'
    )
  if (resume !== null) assert(drainAck !== null && drainAck < resume, 'resume before drain ACK')
  if (expiry !== null)
    assert(
      resume !== null && resume < expiry && (endOrdinal === null || expiry < endOrdinal),
      'orphan or late drain expiry'
    )
  const completedBefore = (successor) =>
    resume !== null &&
    resume < successor &&
    (expiry !== null
      ? expiry < successor
      : callback !== null && writerClose !== null && callback < successor && writerClose < successor)
  for (const command of raw.commands.filter((item) => ['rescue-input-eof', 'finish'].includes(item.command))) {
    const successor = ordinal((item) => item === command)
    if (BULK.has(id) && drainCommand)
      assert(successor !== null && completedBefore(successor), 'successor before bulk drain')
  }
  if (endOrdinal !== null) {
    const ack = [...raw.acks.values()].find((item) => item.command === 'rescue-input-eof')
    assert(ack && ack.ordinal < endOrdinal, 'input EOF before acknowledged command')
  }
  if (resume !== null) assert(frontier && frontier.ordinal < drainAck, 'drain without committed frontier')
  for (const action of allChild.filter((item) => item.op === 'local-destroy' && item.phase === 'rescue')) {
    const ack = [...raw.acks.values()].find((item) => item.command === 'rescue-destroy')
    const at = ordinal((item) => item === action)
    assert(ack && at !== null && ack.ordinal < at, 'unacknowledged local rescue destroy')
  }
  const errors = []
  let unapprovedErrors = 0
  let fullUnapprovedErrors = 0
  const sampledBulkTerminal = childPre.find(
    (item) => item.op === 'api-write' && item.id === 2 && ['fulfilled', 'rejected'].includes(item.state)
  )
  const bulkAt = ordinal((item) => item === bulkTerminal)
  const resumedAt = ordinal((item) => item.op === 'peer-resume' && item.endpoint === 'writer4')
  const narrow =
    id === 'N06' &&
    sampledBulkTerminal?.state === 'rejected' &&
    destroy &&
    sampledBulkTerminal.seq > destroy.seq &&
    bulkAt !== null &&
    (resumedAt === null || bulkAt < resumedAt) &&
    !has(parentPre, 'peer-destroy', 'writer4') &&
    ['ECANCELED', 'ERR_STREAM_DESTROYED'].includes(sampledBulkTerminal.error?.code)
  for (const { item, origin, ordinal: errorOrdinal } of timeline) {
    if (!item.error || item.op === 'fd-check') continue
    const allowed =
      narrow &&
      (item === sampledBulkTerminal ||
        (origin === 'child' &&
          errorOrdinal < sample.ordinal &&
          item.op === 'stream-error' &&
          item.endpoint === 'writer4' &&
          item.error.code === sampledBulkTerminal.error.code &&
          item.phase === 'goal' &&
          item.seq > destroy.seq))
    errors.push({ op: item.op, endpoint: item.endpoint, error: item.error })
    if (!allowed) fullUnapprovedErrors++
    if (!allowed && (childPre.includes(item) || parentPre.includes(item))) unapprovedErrors++
  }
  const prerequisite = Boolean(
    sample &&
      arm &&
      healthy &&
      goal &&
      pendingRead &&
      bulkFalse &&
      pendingNativeWrite &&
      pausedBeforeBulk &&
      (!BULK.has(id) || !has(parentPre, 'peer-resume', 'writer4')) &&
      !has(parentPre, 'peer-end', 'reader3', (item) => item.state === 'requested') &&
      !has(parentPre, 'peer-destroy', 'reader3') &&
      outputCut &&
      !has(childPre, 'goal', 'writer4', (item) => item.state === 'rejected')
  )
  const localUninterrupted =
    !has(parentPre, 'peer-end', 'reader3', (item) => item.state === 'requested') &&
    !has(parentPre, 'peer-destroy', 'reader3') &&
    !has(parentPre, 'peer-destroy', 'writer4') &&
    !has(parentPre, 'peer-resume', 'writer4') &&
    !has(parentPre, 'infra-term', 'process')
  const positive =
    prerequisite &&
    (id === 'N01'
      ? Boolean(
          localUninterrupted &&
            !has(childPre, 'stream-end', 'reader3') &&
            localBoth &&
            fsClosed('reader3') &&
            fsClosed('writer4')
        )
      : id === 'N02'
        ? Boolean(localUninterrupted && localBoth && socketClosed('reader3') && socketClosed('writer4'))
        : id === 'N03'
          ? Boolean(!readerDestroy && !destroy && fsClosed('writer4') && !has(childPre, 'stream-close', 'reader3'))
          : id === 'N04'
            ? Boolean(
                !readerDestroy &&
                  !destroy &&
                  childPre.some(
                    (item) =>
                      item.op === 'stream-end' &&
                      item.endpoint === 'writer4' &&
                      item.seq < (find(childPre, 'stream-close', 'writer4')?.seq ?? -1)
                  ) &&
                  socketClosed('writer4') &&
                  !has(childPre, 'stream-end', 'reader3') &&
                  !has(childPre, 'stream-close', 'reader3')
              )
            : id === 'N05'
              ? Boolean(
                  localUninterrupted &&
                    localBoth &&
                    fsClosed('reader3') &&
                    fsClosed('writer4') &&
                    sampledBulkTerminal?.state === 'fulfilled' &&
                    sampledBulkTerminal.seq > destroy.seq
                )
              : id === 'N06'
                ? Boolean(
                    localUninterrupted &&
                      localBoth &&
                      socketClosed('reader3') &&
                      socketClosed('writer4') &&
                      (sampledBulkTerminal?.state === 'fulfilled' || narrow)
                  )
                : false)
  const capability = acquisition
    ? 'API_ACQUISITION_REJECTED'
    : !raw.binding ||
        (!sample &&
          !has(allChild, 'goal', 'writer4', (item) => item.state === 'rejected') &&
          !has(allChild, 'goal', 'reader3', (item) => item.state === 'rejected'))
      ? 'INCOMPLETE_INFRA'
      : !prerequisite
        ? 'PREREQUISITE_UNREACHED'
        : unapprovedErrors
          ? 'OBSERVED_ERROR'
          : positive
            ? 'OBSERVED_GOAL'
            : 'PENDING_AT_SAMPLE'
  const signals = allParent
    .filter((item) => item.op === 'infra-term' && item.state === 'start')
    .map((start, index) => {
      const later = allParent.filter((item) => item.seq > start.seq)
      const terminal = later.find((item) => item.op === 'infra-term' && item.state === 'requested')
      const nextStart = later.find((item) => item.op === 'infra-term' && item.state === 'start')
      return {
        name: index === 0 ? 'SIGTERM' : 'SIGKILL',
        result: terminal && (!nextStart || terminal.seq < nextStart.seq) ? terminal.result : null
      }
    })
  const safeClosed = Boolean(
    (syncSpawnThrow && parentJoined) ||
      (asyncSpawnRejected &&
        close &&
        peer3Closed &&
        peer4Closed &&
        stderrClosed &&
        ipcDisconnected &&
        peerCloseBefore &&
        parentJoined) ||
      (spawned &&
        exit &&
        close &&
        peer3Closed &&
        peer4Closed &&
        stderrClosed &&
        ipcDisconnected &&
        peerCloseBefore &&
        parentJoined)
  )
  const diagnosticComplete = Boolean(
    natural &&
      spawned &&
      raw.barriers.has('final') &&
      raw.acks.size === raw.commands.length &&
      finalJoined &&
      childJoined &&
      ['reader3', 'writer4'].every(endpointClosed) &&
      parentJoined &&
      peerCloseBefore &&
      parentReadableEpoch &&
      stderrEpoch &&
      stderrEnded &&
      (peer3Ended || has(allParent, 'peer-destroy', 'reader3')) &&
      (peer4Ended || has(allParent, 'peer-destroy', 'writer4')) &&
      stderrClosed &&
      ipcDisconnected &&
      signals.length === 0 &&
      !allParent.some((item) => item.op === 'fatal') &&
      !allChild.some((item) => item.op === 'fatal') &&
      !/METIS_N0_CHILD_FAILURE|Uncaught Exception|UnhandledPromiseRejection/.test(files.stderr.toString('utf8')) &&
      (sample ? frontier : acquisition || has(allChild, 'goal', 'writer4', (item) => item.state === 'rejected')) &&
      !['INCOMPLETE_INFRA', 'PREREQUISITE_UNREACHED', 'API_ACQUISITION_REJECTED'].includes(capability)
  )
  return {
    id,
    name: NAMES[IDS.indexOf(id)],
    attempted: true,
    capability,
    diagnosticStatus: diagnosticComplete ? 'COMPLETE' : 'PARTIAL',
    naturalClose: natural,
    exitCode: exit?.code ?? null,
    signal: exit?.signal ?? null,
    sampleSeq: sample?.seq ?? null,
    sample,
    frontier,
    callbackJoins: parentJoined,
    safeClosed,
    processClose: Boolean(close),
    peer3Closed,
    peer4Closed,
    stderrClosed,
    ipcDisconnected,
    terminated: signals.length > 0,
    signals,
    errors,
    _socketQualified: capability === 'OBSERVED_GOAL' && diagnosticComplete && fullUnapprovedErrors === 0,
    _footer: footer
  }
}

function replayGlobalParent(bytes, admissionPrefix) {
  assert(bytes.length <= MAX_META, 'parent raw budget')
  const envelopes = []
  let ordinal = 0
  let seq = 0
  let footer = null
  let spawnCount = 0
  let released = 0
  let active = null
  let offset = 0
  while (offset < bytes.length) {
    const newline = bytes.indexOf(10, offset)
    assert(newline >= 0 && newline - offset + 1 <= MAX_ENVELOPE, 'parent line boundary')
    assert(envelopes.length < 192, 'parent envelope count')
    const wire = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, newline))
    const envelope = JSON.parse(wire)
    assert(JSON.stringify(envelope) === wire, 'canonical parent envelope')
    const index = envelopes.length
    envelopes.push(envelope)
    offset = newline + 1
    exactKeys(envelope, ['ordinal', 'origin', 'payload'], 'collector parent envelope')
    assert(
      envelope.ordinal === ++ordinal &&
        envelope.origin === 'parent' &&
        typeof envelope.payload === 'string' &&
        envelope.payload.length <= MAX_PAYLOAD &&
        Buffer.byteLength(envelope.payload) <= MAX_PAYLOAD,
      'collector parent envelope binding'
    )
    const item = JSON.parse(envelope.payload)
    assert(JSON.stringify(item) === envelope.payload, 'canonical global payload')
    if (item.kind === 'exit-footer') {
      exactKeys(
        item,
        [
          'v',
          'kind',
          'caseId',
          'issuedSends',
          'completedSends',
          'finalSendCallback',
          'finalSendState',
          'finalSendError',
          'uncaughtExceptionCount',
          'unhandledRejectionCount',
          'exitCode'
        ],
        'collector exit footer'
      )
      assert(
        offset === bytes.length &&
          item.v === 1 &&
          item.caseId === null &&
          item.finalSendCallback === null &&
          item.finalSendState === null &&
          item.finalSendError === null,
        'collector footer frontier'
      )
      for (const key of ['issuedSends', 'completedSends', 'uncaughtExceptionCount', 'unhandledRejectionCount']) {
        assert(
          Number.isSafeInteger(item[key]) && item[key] >= 0 && item[key] <= (key.includes('Sends') ? 72 : 128),
          'collector footer counter'
        )
      }
      assert(Number.isSafeInteger(item.exitCode), 'collector actual exit code')
      footer = item
    } else {
      exactKeys(
        item,
        [
          'v',
          'kind',
          'caseId',
          'seq',
          'phase',
          'op',
          'endpoint',
          'id',
          'state',
          'bytes',
          'dataSha256',
          'result',
          'error',
          'childSeq'
        ],
        'collector parent record'
      )
      assert(
        item.v === 1 &&
          item.kind === 'parent' &&
          item.caseId === null &&
          item.seq === ++seq &&
          (item.op === 'spawn' ? item.phase === 'setup' : item.phase === 'finish') &&
          PHASE.has(item.phase) &&
          OP.has(item.op) &&
          STATES.has(item.state),
        'collector parent event'
      )
      assert(
        item.endpoint === 'process' &&
          item.bytes === null &&
          item.dataSha256 === null &&
          item.result === null &&
          item.error === null &&
          item.childSeq === null,
        'global admission fields'
      )
      if (item.op === 'spawn') {
        assert(active === null && item.state === 'start' && item.id === spawnCount + 1, 'serial collector spawn')
        active = item.id
        spawnCount++
        admissionPrefix.attempted.set(item.id, true)
      } else {
        assert(
          item.op === 'case-release' && item.state === 'observed' && item.id === active && item.id === released + 1,
          'owned case release'
        )
        active = null
        released++
        admissionPrefix.released.add(item.id)
      }
    }
  }
  assert(offset === bytes.length && bytes.length > 0, 'parent raw complete newline')
  assert(active === null, 'unreleased collector reservation')
  return { envelopes, footer, spawnCount, released }
}

function checkCaseCommands(id, commands, acquisition, armNotReached, goalRefused, hasSample, hasFinal) {
  assert(commands.length <= 12 && new Set(commands).size === commands.length, 'command cap/duplicate')
  if (acquisition) {
    assert(commands.length <= 1 && commands[0] === 'begin', 'acquisition control')
    return
  }
  const core = armNotReached
    ? ['begin', 'arm', 'rescue-destroy']
    : goalRefused
      ? ['begin', 'arm', 'goal', 'rescue-destroy']
      : ['begin', 'arm', 'goal', ...(id === 'N03' || id === 'N04' ? ['peer-closed', 'rescue-destroy'] : [])]
  const remaining = [...commands]
  for (const expected of core) {
    if (!remaining.length) break
    assert(remaining.shift() === expected, 'control transition')
  }
  if (BULK.has(id)) {
    if (remaining.length) assert(remaining.shift() === 'rescue-drain', 'bulk rescue control')
  }
  if (remaining[0] === 'rescue-input-eof') remaining.shift()
  if (remaining[0] === 'finish') remaining.shift()
  assert(remaining.length === 0, 'trailing control')
  if (hasSample) assert(commands.includes('goal') && commands.includes('arm'), 'sample without goal control')
  if (goalRefused) assert(!hasSample, 'refused goal had sample')
  if (hasFinal) assert(commands.at(-1) === 'finish', 'final without finish control')
}

function parseCanonical(bytes, label) {
  const wire = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  assert(wire.endsWith('\n'), label + ' final newline')
  const value = JSON.parse(wire.slice(0, -1))
  assert(JSON.stringify(value) + '\n' === wire, label + ' canonical JSON')
  return value
}

export async function runReplay() {
  const meta = provenance()
  const directory = runnerDirectory(meta)
  const custody = parseCustody(process.env.METIS_N0_CUSTODY, directory, meta, 'exit')
  const names = [...IDS.flatMap(namesFor), 'collector.json', 'parent.events.ndjson', 'collector-exit.json']
  const problems = []
  const cases = []
  const casePrefixes = new Map()
  const bytes = new Map()
  let physicalBytes = null
  let custodyVerified = false
  let collector = null
  let sourceVerified = false
  let parentReplay = null
  const admissionPrefix = { attempted: new Map(), released: new Set() }
  let safeToUpload = false
  let reportAttempted = false
  try {
    guardRoot(directory, custody.root)
    const actual = fs.readdirSync(directory).sort()
    assert(JSON.stringify(actual) === JSON.stringify([...names].sort()), 'fixed replay roster')
    let measured = 0
    for (const name of names) {
      const stat = fs.lstatSync(path.join(directory, name))
      assert(
        stat.isFile() && !stat.isSymbolicLink() && stat.size <= artifactLimit(name),
        'fixed artifact limit: ' + name
      )
      measured += stat.size
    }
    assert(measured + MAX_META <= MAX_TOTAL, 'whole directory plus replay reserve')
    physicalBytes = measured
    for (const name of names) bytes.set(name, readCustodyFile(directory, custody, name))
    assert([...bytes].reduce((sum, [, value]) => sum + value.length, 0) === measured, 'held artifact size set changed')
    custodyVerified = true
    collector = parseCanonical(bytes.get('collector.json'), 'collector manifest')
    verifySourceBinding(collector, meta)
    sourceVerified = true
    assert(
      JSON.stringify(custody.binding) === JSON.stringify(bindingFor(meta, collector.source)),
      'replay source custody'
    )
    assert(
      (await hashExecutable(process.execPath)) === collector.source.runtimeExecutableSha256,
      'Node executable bytes changed'
    )
    assert(
      collector.rawFiles.collector.size === bytes.get('collector.json').length &&
        collector.rawFiles.collector.sha256 === null,
      'collector self size'
    )
    assert(collector.safeToUpload === false, 'collector cannot self grant replay upload')
    for (let index = 0; index < IDS.length; index++) verifyCaseSummary(collector.cases[index], IDS[index])
    const shell = parseCanonical(bytes.get('collector-exit.json'), 'actual shell exit')
    exactKeys(
      shell,
      ['schema', 'sourceHead', 'runId', 'attempt', 'target', 'shellExitCode', 'custody'],
      'workflow shell receipt'
    )
    assert(
      shell.schema === SCHEMA &&
        shell.sourceHead === collector.source.head &&
        shell.runId === meta.runId &&
        shell.attempt === meta.attempt &&
        shell.target === meta.target &&
        Number.isSafeInteger(shell.shellExitCode),
      'workflow shell binding'
    )
    assert(
      JSON.stringify(shell.custody) ===
        JSON.stringify({ ...custody, phase: 'collector', files: custody.files.slice(0, 26) }),
      'exit carrier predecessor'
    )
    assert(
      JSON.stringify(collector.custody.files) ===
        JSON.stringify(custody.files.slice(0, 26).map(({ name, dev, ino }) => ({ name, dev, ino }))),
      'collector acquisition predecessor'
    )
    assert(
      JSON.stringify(collector.custody.binding) === JSON.stringify(custody.binding) &&
        JSON.stringify(collector.custody.root) === JSON.stringify(custody.root),
      'collector acquisition carrier'
    )
    parentReplay = replayGlobalParent(bytes.get('parent.events.ndjson'), admissionPrefix)
    assert(parentReplay.footer && parentReplay.footer.exitCode === shell.shellExitCode, 'collector footer/shell code')
    assert(
      parentReplay.spawnCount === collector.cases.filter((row) => row.attempted).length,
      'collector reservation releases'
    )
    assert(
      collector.cases.every((row, index) => row.attempted === index < parentReplay.spawnCount),
      'exact admitted case IDs'
    )
    const footerSize = Buffer.byteLength(JSON.stringify(parentReplay.envelopes.at(-1)) + '\n')
    assert(
      collector.rawFiles.parent.size === bytes.get('parent.events.ndjson').length - footerSize &&
        collector.rawFiles.parent.sha256 === null,
      'collector parent prefix'
    )
    exactKeys(collector.rawFiles.cases, IDS.flatMap(namesFor), 'collector raw case roster')
    let issued = 0
    let completed = 0
    for (const id of IDS) {
      const row = collector.cases[IDS.indexOf(id)]
      const content = {
        events: bytes.get(id + '.events.ndjson'),
        input: bytes.get(id + '.peer-input.bin'),
        output: bytes.get(id + '.peer-output.bin'),
        stderr: bytes.get(id + '.stderr.raw.log')
      }
      for (const [name, value] of Object.entries(content)) {
        const suffix = {
          events: '.events.ndjson',
          input: '.peer-input.bin',
          output: '.peer-output.bin',
          stderr: '.stderr.raw.log'
        }[name]
        const file = id + suffix
        const claim = collector.rawFiles.cases[file]
        exactKeys(claim, ['size', 'sha256'], 'collector raw file')
        assert(claim.size === value.length && claim.sha256 === hash(value), 'case held file digest')
        const field = {
          events: 'eventsSha256',
          input: 'peerInputSha256',
          output: 'peerOutputSha256',
          stderr: 'stderrSha256'
        }[name]
        assert(row[field] === claim.sha256, 'case summary raw digest')
      }
      if (!row.attempted) {
        assert(
          Object.values(content).every((value) => value.length === 0) &&
            !row.processClose &&
            !row.safeOwnership &&
            !row.callbackJoins &&
            !row.naturalClose &&
            !row.peer3Closed &&
            !row.peer4Closed &&
            !row.stderrClosed &&
            !row.ipcDisconnected &&
            row.exitCode === null &&
            row.signal === null &&
            row.signals.length === 0 &&
            row.sample === null &&
            row.frontier === null &&
            row.capability === 'INCOMPLETE_INFRA' &&
            row.diagnosticStatus === 'PARTIAL' &&
            row.errors.length === 0 &&
            row.stderrOverflow === false &&
            !row.terminated,
          'unattempted case must be empty'
        )
        cases.push({
          id,
          name: row.name,
          attempted: false,
          capability: 'INCOMPLETE_INFRA',
          diagnosticStatus: 'PARTIAL',
          safeClosed: false,
          callbackJoins: false,
          naturalClose: false,
          sample: null,
          frontier: null,
          errors: []
        })
        continue
      }
      const checkpoint = { ordinal: 0, bytes: 0, sha256: hash(Buffer.alloc(0)), level: 'structural' }
      casePrefixes.set(id, checkpoint)
      const parsed = parseCaseReplay(id, content.events, checkpoint)
      validateCaseTimeline(id, parsed)
      const entry = collector.source.files.find((file) => file.path === ENTRY)
      if (parsed.binding)
        assert(
          parsed.binding.sourceHead === collector.source.head &&
            parsed.binding.entryGitSha256 === entry.gitSha256 &&
            parsed.binding.entryCheckoutSha256 === entry.checkoutSha256 &&
            parsed.binding.sourceSetSha256 === collector.source.sourceSetSha256 &&
            parsed.binding.execPathSha256 === digestText(process.execPath) &&
            parsed.binding.nodeVersion === meta.runtime.nodeVersion &&
            parsed.binding.platform === meta.runtime.platform &&
            parsed.binding.arch === meta.runtime.arch &&
            JSON.stringify(parsed.binding.versions) === JSON.stringify(meta.runtime.versions),
          'child five-source/runtime binding'
        )
      const acquireFailed = parsed.childEvents.some((item) => item.op === 'acquire' && item.state === 'rejected')
      const armFailed = parsed.childEvents.some(
        (item) => item.op === 'goal' && item.state === 'rejected' && item.phase === 'setup'
      )
      const goalRefused = parsed.childEvents.some(
        (item) => item.op === 'goal' && item.state === 'rejected' && item.phase === 'goal'
      )
      checkCaseCommands(
        id,
        parsed.commands.map((item) => item.command),
        acquireFailed,
        armFailed,
        goalRefused,
        parsed.barriers.has('sample'),
        parsed.barriers.has('final')
      )
      const reduced = summarizeCase(id, parsed, content)
      assert(
        JSON.stringify(row.sample) === JSON.stringify(reduced.sample) &&
          JSON.stringify(row.frontier) === JSON.stringify(reduced.frontier),
        'sample and durable frontier mirror'
      )
      if (id === 'N04' && row.diagnosticStatus !== reduced.diagnosticStatus) {
        const ordinal = (entry) => (entry && Number.isSafeInteger(entry.ordinal) ? entry.ordinal : null)
        const endpoints = ['reader3', 'writer4'].map((endpoint) => {
          const currentEnd = parsed.timeline.find(
            (entry) => entry.item.op === 'stream-end' && entry.item.endpoint === endpoint
          )
          const parentEnd = parsed.timeline.find(
            (entry) => entry.origin === 'parent' && entry.item.op === 'stream-end' && entry.item.endpoint === endpoint
          )
          const parentClose = parsed.timeline.find(
            (entry) => entry.origin === 'parent' && entry.item.op === 'peer-close' && entry.item.endpoint === endpoint
          )
          return {
            endpoint,
            selectedEnd: currentEnd ? { ordinal: ordinal(currentEnd), origin: currentEnd.origin } : null,
            parentEndOrdinal: ordinal(parentEnd),
            parentCloseOrdinal: ordinal(parentClose),
            parentDestroyPresent: parsed.timeline.some(
              (entry) =>
                entry.origin === 'parent' && entry.item.op === 'peer-destroy' && entry.item.endpoint === endpoint
            )
          }
        })
        console.error(
          `METIS_N0_EPOCH_DIAGNOSTIC ${JSON.stringify({
            caseId: 'N04',
            collectorStatus: row.diagnosticStatus,
            replayStatus: reduced.diagnosticStatus,
            endpoints
          }).slice(0, 768)}`
        )
      }
      verifyReplayCaseClaims(id, row, reduced)
      assert(
        JSON.stringify(row.signals) === JSON.stringify(reduced.signals) &&
          JSON.stringify(row.errors) === JSON.stringify(reduced.errors) &&
          row.safeOwnership === reduced.safeClosed &&
          row.stderrOverflow === false,
        'collector physical/overflow claims'
      )
      issued += parsed.parent.filter((item) => item.op === 'ipc-send' && item.state === 'start').length
      completed += parsed.parent.filter(
        (item) => item.op === 'ipc-send' && ['fulfilled', 'rejected'].includes(item.state)
      ).length
      delete reduced._footer
      cases.push(reduced)
      checkpoint.level = 'semantic'
    }
    assert(
      parentReplay.footer.issuedSends === issued &&
        parentReplay.footer.completedSends === completed &&
        parentReplay.footer.uncaughtExceptionCount === 0 &&
        parentReplay.footer.unhandledRejectionCount === 0,
      'actual parent IPC/fatal footer'
    )
    const complete = cases.every((row) => row.attempted && row.diagnosticStatus === 'COMPLETE')
    const sockets = ['N02', 'N04', 'N06'].every((id) => {
      const row = cases.find((item) => item.id === id)
      return row?._socketQualified === true
    })
    for (const row of cases) delete row._socketQualified
    assert(collector.diagnosticStatus === (complete ? 'COMPLETE' : 'PARTIAL'), 'collector diagnostic status mirror')
    for (let index = 0; index < parentReplay.released; index++) {
      const releasedCase = cases[index]
      assert(
        releasedCase?.attempted === true &&
          releasedCase.safeClosed === true &&
          releasedCase.callbackJoins === true &&
          namesFor(IDS[index]).every((name) => custody.files.some((file) => file.name === name)),
        'released case physical and sealed writer owners'
      )
    }
    safeToUpload =
      cases.every((row) => !row.attempted || (row.safeClosed && row.callbackJoins)) &&
      parentReplay.released === parentReplay.spawnCount
    const report = {
      schema: SCHEMA,
      base: BASE,
      run: collector.run,
      source: {
        head: collector.source.head,
        files: collector.source.files,
        sourceSetSha256: collector.source.sourceSetSha256
      },
      runtime: collector.source.runtime,
      runtimeExecutableSha256: collector.source.runtimeExecutableSha256,
      hashes: Object.fromEntries(names.map((name) => [name, hash(bytes.get(name))])),
      cases,
      diagnosticStatus: complete ? 'COMPLETE' : 'PARTIAL',
      socketCapability: sockets,
      safeToUpload,
      problems,
      custody
    }
    reportAttempted = true
    const written = writeReplayReport(directory, custody, report, physicalBytes)
    emitWorkflowOutputs({
      safe_upload: safeToUpload,
      diagnostic_complete: complete,
      socket_positive: sockets,
      custody: custodyText(written.custody)
    })
    process.exitCode = safeToUpload ? 0 : 1
  } catch (error) {
    for (const reason of error instanceof AggregateError ? error.errors : [error]) {
      try {
        fs.writeSync(2, 'METIS_N0_REPLAY_FAILURE ' + String(reason?.stack || reason).slice(0, 2048) + '\n')
      } catch (logError) {
        problems.push('default replay log failed: ' + String(logError?.message ?? logError).slice(0, 120))
      }
    }
    problems.push((typeof error?.message === 'string' ? error.message : String(error)).slice(0, 240))
    for (const [id, checkpoint] of casePrefixes)
      problems.push(
        id +
          ' ' +
          checkpoint.level +
          ' prefix ordinal=' +
          checkpoint.ordinal +
          ' bytes=' +
          checkpoint.bytes +
          ' sha256=' +
          checkpoint.sha256
      )
    for (const row of cases) delete row._socketQualified
    const established = new Map(cases.map((row) => [row.id, row]))
    const report = {
      schema: SCHEMA,
      base: BASE,
      run: {
        runId: meta.runId,
        attempt: meta.attempt,
        job: meta.job,
        target: meta.target,
        ref: meta.ref,
        workflowRef: meta.workflowRef
      },
      source: sourceVerified ? collector.source : null,
      runtime: meta.runtime,
      hashes: Object.fromEntries([...bytes].map(([name, value]) => [name, hash(value)])),
      cases: IDS.map(
        (id, index) =>
          established.get(id) ?? {
            id,
            name: NAMES[index],
            attempted: admissionPrefix.attempted.has(index + 1)
              ? true
              : parentReplay?.footer && namesFor(id).every((name) => bytes.get(name)?.length === 0)
                ? false
                : null,
            capability: 'INCOMPLETE_INFRA',
            diagnosticStatus: 'INVALID',
            safeClosed: false,
            callbackJoins: false,
            errors: null
          }
      ),
      diagnosticStatus: 'INVALID',
      socketCapability: false,
      safeToUpload: false,
      measuredPhysicalBytes: physicalBytes,
      problems,
      custody
    }
    if (custodyVerified && physicalBytes !== null && !reportAttempted) {
      try {
        reportAttempted = true
        writeReplayReport(directory, custody, report, physicalBytes)
      } catch (reportError) {
        for (const reason of reportError instanceof AggregateError ? reportError.errors : [reportError]) {
          try {
            fs.writeSync(2, 'METIS_N0_INVALID_REPORT_FAILURE ' + String(reason?.stack || reason).slice(0, 2048) + '\n')
          } catch (logError) {
            problems.push('default invalid-report log failed: ' + String(logError?.message ?? logError).slice(0, 120))
          }
        }
      }
    }
    process.exitCode = 1
  }
}

export async function admitUpload() {
  const meta = provenance()
  const directory = runnerDirectory(meta)
  const custody = parseCustody(process.env.METIS_N0_CUSTODY, directory, meta, 'replay')
  assert(
    JSON.stringify(fs.readdirSync(directory).sort()) === JSON.stringify(custody.files.map((row) => row.name).sort()),
    'admission exact roster'
  )
  const bytes = new Map()
  for (const row of custody.files) bytes.set(row.name, readCustodyFile(directory, custody, row.name))
  const collector = parseAggregate(bytes.get('collector.json'), 'admission collector')
  verifySourceBinding(collector, meta, false)
  assert(JSON.stringify(custody.binding) === JSON.stringify(bindingFor(meta, collector.source)), 'admission source')
  assert(
    (await hashExecutable(process.execPath)) === collector.source.runtimeExecutableSha256,
    'admission Node executable'
  )
  const shell = parseAggregate(bytes.get('collector-exit.json'), 'admission exit')
  const report = parseAggregate(bytes.get('replay.json'), 'admission report')
  exactKeys(
    shell,
    ['schema', 'sourceHead', 'runId', 'attempt', 'target', 'shellExitCode', 'custody'],
    'admission exit receipt'
  )
  assert(
    shell.schema === SCHEMA &&
      shell.sourceHead === collector.source.head &&
      shell.runId === meta.runId &&
      shell.attempt === meta.attempt &&
      shell.target === meta.target &&
      (shell.shellExitCode === 0 || shell.shellExitCode === 1),
    'admission shell binding'
  )
  collector.cases.forEach((row, index) => verifyCaseSummary(row, IDS[index]))
  assert(
    JSON.stringify(collector.custody.files) ===
      JSON.stringify(custody.files.slice(0, 26).map(({ name, dev, ino }) => ({ name, dev, ino }))),
    'admission acquired files'
  )
  assert(
    JSON.stringify(collector.custody.binding) === JSON.stringify(custody.binding) &&
      JSON.stringify(collector.custody.root) === JSON.stringify(custody.root),
    'admission acquired root'
  )
  assert(
    JSON.stringify(shell.custody) ===
      JSON.stringify({ ...custody, phase: 'collector', files: custody.files.slice(0, 26) }),
    'admission exit predecessor'
  )
  assert(
    JSON.stringify(report.custody) === JSON.stringify({ ...custody, phase: 'exit', files: custody.files.slice(0, 27) }),
    'admission replay predecessor'
  )
  assert(
    report.safeToUpload === true &&
      ['COMPLETE', 'PARTIAL'].includes(report.diagnosticStatus) &&
      typeof report.socketCapability === 'boolean',
    'admissible replay result'
  )
  exactKeys(
    report,
    [
      'schema',
      'base',
      'run',
      'source',
      'runtime',
      'runtimeExecutableSha256',
      'hashes',
      'cases',
      'diagnosticStatus',
      'socketCapability',
      'safeToUpload',
      'problems',
      'custody'
    ],
    'admission report'
  )
  assert(
    report.schema === SCHEMA && report.base === BASE && JSON.stringify(report.run) === JSON.stringify(collector.run),
    'report run'
  )
  exactKeys(report.source, ['head', 'files', 'sourceSetSha256'], 'report source')
  assert(
    report.source.head === collector.source.head &&
      JSON.stringify(report.source.files) === JSON.stringify(collector.source.files) &&
      report.source.sourceSetSha256 === collector.source.sourceSetSha256,
    'report source set'
  )
  assert(
    report.runtimeExecutableSha256 === collector.source.runtimeExecutableSha256 &&
      JSON.stringify(report.runtime) === JSON.stringify(meta.runtime),
    'report runtime'
  )
  assert(
    Array.isArray(report.problems) &&
      report.problems.length === 0 &&
      Array.isArray(report.cases) &&
      report.cases.length === 6,
    'report semantic roster'
  )
  exactKeys(
    report.hashes,
    custody.files.slice(0, 27).map((row) => row.name),
    'report input hash roster'
  )
  for (const row of custody.files.slice(0, 27)) assert(report.hashes[row.name] === row.sha256, 'report input hash')
  for (const [index, row] of report.cases.entries()) {
    assert(row.id === IDS[index] && row.name === NAMES[index] && OUTCOMES.has(row.capability), 'report case roster')
    if (row.attempted) {
      exactKeys(
        row,
        [
          'id',
          'name',
          'attempted',
          'capability',
          'diagnosticStatus',
          'naturalClose',
          'exitCode',
          'signal',
          'sampleSeq',
          'sample',
          'frontier',
          'callbackJoins',
          'safeClosed',
          'processClose',
          'peer3Closed',
          'peer4Closed',
          'stderrClosed',
          'ipcDisconnected',
          'terminated',
          'signals',
          'errors'
        ],
        'attempted report row'
      )
      assert(
        row.safeClosed === true &&
          row.callbackJoins === true &&
          row.attempted === collector.cases[index].attempted &&
          row.capability === collector.cases[index].capability &&
          row.diagnosticStatus === collector.cases[index].diagnosticStatus,
        'attempted report owner/source mirror'
      )
      for (const key of [
        'naturalClose',
        'exitCode',
        'signal',
        'processClose',
        'peer3Closed',
        'peer4Closed',
        'stderrClosed',
        'ipcDisconnected',
        'terminated'
      ])
        assert(row[key] === collector.cases[index][key], 'report physical case field: ' + key)
      assert(
        row.sampleSeq === (row.sample?.seq ?? null) &&
          row.safeClosed === collector.cases[index].safeOwnership &&
          row.callbackJoins === collector.cases[index].callbackJoins,
        'report original case joins'
      )
      assert(
        JSON.stringify(row.sample) === JSON.stringify(collector.cases[index].sample) &&
          JSON.stringify(row.frontier) === JSON.stringify(collector.cases[index].frontier) &&
          JSON.stringify(row.signals) === JSON.stringify(collector.cases[index].signals) &&
          JSON.stringify(row.errors) === JSON.stringify(collector.cases[index].errors),
        'attempted report observations'
      )
    } else {
      exactKeys(
        row,
        [
          'id',
          'name',
          'attempted',
          'capability',
          'diagnosticStatus',
          'safeClosed',
          'callbackJoins',
          'naturalClose',
          'sample',
          'frontier',
          'errors'
        ],
        'unattempted report row'
      )
      assert(
        row.attempted === false &&
          collector.cases[index].attempted === false &&
          row.capability === 'INCOMPLETE_INFRA' &&
          row.diagnosticStatus === 'PARTIAL' &&
          row.safeClosed === false &&
          row.callbackJoins === false &&
          row.naturalClose === false &&
          row.sample === null &&
          row.frontier === null &&
          Array.isArray(row.errors) &&
          row.errors.length === 0,
        'absent report owner'
      )
    }
  }
  assert(
    report.diagnosticStatus ===
      (report.cases.every((row) => row.attempted && row.diagnosticStatus === 'COMPLETE') ? 'COMPLETE' : 'PARTIAL'),
    'report diagnostic axis'
  )
  if (report.socketCapability)
    assert(
      ['N02', 'N04', 'N06'].every((id) => {
        const row = report.cases.find((item) => item.id === id)
        return row?.capability === 'OBSERVED_GOAL' && row.diagnosticStatus === 'COMPLETE'
      }),
      'report Socket axis'
    )
  assert(
    report.cases.every((row) => !row.attempted || row.safeClosed),
    'report physical axis'
  )
  for (const row of custody.files) guardClosedVersion(directory, custody, row)
  emitWorkflowOutputs({ admitted: true })
}
