// V08 sandbox acceptance, `--scenario voice-actions`: the pure parts (no app, no CDP). The step functions live in
// voice-actions.mjs and call these to turn what they observed into a verdict, so every judgement is unit-tested here.
//
// Reports carry counts, states, timings and hashes, NEVER transcript text. The phrases below are only ever handed to the
// macOS `say` tool through a file; they are not copied into a report, an evidence object or an error message.
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parseWavInfo } from './lib.mjs'

/** Ordered step ids of the scenario, as `--dry-run` prints them (design section 13). */
export const VOICE_ACTIONS_STEPS = Object.freeze([
  'launch-and-renderer-ready',
  'va-audio-prepared',
  'va-default-on',
  'va-idle-no-mic',
  'va-short-hold-ignored',
  'va-read-only-immediate',
  'va-confirm-escape',
  'va-return-guard',
  'va-confirm-return-uncertain',
  'va-uncertain-reader-details',
  'va-question',
  'va-meeting-arbitration',
  'va-renderer-reset-revokes',
  'va-toggle-off-instant',
  'va-reduced-motion',
  'va-idle-cost',
  'final-quit',
  'va-no-utterance-at-rest'
])

/** Words that must appear nowhere at rest after the run (case-insensitive). They come from the spoken phrases. */
export const PRIVACY_MARKERS = Object.freeze(['groceries', 'capital', 'france'])

/** The synthetic phrases, spoken by `say` (en voice). Never reported; the report names them by id only. */
export const UTTERANCES = Object.freeze({
  'open-notes': 'open Notes',
  'create-note': 'create a note called groceries',
  question: 'what is the capital of France'
})

export const FEED_LEAD_SECONDS = 1
export const FEED_TRAIL_SECONDS = 3
/** Hold time that covers the lead silence, the phrase and a little of the trail. */
export const DEFAULT_HOLD_MS = 3_500
/** The recognizer's threshold is 250 ms; a "short" hold must stay clearly under it. */
export const SHORT_HOLD_MS = 120
/** The card's Return guard window (design 1.3) and the two probe times around it. */
export const RETURN_GUARD_MS = 300
export const EARLY_RETURN_MS = 100
export const LATE_RETURN_MS = 500
export const WARM_RELEASE_TO_DONE_BUDGET_MS = 1_500
export const TOGGLE_OFF_BUDGET_MS = 1_000

// ---------------------------------------------------------------------------------------------------------------
// The chord FIFO protocol (src/shared/voice/modifier-mask.ts): `m <modifierMask> <otherInputSeq>`

/** Mirrors MODIFIER_BITS for the chord tokens a setting can name; a unit test pins it to the shared source. */
export const CHORD_TOKEN_BITS = Object.freeze({
  leftControl: 1,
  rightControl: 2,
  leftAlt: 4,
  rightAlt: 8,
  leftCommand: 16,
  rightCommand: 32,
  leftShift: 64,
  rightShift: 128,
  fn: 256
})

/** The mask for a list of chord tokens; throws on a token the protocol does not know. */
export function maskForChord(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) throw new Error('the hold chord has no tokens')
  return tokens.reduce((mask, token) => {
    const bit = CHORD_TOKEN_BITS[token]
    if (!bit) throw new Error(`unknown chord token ${JSON.stringify(token)}`)
    return mask | bit
  }, 0)
}

/** One protocol line. `seq` stays 0 because the scenario presses no other key. */
export const chordLine = (mask, seq = 0) => `m ${mask} ${seq}\n`
export const CHORD_UP_LINE = chordLine(0)

// ---------------------------------------------------------------------------------------------------------------
// Synthetic WAV assembly

/** The PCM of a 16-bit integer WAV, or null for any other format. */
export function pcmOfWav(buffer) {
  const info = parseWavInfo(buffer)
  if (!info) return null
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    if (id === 'data') {
      return {
        sampleRate: info.sampleRate,
        channels: info.channels,
        pcm: buffer.subarray(offset + 8, offset + 8 + Math.min(size, buffer.length - offset - 8))
      }
    }
    offset += 8 + size + (size % 2)
  }
  return null
}

