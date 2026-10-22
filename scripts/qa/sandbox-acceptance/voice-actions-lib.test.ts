import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MODIFIER_BITS } from '../../../src/shared/voice/modifier-mask'
import { VOICE_CHORD_TOKENS, voiceChordMask } from '../../../src/shared/voice/chord-tokens'
import { readModuleSource } from '../../../src/test-helpers/module-source'
import { parseWavInfo, buildWav } from './lib.mjs'
import {
  CARD_DEFAULT_BUTTON,
  CARD_TITLE,
  CHORD_TOKEN_BITS,
  CHORD_UP_LINE,
  DEFAULT_HOLD_MS,
  EARLY_RETURN_MS,
  FEED_LEAD_SECONDS,
  FEED_TRAIL_SECONDS,
  HELPER_IDLE_CPU_BUDGET_PERCENT,
  LATE_RETURN_MS,
  PRIVACY_MARKERS,
  READ_ONLY_SEQUENCE,
  RETURN_GUARD_MS,
  SHORT_HOLD_MS,
  UTTERANCES,
  VOICE_ACTIONS_STEPS,
  auditOperatorQueue,
  chordLine,
  classifyPillCopy,
  foldPillStates,
  generateUtteranceWav,
  helperCpuPercent,
  installCaptureWav,
  isLeaseOrTurnAudit,
  judgeCardOnMount,
  judgeConfirmEscape,
  judgeConfirmUncertain,
  judgeDefaultOn,
  judgeIdleCost,
  judgeIdleNoMic,
  judgeMeetingArbitration,
  judgeNoUtteranceAtRest,
  judgeQuestion,
  judgeReadOnly,
  judgeReducedMotion,
  judgeRendererReset,
  judgeReturnGuard,
  judgeShortHold,
  judgeToggleOff,
  maskForChord,
  padWavWithSilence,
  parseCssTimeMs,
  pcmOfWav,
  percentile,
  reportLeaksMarkers,
  scanTreesForMarkers,
  summarizeHelperCpu,
  sequenceEquals,
  wavFromPcm
} from './voice-actions-lib.mjs'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tmp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'va-lib-')))
  dirs.push(dir)
  return dir
}

describe('the chord FIFO protocol the harness writes', () => {
  it('mirrors the shared modifier bits exactly, for every chord token a setting can name', () => {
    expect(Object.keys(CHORD_TOKEN_BITS).sort()).toEqual([...VOICE_CHORD_TOKENS].sort())
    for (const token of VOICE_CHORD_TOKENS) expect(CHORD_TOKEN_BITS[token]).toBe(MODIFIER_BITS[token])
    expect(maskForChord(['leftControl', 'leftAlt'])).toBe(voiceChordMask(['leftControl', 'leftAlt']))
    expect(maskForChord(['rightCommand'])).toBe(MODIFIER_BITS.rightCommand)
  })

  it('refuses a token the protocol does not know and an empty chord', () => {
    expect(() => maskForChord(['unsided'])).toThrow(/unknown chord token/)
    expect(() => maskForChord([])).toThrow(/no tokens/)
  })

  it('writes lines the shared parser accepts, down with the chord and up with nothing', async () => {
    const { parseModifierLine } = await import('../../../src/shared/voice/modifier-mask')
    expect(chordLine(32)).toBe('m 32 0\n')
    expect(parseModifierLine(chordLine(32).trim())).toEqual({ mask: 32, seq: 0 })
    expect(parseModifierLine(CHORD_UP_LINE.trim())).toEqual({ mask: 0, seq: 0 })
  })

  it('the short hold is under the recognizer threshold and the long hold covers lead, phrase and trail', async () => {
    const { HOLD_THRESHOLD_MS } = await import('../../../src/shared/voice/hold-chord')
    expect(SHORT_HOLD_MS).toBeLessThan(HOLD_THRESHOLD_MS)
    expect(DEFAULT_HOLD_MS).toBeGreaterThan(FEED_LEAD_SECONDS * 1000 + 1500)
    expect(EARLY_RETURN_MS).toBeLessThan(RETURN_GUARD_MS)
    expect(LATE_RETURN_MS).toBeGreaterThan(RETURN_GUARD_MS)
  })
})

