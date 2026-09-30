import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CAPTURE_SAMPLE_RATE,
  CAPTURE_WAV_NAME,
  MAX_SECONDS,
  MIN_SECONDS,
  afconvertArgs,
  buildCaptureWav,
  englishSentences,
  pcmOf,
  sayArgs,
  wavFromPcm,
  writeCaptureWav
} from './capture-wav.mjs'
import { auditHasEvent, countTokenMatches, distinctiveTokens, launchSpec, meetingFiles, seedProfile } from './file-capture.mjs'
import { buildReport, judge } from './file-capture-smoke.mjs'

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'file-capture-test-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A stand-in for say + afconvert: records each call and writes a 3 s tone-free WAV where afconvert would. */
function fakeTools() {
  const calls: Array<{ command: string; args: string[] }> = []
  const run = (command: string, args: string[]): void => {
    calls.push({ command, args })
    if (command === '/usr/bin/afconvert') writeFileSync(args[args.length - 1], wavFromPcm(Buffer.alloc(3 * CAPTURE_SAMPLE_RATE * 2)))
  }
  return { calls, run }
}

const observed = (over: Record<string, unknown> = {}) => ({
  ready: true,
  asrEngine: 'whisper',
  auditEvent: true,
  linesReachedMs: 20_000,
  maxLines: 6,
  meetingFilesBefore: 2,
  meetingFilesAfter: 3,
  savedBytes: 900,
  tokenMatches: 5,
  tokenTotal: 12,
  totalMs: 150_000,
  ...over
})

describe('capture WAV: command construction', () => {
  it('speaks with say after a -- guard and converts with afconvert to 16-bit PCM mono', () => {
    expect(sayArgs('Hello there', '/t/a.aiff')).toEqual(['-o', '/t/a.aiff', '--', 'Hello there'])
    expect(afconvertArgs('/t/a.aiff', '/t/a.wav')).toEqual(['-f', 'WAVE', '-d', `LEI16@${CAPTURE_SAMPLE_RATE}`, '-c', '1', '/t/a.aiff', '/t/a.wav'])
  })

  it('uses only the English sentences of the fixture manifest, one say + afconvert pair each', () => {
    const sentences = englishSentences()
    expect(sentences.length).toBeGreaterThan(0)
    const { calls, run } = fakeTools()
    buildCaptureWav({ sentences, run })
    expect(calls.filter((c) => c.command === '/usr/bin/say').map((c) => c.args[3])).toEqual(sentences)
    expect(calls.filter((c) => c.command === '/usr/bin/afconvert')).toHaveLength(sentences.length)
  })

  it('builds a 16-bit PCM mono WAV of 60-180 s with pauses', () => {
    const { run } = fakeTools()
    const { wav, durationSeconds } = buildCaptureWav({ sentences: ['one', 'two'], run })
    expect(durationSeconds).toBeGreaterThanOrEqual(MIN_SECONDS)
    expect(durationSeconds).toBeLessThanOrEqual(MAX_SECONDS)
    expect(wav.toString('latin1', 0, 4)).toBe('RIFF')
    expect(wav.readUInt16LE(20)).toBe(1)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(24)).toBe(CAPTURE_SAMPLE_RATE)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(pcmOf(wav).length / 2 / CAPTURE_SAMPLE_RATE).toBeCloseTo(durationSeconds, 5)
    // The synthetic speech here is silence, so the pause check is on length: each sentence is followed by more.
    expect(pcmOf(wav).length).toBeGreaterThan(2 * 3 * CAPTURE_SAMPLE_RATE * 2)
  })

  it('reads the PCM through extra chunks before data', () => {
    const pcm = Buffer.from([1, 0, 2, 0])
    const plain = wavFromPcm(pcm)
    const list = Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('abcd')])
    const withList = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)])
    expect(pcmOf(withList)).toEqual(pcm)
  })

  it('writes the WAV into the profile and reports its sha256 and duration', () => {
    const profile = tempDir()
    const { run } = fakeTools()
    const out = writeCaptureWav(profile, { sentences: ['one'], run })
    expect(out.path).toBe(join(profile, CAPTURE_WAV_NAME))
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(out.path).length).toBeGreaterThan(44)
    expect(out.durationSeconds).toBeGreaterThanOrEqual(MIN_SECONDS)
  })
})

