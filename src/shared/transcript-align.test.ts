import { describe, it, expect } from 'vitest'
import type { TranscriptLine } from './ipc'
import { applySpeakerNames, clusterNamePairsFromAlignment, parseTeamsVtt, type VttEntry } from './transcript-align'

const T0 = 1_700_000_000_000

const line = (speaker: TranscriptLine['speaker'], text: string, secondsIn: number): TranscriptLine => ({
  speaker,
  text,
  t: T0 + secondsIn * 1000
})

// Entries use the SAME absolute time base as `line` above — main/graph-transcript.ts shifts parseTeamsVtt's
// cue-relative seconds onto this base before calling applySpeakerNames (see its own doc comment).
const entry = (name: string, text: string, secondsIn: number): VttEntry => ({
  name,
  text,
  tSec: T0 / 1000 + secondsIn
})

describe('applySpeakerNames', () => {
  it('assigns a name on an exact text + time match', () => {
    const lines = [line('them', "Let's lock the Q3 roadmap today", 10)]
    const entries = [entry('Alice Johnson', "Let's lock the Q3 roadmap today", 10)]
    const { lines: out, named } = applySpeakerNames(lines, entries)
    expect(named).toBe(1)
    expect(out[0].name).toBe('Alice Johnson')
    expect(out[0].speaker).toBe('them') // side is never touched
  })

  it('assigns a name on a partial token overlap above threshold', () => {
    const lines = [line('them', 'yeah I think we should ship in Q3 honestly', 20)]
    // Same gist, different phrasing/segmentation (independent ASR engines) — enough shared tokens to
    // clear the 0.5 Jaccard threshold even though the wording isn't identical.
    const entries = [entry('Bob Smith', 'I think we should ship in Q3', 21)]
    const { lines: out, named } = applySpeakerNames(lines, entries)
    expect(named).toBe(1)
    expect(out[0].name).toBe('Bob Smith')
  })

  it('leaves a line completely untouched when nothing clears the threshold or time window', () => {
    const lines = [line('them', 'completely unrelated remark about lunch', 5)]
    const entries = [
      entry('Alice Johnson', 'the quarterly numbers look strong', 5), // same time, no text overlap
      entry('Bob Smith', 'completely unrelated remark about lunch', 500) // same text, way outside window
    ]
    const { lines: out, named } = applySpeakerNames(lines, entries)
    expect(named).toBe(0)
    expect(out[0]).toEqual(lines[0]) // untouched
    expect('name' in out[0]).toBe(false) // not even a `name: undefined` key added
  })

  it('assigns the operator display name to every "you" line when provided, without text matching', () => {
    const lines = [line('you', 'so where are we on pricing', 0)]
    // No matching entry at all — proves operatorName short-circuits matching rather than depending on it.
    const { lines: out, named } = applySpeakerNames(lines, [], { operatorName: 'Tony Walteur' })
    expect(named).toBe(1)
    expect(out[0].name).toBe('Tony Walteur')
    expect(out[0].speaker).toBe('you')
  })

  it('falls back to text matching for "you" lines when no operator name is given', () => {
    const lines = [line('you', 'so where are we on pricing', 0)]
    const entries = [entry('Tony Walteur', 'so where are we on pricing', 0)]
    const { lines: out, named } = applySpeakerNames(lines, entries)
    expect(named).toBe(1)
    expect(out[0].name).toBe('Tony Walteur')
  })

  it('never assigns a blank/untagged cue name even on a perfect text match', () => {
    const lines = [line('them', 'no speaker tag on this one', 0)]
    const entries = [entry('', 'no speaker tag on this one', 0)]
    const { lines: out, named } = applySpeakerNames(lines, entries)
    expect(named).toBe(0)
    expect('name' in out[0]).toBe(false)
  })

  it('returns empty/untouched output for empty inputs', () => {
    expect(applySpeakerNames([], [])).toEqual({ lines: [], named: 0 })
    const lines = [line('them', 'hello', 0)]
    expect(applySpeakerNames(lines, [])).toEqual({ lines, named: 0 })
  })
})