describe('synthetic WAV assembly', () => {
  it('pads a 16-bit mono WAV with the requested leading and trailing silence and keeps the speech bytes', () => {
    const speech = buildWav({ seconds: 1, kind: 'tone-bursts' })
    const padded = padWavWithSilence(speech, { leadSeconds: 1, trailSeconds: 3 })
    const info = parseWavInfo(padded)
    expect(info).toMatchObject({ sampleRate: 16_000, channels: 1, bitsPerSample: 16 })
    expect(info!.durationSeconds).toBeCloseTo(5, 3)
    const original = pcmOfWav(speech)!.pcm
    const out = pcmOfWav(padded)!.pcm
    const lead = 16_000 * 2
    expect(out.subarray(0, lead).every((byte: number) => byte === 0)).toBe(true)
    expect(out.subarray(lead, lead + original.length).equals(original)).toBe(true)
    expect(out.subarray(lead + original.length).every((byte: number) => byte === 0)).toBe(true)
  })

  it('refuses anything that is not 16-bit PCM', () => {
    expect(() => padWavWithSilence(Buffer.from('not a wav at all, definitely not'))).toThrow(/16-bit PCM/)
    expect(pcmOfWav(Buffer.alloc(10))).toBeNull()
  })

  it('wavFromPcm round-trips through the shared parser', () => {
    const wav = wavFromPcm(Buffer.alloc(32_000), 16_000, 1)
    expect(parseWavInfo(wav)!.durationSeconds).toBeCloseTo(1, 3)
  })
})

describe('generateUtteranceWav', () => {
  /** A fake `say`/`afconvert` that writes a synthetic WAV where the real afconvert would. */
  function fakeRun(options: { sayStatus?: number } = {}) {
    const calls: Array<{ file: string; args: string[] }> = []
    const run = (file: string, args: string[]) => {
      calls.push({ file, args })
      if (file === '/usr/bin/say') {
        if (options.sayStatus) return { status: options.sayStatus, error: null }
        writeFileSync(args[args.indexOf('-o') + 1], 'aiff')
        return { status: 0, error: null }
      }
      writeFileSync(args.at(-1)!, buildWav({ seconds: 2, kind: 'tone-bursts' }))
      return { status: 0, error: null }
    }
    return { run, calls }
  }

  it('hands the phrase to say through a file, never argv, and the guard-forbidden word never reaches a command line', () => {
    const root = tmp()
    const { run, calls } = fakeRun()
    const result = generateUtteranceWav({
      id: 'open-notes',
      phrase: UTTERANCES['open-notes'],
      dir: join(root, 'wavs'),
      tmp: join(root, 'tmp'),
      run
    })
    const say = calls.find((call) => call.file === '/usr/bin/say')!
    expect(say.args).toContain('-f')
    for (const call of calls) expect(call.args.join(' ')).not.toMatch(/(^|[\s/])open(\s|$)/)
    expect(call_has_no_phrase(calls, UTTERANCES['open-notes'])).toBe(true)
    expect(result).toMatchObject({ id: 'open-notes', sampleRate: 16_000 })
    expect(result.durationSeconds).toBeCloseTo(6, 0)
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
    // Only the finished WAV is left behind: the phrase file and the intermediates are removed.
    expect(readdirSync(join(root, 'tmp'))).toEqual([])
    expect(readdirSync(join(root, 'wavs'))).toEqual(['open-notes.wav'])
  })

  it('never returns the phrase', () => {
    const root = tmp()
    const result = generateUtteranceWav({
      id: 'create-note',
      phrase: UTTERANCES['create-note'],
      dir: join(root, 'w'),
      tmp: join(root, 't'),
      run: fakeRun().run
    })
    expect(JSON.stringify(result).toLowerCase()).not.toContain('groceries')
  })

  it('fails loudly, and cleans up, when speech synthesis fails', () => {
    const root = tmp()
    expect(() =>
      generateUtteranceWav({
        id: 'x',
        phrase: 'anything',
        dir: join(root, 'w'),
        tmp: join(root, 't'),
        run: fakeRun({ sayStatus: 1 }).run
      })
    ).toThrow(/speech synthesis failed for utterance x/)
    expect(readdirSync(join(root, 't'))).toEqual([])
  })

  it('swaps the capture file atomically and returns the hash of what is now there', () => {
    const root = tmp()
    mkdirSync(join(root, 'cap'))
    const first = join(root, 'a.wav')
    const second = join(root, 'b.wav')
    writeFileSync(first, buildWav({ seconds: 1 }))
    writeFileSync(second, buildWav({ seconds: 2 }))
    const capture = join(root, 'cap', 'synthetic.wav')
    const hashA = installCaptureWav(first, capture)
    const hashB = installCaptureWav(second, capture)
    expect(hashA).not.toBe(hashB)
    expect(readFileSync(capture).equals(readFileSync(second))).toBe(true)
    expect(readdirSync(join(root, 'cap'))).toEqual(['synthetic.wav'])
  })
})