describe('profile seeding and launch', () => {
  it('seeds onboarding done, local whisper ASR and the local LLM off', () => {
    const profile = tempDir()
    const { settings } = seedProfile(profile)
    const saved = JSON.parse(readFileSync(join(profile, 'settings.json'), 'utf8'))
    expect(saved).toEqual(settings)
    expect(saved.onboardingDone).toBe(true)
    expect(saved.asrEngine).toBe('whisper')
    expect(saved.localLlm.enabled).toBe(false)
    expect(saved.meetingsFolder.startsWith(profile)).toBe(true)
  })

  it('launches with the isolated profile, the WAV inside it and a debugging port', () => {
    const spec = launchSpec({ executable: '/x/Metis QA', profileDir: '/p', wavPath: '/p/qa-capture.wav', port: 9555, baseEnv: { PATH: '/bin' } })
    expect(spec.command).toBe('/x/Metis QA')
    expect(spec.args).toEqual(['--remote-debugging-port=9555'])
    expect(spec.env).toEqual({ PATH: '/bin', ASKTOTO_USERDATA: '/p', METIS_QA_CAPTURE_FILE: '/p/qa-capture.wav' })
  })

  it('counts saved meetings without the index or the hidden brain', () => {
    const profile = tempDir()
    const { meetingsFolder } = seedProfile(profile)
    expect(meetingFiles(meetingsFolder)).toHaveLength(2)
    writeFileSync(join(meetingsFolder, '2026-09-30_100000-new.md'), 'x')
    mkdirSync(join(meetingsFolder, 'sub'))
    writeFileSync(join(meetingsFolder, 'sub', 'more.md'), 'x')
    expect(meetingFiles(meetingsFolder)).toHaveLength(4)
  })

  it('finds the audit event in the live or a rotated log, and only that event', () => {
    const profile = tempDir()
    mkdirSync(join(profile, 'logs'))
    writeFileSync(join(profile, 'logs', 'audit.log'), `${JSON.stringify({ event: 'app.start' })}\nnot json\n`)
    expect(auditHasEvent(profile)).toBe(false)
    writeFileSync(join(profile, 'logs', 'audit-170.log'), `${JSON.stringify({ event: 'qa.capture.file_source', active: true })}\n`)
    expect(auditHasEvent(profile)).toBe(true)
  })
})

describe('transcript tokens', () => {
  it('takes distinctive words of the sentences and counts whole-word matches only', () => {
    const tokens = distinctiveTokens(['Please confirm the budget by Friday.', 'The budget is final.'])
    expect(tokens).toEqual(['confirm', 'budget', 'friday', 'final'])
    expect(countTokenMatches('We CONFIRM the budgets and friday', tokens)).toBe(2)
  })
})

describe('verdicts', () => {
  it('PASS when every check holds', () => {
    expect(judge(observed())).toMatchObject({ verdict: 'PASS', exitCode: 0 })
  })

  it.each([
    ['no audit event', { auditEvent: false }],
    ['fewer than 2 live lines', { linesReachedMs: null, maxLines: 1 }],
    ['lines later than 120 s', { linesReachedMs: 121_000 }],
    ['no saved meeting', { meetingFilesAfter: 2, savedBytes: 0 }],
    ['an empty saved meeting', { savedBytes: 0 }],
    ['fewer than 3 tokens', { tokenMatches: 2 }],
    ['over 180 s', { totalMs: 180_001 }]
  ])('FAIL on %s', (_name, over) => {
    expect(judge(observed(over))).toMatchObject({ verdict: 'FAIL', exitCode: 1 })
  })

  it('PRECONDITION (exit 2) when the app never became ready', () => {
    expect(judge({ ready: false })).toEqual({ verdict: 'PRECONDITION', exitCode: 2, checks: null })
  })
})

describe('the report', () => {
  it('records the ASR engine and only numbers and booleans otherwise', () => {
    const outcome = judge(observed())
    const report = buildReport(observed(), outcome)
    expect(report.asrEngine).toBe('whisper')
    const leaves: unknown[] = []
    const walk = (value: unknown): void => {
      if (value && typeof value === 'object') Object.values(value).forEach(walk)
      else leaves.push(value)
    }
    walk({ ...report, asrEngine: undefined })
    for (const leaf of leaves) expect(['number', 'boolean', 'string', 'undefined'].includes(typeof leaf) || leaf === null).toBe(true)
    expect(leaves.filter((leaf) => typeof leaf === 'string')).toEqual(['PASS'])
  })

  it('carries no fixture sentence or token', () => {
    const text = JSON.stringify(buildReport(observed(), judge(observed()))).toLowerCase()
    for (const sentence of englishSentences()) expect(text).not.toContain(sentence.toLowerCase())
    for (const token of distinctiveTokens(englishSentences())) expect(text).not.toContain(token)
  })
})