// Speaker Intelligence P2 (§3.4) — the pure diff behind the Teams-VTT auto-enrollment flywheel.
describe('clusterNamePairsFromAlignment', () => {
  const withName = (l: TranscriptLine, name: string): TranscriptLine => ({ ...l, name })

  it('pairs a THEM line whose live cluster label got resolved to a real name', () => {
    const before = [line('them', "Let's lock the Q3 roadmap", 10)]
    before[0] = withName(before[0], 'Speaker 1')
    const after = [withName(before[0], 'Alice Johnson')]
    expect(clusterNamePairsFromAlignment(before, after)).toEqual([{ clusterLabel: 'Speaker 1', name: 'Alice Johnson' }])
  })

  it('ignores a "you" line even if it somehow carried a Speaker-N-shaped name', () => {
    const before = [withName(line('you', 'so about pricing', 0), 'Speaker 1')]
    const after = [withName(before[0], 'Tony Walteur')]
    expect(clusterNamePairsFromAlignment(before, after)).toEqual([])
  })

  it('ignores a THEM line with no pre-existing cluster label (never lived through live clustering)', () => {
    const before = [line('them', 'hello there', 0)]
    const after = [withName(before[0], 'Alice Johnson')]
    expect(clusterNamePairsFromAlignment(before, after)).toEqual([])
  })

  it('ignores a name that does not look like a live session cluster label', () => {
    const before = [withName(line('them', 'hello there', 0), 'Alice Johnson')] // already named, not a cluster
    const after = [withName(before[0], 'Bob Smith')]
    expect(clusterNamePairsFromAlignment(before, after)).toEqual([])
  })

  it('ignores a line VTT alignment left untouched (name unchanged)', () => {
    const before = [withName(line('them', 'hello there', 0), 'Speaker 1')]
    const after = [before[0]] // applySpeakerNames found no match — line returned as-is
    expect(clusterNamePairsFromAlignment(before, after)).toEqual([])
  })

  it('deduplicates by cluster label — first resolved name wins across many lines', () => {
    const before = [
      withName(line('them', 'first', 0), 'Speaker 1'),
      withName(line('them', 'second', 1), 'Speaker 1'),
      withName(line('them', 'third', 2), 'Speaker 1')
    ]
    const after = [
      withName(before[0], 'Alice Johnson'),
      withName(before[1], 'Alice Johnson'),
      withName(before[2], 'Alice Johnson')
    ]
    expect(clusterNamePairsFromAlignment(before, after)).toEqual([{ clusterLabel: 'Speaker 1', name: 'Alice Johnson' }])
  })

  it('handles multiple distinct clusters resolved in the same meeting', () => {
    const before = [withName(line('them', 'a', 0), 'Speaker 1'), withName(line('them', 'b', 1), 'Speaker 2')]
    const after = [withName(before[0], 'Alice Johnson'), withName(before[1], 'Bob Smith')]
    expect(clusterNamePairsFromAlignment(before, after)).toEqual([
      { clusterLabel: 'Speaker 1', name: 'Alice Johnson' },
      { clusterLabel: 'Speaker 2', name: 'Bob Smith' }
    ])
  })

  it('returns empty for empty input, and never throws on mismatched-length arrays', () => {
    expect(clusterNamePairsFromAlignment([], [])).toEqual([])
    const before = [withName(line('them', 'a', 0), 'Speaker 1')]
    expect(clusterNamePairsFromAlignment(before, [])).toEqual([])
  })
})

describe('parseTeamsVtt', () => {
  it('parses a realistic multi-cue transcript with GUID cue identifiers', () => {
    const vtt = [
      'WEBVTT',
      '',
      '3214b3d0-0000-0000-0000-000000000001',
      '00:00:00.320 --> 00:00:03.510',
      '<v Alice Johnson>Hey everyone, thanks for joining today.</v>',
      '',
      '3214b3d0-0000-0000-0000-000000000002',
      '00:00:03.700 --> 00:00:07.900',
      '<v Bob Smith>No problem, glad to be here.</v>',
      '',
      '3214b3d0-0000-0000-0000-000000000003',
      '00:01:05.000 --> 00:01:09.250',
      "<v Alice Johnson>Let's talk about the Q3 roadmap.</v>",
      ''
    ].join('\n')

    const entries = parseTeamsVtt(vtt)
    expect(entries).toHaveLength(3)
    expect(entries[0]).toEqual({
      name: 'Alice Johnson',
      text: 'Hey everyone, thanks for joining today.',
      tSec: 0.32
    })
    expect(entries[1]).toEqual({ name: 'Bob Smith', text: 'No problem, glad to be here.', tSec: 3.7 })
    expect(entries[2].name).toBe('Alice Johnson')
    expect(entries[2].tSec).toBe(65) // 00:01:05.000
  })

  it('tolerates a cue with no voice tag and a cue with a missing closing tag', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:02.000',
      'no speaker tag here',
      '',
      '00:00:02.000 --> 00:00:04.000',
      '<v Alice Johnson>unterminated voice span'
    ].join('\n')

    const entries = parseTeamsVtt(vtt)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({ name: '', text: 'no speaker tag here', tSec: 0 })
    expect(entries[1]).toEqual({ name: 'Alice Johnson', text: 'unterminated voice span', tSec: 2 })
  })

  it('returns an empty array for empty/garbage/non-cue input', () => {
    expect(parseTeamsVtt('')).toEqual([])
    expect(parseTeamsVtt('WEBVTT\n')).toEqual([])
    expect(parseTeamsVtt('NOTE this file intentionally has no cues\n')).toEqual([])
  })
})