function call_has_no_phrase(calls: Array<{ args: string[] }>, phrase: string): boolean {
  return calls.every((call) => !call.args.join('\n').includes(phrase))
}

describe('what the page recorded', () => {
  it('folds pill events into the states seen, collapsing repeats and dropping "no pill"', () => {
    const events = [
      { k: 'pill', state: null },
      { k: 'pill', state: 'listening' },
      { k: 'pill', state: 'listening' },
      { k: 'card', role: 'alertdialog' },
      { k: 'pill', state: 'thinking' },
      { k: 'pill', state: null },
      { k: 'pill', state: 'executing' },
      { k: 'pill', state: 'done' }
    ]
    expect(foldPillStates(events)).toEqual(['listening', 'thinking', 'executing', 'done'])
    expect(foldPillStates([])).toEqual([])
    expect(foldPillStates(undefined as never)).toEqual([])
    expect(sequenceEquals(foldPillStates(events), READ_ONLY_SEQUENCE)).toBe(true)
  })

  it('classifies pill copy into classes the report may carry, and never keeps the line', () => {
    expect(classifyPillCopy('Cancelled. Nothing was done.')).toBe('cancelled')
    expect(classifyPillCopy('Voice actions are paused while Métis records a meeting. Type your request instead.')).toBe(
      'meeting-refused'
    )
    expect(classifyPillCopy('Métis asked Notes to create “Groceries” but couldn’t confirm it worked.')).toBe(
      'uncertain'
    )
    expect(classifyPillCopy("Métis asked Notes to create “Groceries” but couldn't confirm it worked.")).toBe(
      'uncertain'
    )
    expect(classifyPillCopy('Listening…')).toBe('listening')
    expect(classifyPillCopy('Working on it…')).toBe('working')
    expect(classifyPillCopy('')).toBe('empty')
    expect(classifyPillCopy('Opened Notes')).toBe('other')
  })

  it('the meeting-refused class matches the real fixed copy, so a copy edit breaks this test and not the run', async () => {
    const { voiceReasonCopy } = await import('../../../src/shared/voice/voice-turn')
    expect(classifyPillCopy(voiceReasonCopy('meeting_recording'))).toBe('meeting-refused')
  })

  it('percentiles ignore non-numbers', () => {
    expect(percentile([5, 1, 3, Number.NaN], 0.5)).toBe(3)
    expect(percentile([], 0.5)).toBeNull()
  })

  it('recognises lease and turn audit records and nothing else', () => {
    expect(isLeaseOrTurnAudit({ event: 'voice.turn', phase: 'started' })).toBe(true)
    expect(isLeaseOrTurnAudit({ event: 'voice.turn', phase: 'refused' })).toBe(false)
    expect(isLeaseOrTurnAudit({ event: 'listen.start' })).toBe(true)
    expect(isLeaseOrTurnAudit({ event: 'voice.chord', kind: 'event' })).toBe(false)
    expect(isLeaseOrTurnAudit(null)).toBe(false)
  })
})

const okDefault = {
  storedEnabled: null,
  wakeWord: false,
  snapshot: { enabled: true },
  switchChecked: true,
  getUserMediaCalls: 0,
  leaseOrTurnAudits: 0
}

describe('judgeDefaultOn (QA build: voice actions default ON, wake word off, no microphone yet)', () => {
  it('passes for the QA default', () => {
    expect(judgeDefaultOn(okDefault)).toEqual([])
    expect(judgeDefaultOn({ ...okDefault, storedEnabled: true })).toEqual([])
  })
  it.each([
    ['an effective off', { snapshot: { enabled: false } }, /effective setting/],
    ['a stored off', { storedEnabled: false }, /stored setting/],
    ['wake word on', { wakeWord: true }, /wakeWord/],
    ['a missing switch', { switchChecked: null }, /not found/],
    ['an unchecked switch', { switchChecked: false }, /not checked/],
    ['a getUserMedia call', { getUserMediaCalls: 1 }, /getUserMedia/],
    ['a lease audit', { leaseOrTurnAudits: 2 }, /lease or voice turn/]
  ])('fails for %s', (_label, over, pattern) => {
    expect(judgeDefaultOn({ ...okDefault, ...over }).join(';')).toMatch(pattern)
  })
})