/** A canonical 16-bit PCM WAV around raw PCM. */
export function wavFromPcm(pcm, sampleRate, channels = 1) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Leading and trailing digital silence around a spoken phrase: the hold opens before the phrase and ends after it. */
export function padWavWithSilence(wav, { leadSeconds = FEED_LEAD_SECONDS, trailSeconds = FEED_TRAIL_SECONDS } = {}) {
  const parsed = pcmOfWav(wav)
  if (!parsed) throw new Error('the synthesised phrase is not 16-bit PCM WAV')
  const frameBytes = parsed.channels * 2
  const silence = (seconds) => Buffer.alloc(Math.round(seconds * parsed.sampleRate) * frameBytes)
  return wavFromPcm(
    Buffer.concat([silence(leadSeconds), parsed.pcm, silence(trailSeconds)]),
    parsed.sampleRate,
    parsed.channels
  )
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/**
 * Synthesise one phrase into `<dir>/<id>.wav` with macOS `say` and `afconvert` (16 kHz mono 16-bit), padded with silence.
 * The phrase goes to `say` through a file (`-f`), never as an argument: the guard refuses a command line that contains the
 * word "open", and a phrase must not travel through argv anyway. Returns counts and a hash, never the phrase.
 * @param {{ id: string, phrase: string, dir: string, tmp: string, run: (file: string, args: string[], options?: object) => { status: number | null, error: string | null } }} args
 */
export function generateUtteranceWav({ id, phrase, dir, tmp, run }) {
  mkdirSync(dir, { recursive: true })
  mkdirSync(tmp, { recursive: true })
  const phraseFile = join(tmp, `va-${id}.txt`)
  const aiff = join(tmp, `va-${id}.aiff`)
  const raw = join(tmp, `va-${id}.raw.wav`)
  const out = join(dir, `${id}.wav`)
  try {
    writeFileSync(phraseFile, `${phrase}\n`, { mode: 0o600 })
    const say = run('/usr/bin/say', ['-o', aiff, '-f', phraseFile], { timeoutMs: 120_000 })
    if (say.status !== 0)
      throw new Error(
        `speech synthesis failed for utterance ${id} (/usr/bin/say exit ${say.status}${say.error ? `: ${say.error}` : ''})`
      )
    const convert = run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, raw], {
      timeoutMs: 120_000
    })
    if (convert.status !== 0)
      throw new Error(
        `afconvert failed for utterance ${id} (exit ${convert.status}${convert.error ? `: ${convert.error}` : ''})`
      )
    const spoken = readFileSync(raw)
    const padded = padWavWithSilence(spoken)
    writeFileSync(out, padded)
    const info = parseWavInfo(padded)
    const speechInfo = parseWavInfo(spoken)
    return {
      id,
      path: out,
      sha256: sha256(padded),
      bytes: padded.length,
      sampleRate: info.sampleRate,
      durationSeconds: Math.round(info.durationSeconds * 10) / 10,
      speechSeconds: Math.round((speechInfo?.durationSeconds ?? 0) * 10) / 10
    }
  } finally {
    for (const file of [phraseFile, aiff, raw]) rmSync(file, { force: true })
  }
}

/** Make `source` the file Chromium's fake microphone reads. Written beside it and renamed, so a reader never sees a half file. */
export function installCaptureWav(source, captureWav) {
  const next = `${captureWav}.next`
  copyFileSync(source, next)
  renameSync(next, captureWav)
  return sha256(readFileSync(captureWav))
}

// ---------------------------------------------------------------------------------------------------------------
// What the page recorded, folded into states and judgements

/** Pill states in the order they appeared, consecutive repeats collapsed and "no pill" dropped. */
export function foldPillStates(events) {
  const states = []
  for (const event of events ?? []) {
    if (event?.k !== 'pill' || !event.state) continue
    if (states.at(-1) !== event.state) states.push(event.state)
  }
  return states
}

export const sequenceEquals = (left, right) =>
  left.length === right.length && left.every((value, index) => value === right[index])

/** The first event of a kind (and optionally state), or null. */
export const firstEvent = (events, predicate) => (events ?? []).find(predicate) ?? null

