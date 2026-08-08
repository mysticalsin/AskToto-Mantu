/**
 * app-disregard.contract.test.ts — source-contract test for MQA-030 (docs/qa/BUG-LEDGER.md): on a profile
 * with no AI provider, "Disregard" silently KEPT the meeting. maybeFireRecap's keyless branch persisted the
 * transcript through saveMeetingNow — the LEAVE-path saver, which deliberately writes neither savedPath nor
 * savingPromiseRef — so discardMeeting read null from both, skipped its delete branch (and main's native
 * confirm) entirely, and the .md stayed on disk, brain-ingested and, with publishing on, mirrored to the
 * wiki. The user's explicit "throw this away" did nothing, with no dialog and no error.
 *
 * There is no component-test harness for App.tsx anywhere in this repo (vitest runs the `node` environment,
 * no jsdom/testing-library), so this follows the established structural-proof pattern of
 * App.local-gates.test.ts / pinned-agent-boundary.contract.test.ts: readFileSync + regex over the real
 * source. It pins the whole chain — the keyless save reports its path, the live saver publishes it, and
 * discardMeeting still consumes it — since any one link going missing reopens the same silent-keep hole.
 *
 * Anchors are function names and branch conditions, never line numbers, so unrelated reordering is safe.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

const source = readFileSync(join(__dirname, 'App.tsx'), 'utf8')

/** Source slice from `start` up to (excluding) the next `end`. Throws loudly if either anchor moved. */
function blockBetween(start: string, end: string): string {
  const from = source.indexOf(start)
  if (from === -1) throw new Error(`app-disregard.contract.test.ts anchor not found (source moved?): ${start}`)
  const to = source.indexOf(end, from + start.length)
  if (to === -1) throw new Error(`app-disregard.contract.test.ts end anchor not found after "${start}": ${end}`)
  return source.slice(from, to)
}

/** Drops `//` comment lines, so a "don't do X" assertion tests the code and not the prose explaining it. */
function code(block: string): string {
  return block
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

// Blocks are resolved inside each test, never at module scope: a missing anchor must fail the ONE link it
// belongs to, rather than collapsing the whole file into a single collection error that hides which part of
// the chain regressed.
describe('MQA-030 — a keyless profile\'s auto-saved transcript is reachable by Disregard', () => {
  it('the no-provider branch saves through the live saver, not the fire-and-forget leave-path saver', () => {
    const keylessBranch = blockBetween('if (!settings?.providerReady) {', 'setRecapSkipped(false)')
    expect(keylessBranch).toMatch(/saveLiveMeetingNowRef\.current\?\.\(listen\.lines, meetingStartRef\.current, ''\)/)
    // The bug verbatim: saveMeetingNow(Ref) here reports nothing back to the live session, so Disregard
    // has no path to delete.
    expect(code(keylessBranch)).not.toMatch(/saveMeetingNowRef\.current/)
  })

  it('saveMeetingNow resolves to the path it wrote so a live caller can pin it', () => {
    const saveMeetingNowBlock = blockBetween('const saveMeetingNow = useCallback(', '// Forward reference for startListen')
    expect(saveMeetingNowBlock).toMatch(/\): Promise<string \| null> =>/)
    expect(saveMeetingNowBlock).toMatch(/const r = await window\.toto\.saveTranscript\(payload\)\s*\n\s*return r\.path/)
  })

  it('the live saver publishes the save through savingPromiseRef and the live session state', () => {
    const liveSaverBlock = blockBetween('const saveLiveMeetingNow = useCallback(', 'saveLiveMeetingNowRef.current = saveLiveMeetingNow')
    expect(liveSaverBlock).toMatch(/savingPromiseRef\.current = p/)
    expect(liveSaverBlock).toMatch(/savedRef\.current = String\(started\)/)
    expect(liveSaverBlock).toMatch(/setSavedPath\(path\)/)
    // Still honours saveMeetingNow's don't-pollute-the-next-session contract: a save landing after the
    // user started the next meeting must not claim the old path.
    expect(liveSaverBlock).toMatch(/meetingStartRef\.current === started/)
  })

  it('discardMeeting still consumes that promise and deletes the file it names', () => {
    const discardBlock = blockBetween('const discardMeeting = useCallback(', 'const clearAnswer = useCallback(')
    expect(discardBlock).toMatch(/savingPromiseRef\.current \? await savingPromiseRef\.current : null/)
    expect(discardBlock).toMatch(/const path = inFlightPath \?\? savedPath/)
    expect(discardBlock).toMatch(/window\.toto\.recallDelete\(path,/)
  })
})