describe('the idle and short-hold judges', () => {
  it('idle passes only with the FIFO open, no microphone and no lease', () => {
    expect(
      judgeIdleNoMic({ getUserMediaCalls: 0, leaseOrTurnAudits: 0, fifoOpenAudits: 1, fifoRefusedAudits: 0 })
    ).toEqual([])
    expect(
      judgeIdleNoMic({ getUserMediaCalls: 1, leaseOrTurnAudits: 0, fifoOpenAudits: 1, fifoRefusedAudits: 0 }).join()
    ).toMatch(/getUserMedia/)
    expect(
      judgeIdleNoMic({ getUserMediaCalls: 0, leaseOrTurnAudits: 1, fifoOpenAudits: 1, fifoRefusedAudits: 0 }).join()
    ).toMatch(/lease/)
    expect(
      judgeIdleNoMic({ getUserMediaCalls: 0, leaseOrTurnAudits: 0, fifoOpenAudits: 0, fifoRefusedAudits: 0 }).join()
    ).toMatch(/never reported qa-fifo/)
    expect(
      judgeIdleNoMic({ getUserMediaCalls: 0, leaseOrTurnAudits: 0, fifoOpenAudits: 0, fifoRefusedAudits: 1 }).join()
    ).toMatch(/refused/)
  })

  it('a short hold must show no pill, no card and no lease', () => {
    expect(judgeShortHold({ pillStates: [], leaseOrTurnAudits: 0, cardEverMounted: false })).toEqual([])
    expect(judgeShortHold({ pillStates: ['listening'], leaseOrTurnAudits: 0, cardEverMounted: false }).join()).toMatch(
      /pill appeared/
    )
    expect(judgeShortHold({ pillStates: [], leaseOrTurnAudits: 1, cardEverMounted: false }).join()).toMatch(/lease/)
    expect(judgeShortHold({ pillStates: [], leaseOrTurnAudits: 0, cardEverMounted: true }).join()).toMatch(
      /card mounted/
    )
  })
})

const okRead = {
  pillStates: ['listening', 'thinking', 'executing', 'done'],
  cardEverMounted: false,
  sinkActions: ['desktop.open_notes'],
  expectedAction: 'desktop.open_notes',
  taskStoreChanged: true,
  reachedDone: true
}

describe('judgeReadOnly', () => {
  it('passes only for the exact sequence, no card, exactly one sink dispatch and a task-store change', () => {
    expect(judgeReadOnly(okRead)).toEqual([])
  })
  it.each([
    [
      'a missing state',
      { pillStates: ['listening', 'thinking', 'done'] },
      /expected listening > thinking > executing > done/
    ],
    ['a confirming state', { pillStates: ['listening', 'thinking', 'proposing', 'done'] }, /proposing/],
    ['a card', { cardEverMounted: true }, /card mounted/],
    ['no dispatch', { sinkActions: [] }, /exactly one/],
    ['two dispatches', { sinkActions: ['desktop.open_notes', 'desktop.open_notes'] }, /exactly one/],
    ['the wrong action', { sinkActions: ['desktop.open_x'] }, /exactly one/],
    ['no task', { taskStoreChanged: false }, /task store/],
    ['never done', { reachedDone: false }, /never reached done/]
  ])('fails for %s', (_label, over, pattern) => {
    expect(judgeReadOnly({ ...okRead, ...over }).join(';')).toMatch(pattern)
  })
})

const okCard = {
  role: 'alertdialog',
  title: CARD_TITLE,
  argument: '“Groceries”',
  buttons: ['Cancel', CARD_DEFAULT_BUTTON],
  focusedLabel: CARD_DEFAULT_BUTTON
}