/**
 * What kind of line a pill showed, without keeping the line. A pill can quote the person's own words (an uncertain
 * outcome names the note), so the report only ever carries one of these classes.
 */
export function classifyPillCopy(title) {
  const text = String(title ?? '').trim()
  if (/^Cancelled\. Nothing was done\.?$/.test(text)) return 'cancelled'
  if (/paused while Métis records a meeting/i.test(text)) return 'meeting-refused'
  if (/couldn.t confirm/i.test(text)) return 'uncertain'
  if (/^Listening/.test(text)) return 'listening'
  if (/^Working on it/.test(text)) return 'working'
  if (text === '') return 'empty'
  return 'other'
}

export function percentile(values, fraction) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}

export const median = (values) => percentile(values, 0.5)

/** Audit records that mean a microphone lease or a voice turn started. */
export function isLeaseOrTurnAudit(record) {
  if (!record || typeof record.event !== 'string') return false
  if (record.event === 'voice.turn') return record.phase === 'started'
  return /^(listen\.|mic\.|input[-_.]session|command\.mic)/.test(record.event)
}

const auditCount = (records, predicate) => (records ?? []).filter(predicate).length
export const auditCountOf = (records, event, where = () => true) =>
  auditCount(records, (record) => record?.event === event && where(record))

/** One problem list per step, thrown together by `shapeObservation` in settings-hig.mjs. */
export function judgeDefaultOn({
  storedEnabled,
  wakeWord,
  snapshot,
  switchChecked,
  getUserMediaCalls,
  leaseOrTurnAudits
}) {
  const problems = []
  if (snapshot?.enabled !== true)
    problems.push(`the effective setting is ${JSON.stringify(snapshot?.enabled)}, not on in a QA build`)
  if (storedEnabled !== null && storedEnabled !== true)
    problems.push(
      `the stored setting is ${JSON.stringify(storedEnabled)}: a fresh profile should follow the build default (null) or be on`
    )
  if (wakeWord !== false) problems.push(`wakeWord is ${JSON.stringify(wakeWord)}, not off`)
  if (switchChecked === null) problems.push('the Speech switch for voice actions was not found')
  else if (switchChecked !== true) problems.push('the Speech switch is not checked')
  if (getUserMediaCalls !== 0) problems.push(`getUserMedia was called ${getUserMediaCalls} time(s) before any hold`)
  if (leaseOrTurnAudits !== 0)
    problems.push(`${leaseOrTurnAudits} microphone lease or voice turn audit record(s) before any hold`)
  return problems
}

export function judgeIdleNoMic({ getUserMediaCalls, leaseOrTurnAudits, fifoOpenAudits, fifoRefusedAudits }) {
  const problems = []
  if (getUserMediaCalls !== 0) problems.push(`getUserMedia was called ${getUserMediaCalls} time(s) while idle`)
  if (leaseOrTurnAudits !== 0)
    problems.push(`${leaseOrTurnAudits} microphone lease or voice turn audit record(s) while idle`)
  if (fifoRefusedAudits > 0) problems.push('the chord FIFO source refused its request, so the watcher has no source')
  else if (fifoOpenAudits < 1) problems.push('the watcher source never reported qa-fifo (no qa.chord_fifo open audit)')
  return problems
}

export function judgeShortHold({ pillStates, leaseOrTurnAudits, cardEverMounted }) {
  const problems = []
  if (pillStates.length)
    problems.push(`a voice pill appeared (states ${pillStates.join(' > ')}) for a ${SHORT_HOLD_MS} ms hold`)
  if (leaseOrTurnAudits !== 0)
    problems.push(`${leaseOrTurnAudits} microphone lease or voice turn audit record(s) for a short hold`)
  if (cardEverMounted) problems.push('a card mounted for a short hold')
  return problems
}

export const READ_ONLY_SEQUENCE = Object.freeze(['listening', 'thinking', 'executing', 'done'])