describe('the confirmation card judges', () => {
  it('accepts the documented contract: alertdialog, main title, quoted argument, default verb focused', () => {
    expect(judgeCardOnMount({ card: okCard })).toEqual([])
  })
  it.each([
    ['no card', null, /no confirmation card/],
    ['a plain dialog', { ...okCard, role: 'dialog' }, /not "alertdialog"/],
    ['another title', { ...okCard, title: 'Confirm' }, /main-generated/],
    ['another argument', { ...okCard, argument: 'Shopping' }, /spoken note title/],
    ['focus on Cancel', { ...okCard, focusedLabel: 'Cancel' }, /default "Create"/],
    ['trailing Cancel', { ...okCard, buttons: [CARD_DEFAULT_BUTTON, 'Cancel'] }, /Cancel first/]
  ])('rejects %s', (_label, card, pattern) => {
    expect(judgeCardOnMount({ card }).join(';')).toMatch(pattern)
  })

  const okEscape = { cardProblems: [], cardGone: true, pillCopyClass: 'cancelled', sinkCount: 0, revokedCancelled: 1 }
  it('Escape: card gone, cancelled pill, sink 0 and a command.revoked cancelled audit', () => {
    expect(judgeConfirmEscape(okEscape)).toEqual([])
    expect(judgeConfirmEscape({ ...okEscape, cardGone: false }).join()).toMatch(/Escape did not remove/)
    expect(judgeConfirmEscape({ ...okEscape, pillCopyClass: 'other' }).join()).toMatch(/cancelled copy/)
    expect(judgeConfirmEscape({ ...okEscape, sinkCount: 1 }).join()).toMatch(/after Escape/)
    expect(judgeConfirmEscape({ ...okEscape, revokedCancelled: 0 }).join()).toMatch(/command\.revoked/)
    expect(judgeConfirmEscape({ ...okEscape, cardProblems: ['x'] })).toContain('x')
  })

  it('the Return guard: an early Return inside the window leaves the card and the sink alone', () => {
    expect(judgeReturnGuard({ returnDeliveredMsAfterMount: 110, cardStillPresent: true, sinkCount: 0 })).toEqual([])
    expect(judgeReturnGuard({ returnDeliveredMsAfterMount: 450, cardStillPresent: true, sinkCount: 0 }).join()).toMatch(
      /inconclusive/
    )
    expect(
      judgeReturnGuard({ returnDeliveredMsAfterMount: null, cardStillPresent: true, sinkCount: 0 }).join()
    ).toMatch(/could not be delivered/)
    expect(
      judgeReturnGuard({ returnDeliveredMsAfterMount: 110, cardStillPresent: false, sinkCount: 0 }).join()
    ).toMatch(/went away/)
    expect(judgeReturnGuard({ returnDeliveredMsAfterMount: 110, cardStillPresent: true, sinkCount: 1 }).join()).toMatch(
      /after an early Return/
    )
  })

  const okUncertain = {
    returnDeliveredMsAfterMount: 520,
    sinkCreateNoteCount: 1,
    uncertainAudits: 1,
    pillCopyClass: 'uncertain',
    recoveredUncertain: 1,
    sinkCountAfterRelaunch: 1
  }
  it('uncertain: one dispatch, one uncertain task, recovery reports it and nothing is replayed', () => {
    expect(judgeConfirmUncertain(okUncertain)).toEqual([])
    expect(judgeConfirmUncertain({ ...okUncertain, returnDeliveredMsAfterMount: 200 }).join()).toMatch(/guard/)
    expect(judgeConfirmUncertain({ ...okUncertain, sinkCreateNoteCount: 2 }).join()).toMatch(/expected 1/)
    expect(judgeConfirmUncertain({ ...okUncertain, uncertainAudits: 0 }).join()).toMatch(/task\.effect_uncertain/)
    expect(judgeConfirmUncertain({ ...okUncertain, pillCopyClass: 'other' }).join()).toMatch(/uncertain copy/)
    expect(judgeConfirmUncertain({ ...okUncertain, recoveredUncertain: 0 }).join()).toMatch(/recovery after relaunch/)
    expect(judgeConfirmUncertain({ ...okUncertain, sinkCountAfterRelaunch: 2 }).join()).toMatch(/replayed/)
  })
})

describe('the question, meeting, reload, toggle and motion judges', () => {
  it('a question reaches the mock LLM exactly once and dispatches nothing', () => {
    expect(judgeQuestion({ questionRequests: 1, sinkCount: 0, answerShown: true })).toEqual([])
    expect(judgeQuestion({ questionRequests: 0, sinkCount: 0, answerShown: true }).join()).toMatch(/exactly 1/)
    expect(judgeQuestion({ questionRequests: 2, sinkCount: 0, answerShown: true }).join()).toMatch(/exactly 1/)
    expect(judgeQuestion({ questionRequests: 1, sinkCount: 1, answerShown: true }).join()).toMatch(/dispatch/)
    expect(judgeQuestion({ questionRequests: 1, sinkCount: 0, answerShown: false }).join()).toMatch(/answer view/)
  })

  it('a hold during a meeting is refused and the meeting keeps recording', () => {
    const ok = {
      pillCopyClass: 'meeting-refused',
      voiceStartedAudits: 0,
      meetingRevokeAudits: 0,
      draftBefore: 100,
      draftAfter: 180
    }
    expect(judgeMeetingArbitration(ok)).toEqual([])
    expect(judgeMeetingArbitration({ ...ok, pillCopyClass: 'other' }).join()).toMatch(/refused-during-a-meeting/)
    expect(judgeMeetingArbitration({ ...ok, voiceStartedAudits: 1 }).join()).toMatch(/voice turn/)
    expect(judgeMeetingArbitration({ ...ok, meetingRevokeAudits: 1 }).join()).toMatch(/revoke or restart/)
    expect(judgeMeetingArbitration({ ...ok, draftAfter: 100 }).join()).toMatch(/did not keep growing/)
  })

  it('a reload mid-listening revokes the lease, cancels the turn and proposes and dispatches nothing', () => {
    const ok = { revokedRendererReset: 1, proposalPills: 0, sinkCount: 0, turnCancelled: true }
    expect(judgeRendererReset(ok)).toEqual([])
    expect(judgeRendererReset({ ...ok, revokedRendererReset: 0 }).join()).toMatch(/renderer-reset/)
    expect(judgeRendererReset({ ...ok, turnCancelled: false }).join()).toMatch(/not cancelled/)
    expect(judgeRendererReset({ ...ok, proposalPills: 1 }).join()).toMatch(/proposal/)
    expect(judgeRendererReset({ ...ok, sinkCount: 1 }).join()).toMatch(/dispatch/)
  })

  it('toggling off stops the watcher within a second, shows no pill, and turning on restores it', () => {
    const ok = { watcherStoppedMs: 300, fifoClosed: true, pillAppeared: false, restored: true }
    expect(judgeToggleOff(ok)).toEqual([])
    expect(judgeToggleOff({ ...ok, fifoClosed: false }).join()).toMatch(/never closed/)
    expect(judgeToggleOff({ ...ok, watcherStoppedMs: 1500 }).join()).toMatch(/over 1000 ms/)
    expect(judgeToggleOff({ ...ok, pillAppeared: true }).join()).toMatch(/pill appeared/)
    expect(judgeToggleOff({ ...ok, restored: false }).join()).toMatch(/reopen/)
  })

  it('reduced motion allows only a liveness breathe to keep running', () => {
    const base = { pillPresent: true, mediaMatches: true }
    expect(
      judgeReducedMotion({
        ...base,
        animations: [
          { name: 'voice-pill-in', duration: '0s' },
          { name: 'voice-breathe', duration: '1.6s' }
        ]
      })
    ).toEqual([])
    expect(
      judgeReducedMotion({ ...base, animations: [{ name: 'overlay-peek-in', duration: '150ms' }] }).join()
    ).toMatch(/runs 150 ms/)
    expect(judgeReducedMotion({ ...base, animations: [{ name: 'x', duration: 'garbage' }] }).join()).toMatch(
      /unreadable/
    )
    expect(judgeReducedMotion({ pillPresent: true, mediaMatches: false, animations: [] }).join()).toMatch(
      /did not match/
    )
    expect(judgeReducedMotion({ pillPresent: false, mediaMatches: true, animations: [] }).join()).toMatch(/no pill/)
    expect(parseCssTimeMs('0.15s, 0s')).toBe(150)
    expect(parseCssTimeMs('220ms')).toBe(220)
    expect(parseCssTimeMs('')).toBeNull()
  })
})