export function judgeReadOnly({
  pillStates,
  cardEverMounted,
  sinkActions,
  expectedAction,
  taskStoreChanged,
  reachedDone
}) {
  const problems = []
  if (!sequenceEquals(pillStates, READ_ONLY_SEQUENCE))
    problems.push(`the pill went ${pillStates.join(' > ') || '(nothing)'}, expected ${READ_ONLY_SEQUENCE.join(' > ')}`)
  if (!reachedDone) problems.push('the pill never reached done')
  if (cardEverMounted) problems.push('a confirmation card mounted for a read-only action')
  if (sinkActions.length !== 1 || sinkActions[0] !== expectedAction)
    problems.push(`the sink recorded ${JSON.stringify(sinkActions)}, expected exactly one ${expectedAction}`)
  if (!taskStoreChanged) problems.push('the task store did not change (no durable task was written for the dispatch)')
  return problems
}

/** The confirmation card contract (design 1.5): alertdialog, main-generated title and argument, default verb focused. */
export const CARD_TITLE = 'Create a note in Notes'
export const CARD_DEFAULT_BUTTON = 'Create'

export function judgeCardOnMount({
  card,
  expectedTitle = CARD_TITLE,
  expectedArgumentMatch = /^groceries$/i,
  defaultButton = CARD_DEFAULT_BUTTON
}) {
  const problems = []
  if (!card) return ['no confirmation card mounted']
  if (card.role !== 'alertdialog') problems.push(`the card has role ${JSON.stringify(card.role)}, not "alertdialog"`)
  if (card.title !== expectedTitle) problems.push('the card title is not the main-generated one for this action')
  if (
    !expectedArgumentMatch.test(
      String(card.argument ?? '')
        .replace(/[“”"']/g, '')
        .trim()
    )
  )
    problems.push('the card argument does not show the spoken note title')
  if (card.focusedLabel !== defaultButton)
    problems.push(`focus is on ${JSON.stringify(card.focusedLabel)}, not the default "${defaultButton}"`)
  if (!Array.isArray(card.buttons) || card.buttons[0] !== 'Cancel' || card.buttons.at(-1) !== defaultButton)
    problems.push(`the buttons are ${JSON.stringify(card.buttons)}, expected Cancel first and ${defaultButton} last`)
  return problems
}

export function judgeConfirmEscape({ cardProblems, cardGone, pillCopyClass, sinkCount, revokedCancelled }) {
  const problems = [...cardProblems]
  if (!cardGone) problems.push('Escape did not remove the card')
  if (pillCopyClass !== 'cancelled')
    problems.push(`the pill after Escape was "${pillCopyClass}", not the cancelled copy`)
  if (sinkCount !== 0) problems.push(`the sink recorded ${sinkCount} dispatch(es) after Escape, expected 0`)
  if (revokedCancelled < 1) problems.push('no command.revoked audit with reason=cancelled')
  return problems
}

export function judgeReturnGuard({ returnDeliveredMsAfterMount, cardStillPresent, sinkCount }) {
  const problems = []
  if (returnDeliveredMsAfterMount === null) problems.push('the Return key could not be delivered')
  else if (returnDeliveredMsAfterMount >= RETURN_GUARD_MS)
    problems.push(
      `Return reached the page ${returnDeliveredMsAfterMount} ms after mount, outside the ${RETURN_GUARD_MS} ms guard window (inconclusive)`
    )
  if (!cardStillPresent) problems.push('the card went away after an early Return')
  if (sinkCount !== 0) problems.push(`the sink recorded ${sinkCount} dispatch(es) after an early Return, expected 0`)
  return problems
}

export function judgeConfirmUncertain({
  returnDeliveredMsAfterMount,
  sinkCreateNoteCount,
  uncertainAudits,
  pillCopyClass,
  recoveredUncertain,
  sinkCountAfterRelaunch
}) {
  const problems = []
  if (returnDeliveredMsAfterMount === null || returnDeliveredMsAfterMount < RETURN_GUARD_MS)
    problems.push(`Return was not delivered after the ${RETURN_GUARD_MS} ms guard (${returnDeliveredMsAfterMount} ms)`)
  if (sinkCreateNoteCount !== 1)
    problems.push(`the sink recorded ${sinkCreateNoteCount} desktop.create_note dispatch(es), expected 1`)
  if (uncertainAudits !== 1) problems.push(`${uncertainAudits} task.effect_uncertain audit record(s), expected 1`)
  if (pillCopyClass !== 'uncertain')
    problems.push(`the pill after Return was "${pillCopyClass}", not the uncertain copy`)
  if (recoveredUncertain !== 1)
    problems.push(`recovery after relaunch reported ${recoveredUncertain} uncertain task(s), expected 1`)
  if (sinkCountAfterRelaunch !== 1)
    problems.push(
      `the sink recorded ${sinkCountAfterRelaunch} create-note dispatch(es) after relaunch: an uncertain task was replayed`
    )
  return problems
}

export function judgeQuestion({ questionRequests, sinkCount, answerShown }) {
  const problems = []
  if (questionRequests !== 1)
    problems.push(`the mock LLM received ${questionRequests} request(s) carrying the question, expected exactly 1`)
  if (sinkCount !== 0) problems.push(`the sink recorded ${sinkCount} dispatch(es) for a question`)
  if (!answerShown) problems.push('the answer view never showed the mock answer')
  return problems
}

export function judgeMeetingArbitration({
  pillCopyClass,
  voiceStartedAudits,
  meetingRevokeAudits,
  draftBefore,
  draftAfter
}) {
  const problems = []
  if (pillCopyClass !== 'meeting-refused')
    problems.push(`the pill said "${pillCopyClass}", not the refused-during-a-meeting copy`)
  if (voiceStartedAudits !== 0)
    problems.push(`${voiceStartedAudits} voice turn / lease start(s) during a meeting, expected 0`)
  if (meetingRevokeAudits !== 0)
    problems.push(`${meetingRevokeAudits} revoke or restart audit record(s) on the meeting capture`)
  if (!(draftAfter > draftBefore))
    problems.push(`the meeting autosave draft did not keep growing (${draftBefore} -> ${draftAfter} bytes)`)
  return problems
}

export function judgeRendererReset({ revokedRendererReset, proposalPills, sinkCount, turnCancelled }) {
  const problems = []
  if (revokedRendererReset < 1) problems.push('no lease revoked with reason renderer-reset')
  if (!turnCancelled) problems.push('the voice turn was not cancelled')
  if (proposalPills > 0) problems.push('a proposal was produced after the reload')
  if (sinkCount !== 0) problems.push(`the sink recorded ${sinkCount} dispatch(es) after a reload mid-listening`)
  return problems
}

export function judgeToggleOff({ watcherStoppedMs, fifoClosed, pillAppeared, restored }) {
  const problems = []
  if (!fifoClosed) problems.push('the chord FIFO source never closed after the switch went off')
  else if (watcherStoppedMs > TOGGLE_OFF_BUDGET_MS)
    problems.push(`the watcher stopped after ${watcherStoppedMs} ms, over ${TOGGLE_OFF_BUDGET_MS} ms`)
  if (pillAppeared) problems.push('a pill appeared for a hold while voice actions were off')
  if (!restored) problems.push('turning voice actions back on did not reopen the chord FIFO source')
  return problems
}

/**
 * Reduced motion: every pill animation is zero length except the liveness breathe (the level bars and the working ring).
 * `animations` are the computed `animation-duration` and `animation-name` pairs of the pill and its descendants.
 */
export const LIVENESS_ANIMATION_NAMES = /breathe|pulse|rec-dot|ring/i
export function parseCssTimeMs(value) {
  const first = String(value ?? '')
    .split(',')[0]
    .trim()
  const match = /^(-?\d*\.?\d+)(ms|s)$/.exec(first)
  if (!match) return null
  return Number(match[1]) * (match[2] === 's' ? 1000 : 1)
}
export function judgeReducedMotion({ animations, pillPresent, mediaMatches }) {
  const problems = []
  if (!mediaMatches) problems.push('prefers-reduced-motion did not match after the emulation')
  if (!pillPresent) problems.push('no pill was on screen to measure')
  for (const animation of animations) {
    const duration = parseCssTimeMs(animation.duration)
    if (duration === null) problems.push(`an unreadable animation-duration ${JSON.stringify(animation.duration)}`)
    else if (duration > 0 && !LIVENESS_ANIMATION_NAMES.test(animation.name ?? ''))
      problems.push(`${animation.name || 'an animation'} runs ${duration} ms under reduced motion`)
  }
  return problems
}

// ---------------------------------------------------------------------------------------------------------------
// Privacy at rest

/** Operator `voice_action` queue entries may carry only these keys (src/shared/operator.ts) plus the seat metadata. */
export const VOICE_ACTION_QUEUE_KEYS = Object.freeze([
  'event',
  'id',
  'ts',
  'source',
  'actionId',
  'class',
  'outcome',
  'latencyBucket'
])
export const OPERATOR_SEAT_KEYS = Object.freeze([
  'seatHash',
  'os',
  'appVersion',
  'hostname',
  'ssoEmail',
  'license',
  'licenseLast4',
  'licenseId',
  'lastIndexAt'
])

/** Keys of `voice_action` queue entries that are outside the allowlist. A malformed file reads as unreadable, never as clean. */
export function auditOperatorQueue(text) {
  if (text === null) return { present: false, entries: 0, voiceActionEntries: 0, disallowedKeys: [], unreadable: false }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { present: true, entries: 0, voiceActionEntries: 0, disallowedKeys: [], unreadable: true }
  }
  const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : []
  const allowed = new Set([...VOICE_ACTION_QUEUE_KEYS, ...OPERATOR_SEAT_KEYS])
  const disallowed = new Set()
  let voiceActionEntries = 0
  for (const item of items) {
    const body = item?.body
    if (!body || body.event !== 'voice_action') continue
    voiceActionEntries += 1
    for (const key of Object.keys(body)) if (!allowed.has(key)) disallowed.add(key)
  }
  return {
    present: true,
    entries: items.length,
    voiceActionEntries,
    disallowedKeys: [...disallowed].sort(),
    unreadable: false
  }
}

const MAX_SCAN_BYTES = 64 * 1024 * 1024

/**
 * Case-insensitive scan of every file under `roots` for the privacy markers. Returns counts per marker and per top-level
 * folder, never a path to the matching text and never the text. A file over 64 MiB is counted as skipped, not scanned.
 * `fs` is a test seam.
 * @param {string[]} roots
 * @param {readonly string[]} [markers]
 * @param {{ fs?: any, exclude?: (path: string) => boolean }} [options]
 */
export function scanTreesForMarkers(
  roots,
  markers = PRIVACY_MARKERS,
  { fs = { readdirSync, statSync, readFileSync }, exclude = () => false } = {}
) {
  const needles = markers.map((marker) => ({ marker, bytes: Buffer.from(marker.toLowerCase(), 'latin1') }))
  const hits = Object.fromEntries(markers.map((marker) => [marker, 0]))
  const hitFiles = []
  let files = 0
  let bytes = 0
  let skippedLarge = 0
  let unreadable = 0
  const visit = (dir, root) => {
    let names
    try {
      names = fs.readdirSync(dir)
    } catch {
      unreadable += 1
      return
    }
    for (const name of names) {
      const path = join(dir, name)
      if (exclude(path)) continue
      let stats
      try {
        stats = fs.statSync(path)
      } catch {
        unreadable += 1
        continue
      }
      if (stats.isDirectory()) {
        visit(path, root)
        continue
      }
      if (!stats.isFile()) continue
      if (stats.size > MAX_SCAN_BYTES) {
        skippedLarge += 1
        continue
      }
      let content
      try {
        content = fs.readFileSync(path)
      } catch {
        unreadable += 1
        continue
      }
      files += 1
      bytes += content.length
      // Lower-casing the bytes of ASCII letters is enough: the markers are ASCII, and UTF-8 text keeps them as ASCII.
      const lowered = Buffer.from(content)
      for (let i = 0; i < lowered.length; i += 1) if (lowered[i] >= 65 && lowered[i] <= 90) lowered[i] += 32
      for (const { marker, bytes: needle } of needles) {
        let from = 0
        let count = 0
        for (;;) {
          const at = lowered.indexOf(needle, from)
          if (at < 0) break
          count += 1
          from = at + needle.length
        }
        if (count) {
          hits[marker] += count
          // The file's folder under the root and its extension tell Opus where to look; the name could hold the text.
          const inside = relative(root, path).split(sep)
          hitFiles.push({
            area: inside[0] ?? '',
            extension: name.includes('.') ? name.slice(name.lastIndexOf('.')) : '',
            marker,
            count
          })
        }
      }
    }
  }
  for (const root of roots) visit(root, root)
  return {
    files,
    bytes,
    skippedLarge,
    unreadable,
    hits,
    totalHits: Object.values(hits).reduce((a, b) => a + b, 0),
    hitFiles
  }
}

/**
 * True when a serialised report contains a spoken marker. The run refuses to write such a report: a report carries counts,
 * states, timings and hashes, never what was said.
 */
export function reportLeaksMarkers(report, markers = PRIVACY_MARKERS) {
  const text = JSON.stringify(report).toLowerCase()
  return markers.filter((marker) => text.includes(marker.toLowerCase()))
}

export function judgeNoUtteranceAtRest({ scan, queue }) {
  const problems = []
  if (scan.files === 0) problems.push('the scan read no files, so it proves nothing')
  for (const [marker, count] of Object.entries(scan.hits))
    if (count > 0)
      problems.push(
        `${count} hit(s) for a spoken word at rest (marker ${PRIVACY_MARKERS.indexOf(marker) + 1} of ${PRIVACY_MARKERS.length})`
      )
  if (queue.unreadable) problems.push('the operator queue file is not valid JSON')
  if (queue.disallowedKeys.length)
    problems.push(`operator voice_action queue entries carry non-allowlisted keys: ${queue.disallowedKeys.join(', ')}`)
  return problems
}

// ---------------------------------------------------------------------------------------------------------------
// Helper CPU for the idle-cost soak (va-idle-cost)

export const HELPER_IDLE_CPU_BUDGET_PERCENT = 0.1

/** The mean one-core CPU percent of the chord helper over the samples (CPU seconds per wall second, times 100). */
export function helperCpuPercent(samples) {
  const points = []
  for (const sample of samples ?? []) {
    const helper = (sample.processes ?? []).filter(
      (process) => process.kind === 'chord-helper' && Number.isFinite(process.cpuSeconds)
    )
    if (helper.length)
      points.push({
        tMs: sample.tMs ?? sample.wallMs,
        cpuSeconds: helper.reduce((sum, process) => sum + process.cpuSeconds, 0)
      })
  }
  if (points.length < 2) return null
  const wallSeconds = (points.at(-1).tMs - points[0].tMs) / 1000
  if (!(wallSeconds > 0)) return null
  const delta = points.at(-1).cpuSeconds - points[0].cpuSeconds
  return (100 * Math.max(0, delta)) / wallSeconds
}

/**
 * The soak's helper CPU line: the chord helper's mean one-core percent over the idle phase, against the 0.1 percent budget.
 * Advisory in the soak report (the 60-minute soak's own verdict is SOAK-ACCEPT-1); voice-actions `va-idle-cost` judges it.
 */
export function summarizeHelperCpu(samples, phases) {
  const idle = (phases ?? []).find((phase) => phase.id === 'idle')
  const inIdle = idle ? (samples ?? []).filter((sample) => sample.tMs >= idle.startMs && sample.tMs <= idle.endMs) : []
  const withHelper = inIdle.filter((sample) =>
    (sample.processes ?? []).some((process) => process.kind === 'chord-helper')
  ).length
  return {
    phase: 'idle',
    samplesWithHelper: withHelper,
    meanOneCorePercent: withHelper >= 2 ? helperCpuPercent(inIdle) : null,
    budgetPercent: HELPER_IDLE_CPU_BUDGET_PERCENT,
    advisory: true
  }
}

export function judgeIdleCost({ samples, budgetPercent = HELPER_IDLE_CPU_BUDGET_PERCENT, helperSamples }) {
  const percent = helperCpuPercent(samples)
  const problems = []
  if (helperSamples < 2) problems.push(`the chord helper was seen in ${helperSamples} sample(s); at least 2 are needed`)
  else if (percent === null) problems.push('the helper CPU could not be computed from the samples')
  else if (percent > budgetPercent)
    problems.push(`the helper used ${percent.toFixed(3)}% of one core, over ${budgetPercent}%`)
  return { problems, percent }
}