describe('privacy at rest', () => {
  it('finds each marker case-insensitively, counts them, and never reports a matching path or any text', () => {
    const root = tmp()
    mkdirSync(join(root, 'logs'))
    mkdirSync(join(root, 'meetings'))
    writeFileSync(join(root, 'logs', 'audit.log'), '{"event":"voice.turn"}\n')
    writeFileSync(join(root, 'meetings', 'note.md'), 'GROCERIES and groceries, then the Capital of France')
    const scan = scanTreesForMarkers([root])
    expect(scan.hits).toEqual({ groceries: 2, capital: 1, france: 1 })
    expect(scan.totalHits).toBe(4)
    expect(scan.files).toBe(2)
    expect(scan.hitFiles).toEqual(
      expect.arrayContaining([{ area: 'meetings', extension: '.md', marker: 'groceries', count: 2 }])
    )
    expect(JSON.stringify(scan)).not.toMatch(/note\.md|the capital/i)
  })

  it('a clean tree has zero hits, and excluded paths are not read', () => {
    const root = tmp()
    writeFileSync(join(root, 'settings.json'), '{"voiceActions":{"enabled":null}}')
    writeFileSync(join(root, 'fixture.txt'), 'groceries')
    const scan = scanTreesForMarkers([root], PRIVACY_MARKERS, { exclude: (path) => path.endsWith('fixture.txt') })
    expect(scan.totalHits).toBe(0)
    expect(scan.files).toBe(1)
  })

  it('counts unreadable and oversized entries instead of treating them as clean', () => {
    const fake = {
      readdirSync: (dir: string) => (dir === '/r' ? ['big', 'bad'] : []),
      statSync: (path: string) => {
        if (path.endsWith('bad')) throw new Error('EACCES')
        return { isDirectory: () => false, isFile: () => true, size: 70 * 1024 * 1024 }
      },
      readFileSync: () => Buffer.alloc(0)
    }
    const scan = scanTreesForMarkers(['/r'], PRIVACY_MARKERS, { fs: fake as never })
    expect(scan).toMatchObject({ files: 0, skippedLarge: 1, unreadable: 1 })
  })

  it('audits the operator queue: only the allowlisted keys of a voice_action entry may be present', () => {
    const entry = (body: object) => ({ path: '/v1/ingest', body })
    const good = {
      event: 'voice_action',
      id: 'va-1',
      ts: 1,
      source: 'hold',
      actionId: 'desktop.open_notes',
      class: 'read',
      outcome: 'done',
      latencyBucket: 'under_1s',
      seatHash: 'abc'
    }
    expect(auditOperatorQueue(null)).toMatchObject({ present: false })
    expect(
      auditOperatorQueue(JSON.stringify({ items: [entry(good), entry({ event: 'listen', id: 'x', anything: 1 })] }))
    ).toMatchObject({
      present: true,
      entries: 2,
      voiceActionEntries: 1,
      disallowedKeys: [],
      unreadable: false
    })
    expect(
      auditOperatorQueue(JSON.stringify([entry({ ...good, transcript: 'x', title: 'y' })])).disallowedKeys
    ).toEqual(['title', 'transcript'])
    expect(auditOperatorQueue('{not json')).toMatchObject({ unreadable: true })
  })

  it('judges the whole at-rest step from the scan and the queue', () => {
    const queue = {
      present: false,
      entries: 0,
      voiceActionEntries: 0,
      disallowedKeys: [] as string[],
      unreadable: false
    }
    const clean = { files: 5, hits: { groceries: 0, capital: 0, france: 0 } }
    expect(judgeNoUtteranceAtRest({ scan: clean as never, queue })).toEqual([])
    expect(judgeNoUtteranceAtRest({ scan: { files: 0, hits: {} } as never, queue }).join()).toMatch(/read no files/)
    expect(
      judgeNoUtteranceAtRest({
        scan: { files: 5, hits: { groceries: 2, capital: 0, france: 0 } } as never,
        queue
      }).join()
    ).toMatch(/2 hit/)
    expect(
      judgeNoUtteranceAtRest({ scan: clean as never, queue: { ...queue, disallowedKeys: ['title'] } }).join()
    ).toMatch(/title/)
    expect(judgeNoUtteranceAtRest({ scan: clean as never, queue: { ...queue, unreadable: true } }).join()).toMatch(
      /not valid JSON/
    )
    // The message names a marker by number: it must not print the spoken word.
    expect(
      judgeNoUtteranceAtRest({ scan: { files: 5, hits: { groceries: 2, capital: 0, france: 0 } } as never, queue })
        .join()
        .toLowerCase()
    ).not.toContain('groceries')
  })
})

describe('a report never carries what was said', () => {
  it('finds a spoken marker anywhere in a report, whatever its case', () => {
    expect(reportLeaksMarkers({ steps: [{ evidence: { note: 'created GROCERIES' } }] })).toEqual(['groceries'])
    expect(reportLeaksMarkers({ steps: [{ evidence: { counts: 3, states: ['listening'] } }] })).toEqual([])
  })
})

describe('helper CPU for the idle-cost soak', () => {
  const sample = (tMs: number, cpuSeconds: number | null, kind = 'chord-helper') => ({
    tMs,
    processes: [
      { pid: 9, kind, cpuSeconds },
      { pid: 1, kind: 'main', cpuSeconds: 100 }
    ]
  })

  it('is the helper CPU seconds over the wall seconds, as a percent of one core', () => {
    expect(helperCpuPercent([sample(0, 1.0), sample(600_000, 1.3)])).toBeCloseTo(0.05, 5)
  })

  it('ignores other processes, unreadable samples and a single sample', () => {
    expect(helperCpuPercent([sample(0, 1, 'main'), sample(60_000, 2, 'main')])).toBeNull()
    expect(helperCpuPercent([sample(0, 1)])).toBeNull()
    expect(helperCpuPercent([sample(0, null), sample(60_000, null)])).toBeNull()
  })

  it('summarises the idle phase of a soak: samples that saw the helper and their mean CPU, advisory only', () => {
    const samples = [sample(0, 1), sample(300_000, 1.15), sample(600_000, 1.3), sample(700_000, 9)]
    const summary = summarizeHelperCpu(samples, [
      { id: 'idle', startMs: 0, endMs: 600_000 },
      { id: 'meeting', startMs: 600_000, endMs: 900_000 }
    ])
    expect(summary).toMatchObject({ phase: 'idle', samplesWithHelper: 3, budgetPercent: 0.1, advisory: true })
    expect(summary.meanOneCorePercent).toBeCloseTo(0.05, 5)
    expect(
      summarizeHelperCpu([sample(0, 1, 'main')], [{ id: 'idle', startMs: 0, endMs: 10 }]).meanOneCorePercent
    ).toBeNull()
    expect(summarizeHelperCpu([], []).samplesWithHelper).toBe(0)
  })

  it('passes within the 0.1 percent budget and fails over it or without enough samples', () => {
    expect(HELPER_IDLE_CPU_BUDGET_PERCENT).toBe(0.1)
    expect(judgeIdleCost({ samples: [sample(0, 1), sample(600_000, 1.3)], helperSamples: 21 }).problems).toEqual([])
    expect(judgeIdleCost({ samples: [sample(0, 1), sample(600_000, 2)], helperSamples: 21 }).problems.join()).toMatch(
      /over 0.1%/
    )
    expect(judgeIdleCost({ samples: [sample(0, 1)], helperSamples: 1 }).problems.join()).toMatch(/at least 2/)
  })
})

describe('the step list', () => {
  it('names every design step once, in the design order, between launch and quit', () => {
    expect(new Set(VOICE_ACTIONS_STEPS).size).toBe(VOICE_ACTIONS_STEPS.length)
    const design = [
      'va-default-on',
      'va-idle-no-mic',
      'va-short-hold-ignored',
      'va-read-only-immediate',
      'va-confirm-escape',
      'va-return-guard',
      'va-confirm-return-uncertain',
      'va-question',
      'va-meeting-arbitration',
      'va-renderer-reset-revokes',
      'va-toggle-off-instant',
      'va-no-utterance-at-rest',
      'va-reduced-motion',
      'va-idle-cost'
    ]
    const positions = design.map((id) => VOICE_ACTIONS_STEPS.indexOf(id))
    expect(positions.every((position) => position > 0)).toBe(true)
    expect(VOICE_ACTIONS_STEPS[0]).toBe('launch-and-renderer-ready')
    // The scan reads the profile after the app quit, so every late write has landed.
    expect(VOICE_ACTIONS_STEPS.at(-1)).toBe('va-no-utterance-at-rest')
    expect(VOICE_ACTIONS_STEPS.indexOf('final-quit')).toBe(VOICE_ACTIONS_STEPS.length - 2)
    // The at-rest scan runs after every step that speaks; reduced motion and idle cost need nothing spoken.
    expect(VOICE_ACTIONS_STEPS.indexOf('va-no-utterance-at-rest')).toBeGreaterThan(
      VOICE_ACTIONS_STEPS.indexOf('va-meeting-arbitration')
    )
    expect(VOICE_ACTIONS_STEPS.indexOf('va-no-utterance-at-rest')).toBeGreaterThan(
      VOICE_ACTIONS_STEPS.indexOf('va-question')
    )
  })

  it('the Speech switch label the harness looks for is the one the app renders', () => {
    const source = readModuleSource(__dirname, '../../../src/renderer/src/features/settings/VoiceActionsSection').text
    expect(source).toContain("toggleLabel: 'Use voice actions'")
  })

  it('the spoken markers cover each utterance that must not persist', () => {
    for (const text of [UTTERANCES['create-note'], UTTERANCES.question])
      expect(PRIVACY_MARKERS.some((marker) => text.toLowerCase().includes(marker))).toBe(true)
  })
})
