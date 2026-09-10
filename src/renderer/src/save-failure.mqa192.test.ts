/**
 * save-failure.mqa192.test.ts — MQA-192.
 *
 * Two defects in one box on the Review screen when a transcript save fails:
 *
 *  1. The rejection message was stored verbatim, so the banner printed Electron's IPC plumbing plus a
 *     raw errno — "Error invoking remote method 'transcript:save': Error: EPERM: operation not
 *     permitted, open '…\\2026-08-19_143000-acme.md.tmp'" — with no action anywhere in it. The same
 *     wrapper also renders for a completely different cause (main throws 'Not signed in.'), so the two
 *     were indistinguishable. App.tsx already strips exactly this wrapper on the screen-capture path.
 *  2. The status line under it read "Retrying… attempt 5 / 5" forever. saveAttempts is the auto-save
 *     effect's only re-trigger, and it stops incrementing at MAX_SAVE_RETRIES, so once the ladder is
 *     spent nothing is ever scheduled again — while the screen kept claiming a retry was in progress.
 *
 * Behavioural assertions run against the two pure decisions the fix exports. Structural assertions
 * (readFileSync + regex over the real source) pin the wiring: vitest runs the `node` environment with no
 * jsdom in this repo, so a hook's catch branch and a render branch can't be exercised — same proof
 * pattern as app-audit-fixes.contract.test.ts / app-disregard.contract.test.ts.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { saveFailureReason } from './App'
import { saveStatusLine } from './components/Review'

// Windows checkout — normalize CRLF so multi-line anchors match.
const appSource = readFileSync(join(__dirname, 'App.tsx'), 'utf8').replace(/\r\n/g, '\n')
const reviewSource = readFileSync(join(__dirname, 'components', 'Review.tsx'), 'utf8').replace(/\r\n/g, '\n')

function blockBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  if (from === -1) throw new Error(`save-failure.mqa192 anchor not found (source moved?): ${start}`)
  const to = source.indexOf(end, from + start.length)
  if (to === -1) throw new Error(`save-failure.mqa192 end anchor not found after "${start}": ${end}`)
  return source.slice(from, to)
}

/** Drops `//` comment lines so a "don't do X" assertion tests the code, not the prose explaining it. */
function code(block: string): string {
  return block
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

describe('MQA-192 — a failed transcript save says what went wrong and what to do', () => {
  it('strips the Electron IPC plumbing instead of printing the channel name at the user', () => {
    const reason = saveFailureReason(
      new Error(
        "Error invoking remote method 'transcript:save': Error: EPERM: operation not permitted, open 'C:\\Users\\jdoe\\OneDrive\\Metis Meetings\\2026-08-19_143000-acme.md.tmp'"
      )
    )
    expect(reason).not.toMatch(/invoking remote method/i)
    expect(reason).not.toMatch(/transcript:save/)
  })

  it('names the action for a folder Métis is not allowed to write to', () => {
    const reason = saveFailureReason(new Error("EPERM: operation not permitted, open 'C:\\x\\y.md.tmp'"))
    expect(reason).toMatch(/Settings|permission/i)
    expect(reason).toMatch(/press Save/i)
    // EACCES is the same cause with a different errno — it must not fall through to the raw text.
    expect(saveFailureReason(new Error("EACCES: permission denied, open '/x/y.md.tmp'"))).toBe(reason)
  })

  it('tells a signed-out user to sign in, not to read an IPC trace', () => {
    const reason = saveFailureReason(new Error("Error invoking remote method 'transcript:save': Error: Not signed in."))
    expect(reason).toMatch(/sign in/i)
    expect(reason).not.toMatch(/invoking remote method/i)
    // The distinguishing point of the whole finding: a dropped session and a locked file no longer read
    // identically.
    expect(reason).not.toBe(saveFailureReason(new Error("EPERM: operation not permitted, open '/x/y.md.tmp'")))
  })

  it('separates a full disk, a locked file and a missing folder', () => {
    const full = saveFailureReason(new Error("ENOSPC: no space left on device, write"))
    const busy = saveFailureReason(new Error("EBUSY: resource busy or locked, rename '/x/y.md.tmp' -> '/x/y.md'"))
    const gone = saveFailureReason(new Error("ENOENT: no such file or directory, open '/x/y.md.tmp'"))
    expect(full).toMatch(/disk is full|free up/i)
    expect(busy).toMatch(/another program|close/i)
    expect(gone).toMatch(/folder/i)
    expect(new Set([full, busy, gone]).size).toBe(3)
  })

  it('keeps the operating system’s own words for a cause it cannot diagnose — vaguer would be less true', () => {
    const reason = saveFailureReason(
      new Error("Error invoking remote method 'transcript:save': Error: EROFS: read-only file system, open '/x/y.md.tmp'")
    )
    expect(reason).toBe("EROFS: read-only file system, open '/x/y.md.tmp'")
  })

  it('handles a non-Error rejection without printing [object Object]', () => {
    expect(saveFailureReason('Not signed in.')).toMatch(/sign in/i)
  })
})

describe('MQA-192 — the status line stops claiming a retry once the ladder is spent', () => {
  it('says nothing before the first retry is scheduled', () => {
    expect(saveStatusLine(0, 5, false)).toBeNull()
  })

  it('reports the pending retry while one really is scheduled', () => {
    expect(saveStatusLine(2, 5, false)).toBe('Retrying… attempt 2 / 5')
  })

  it('never claims a retry after the ladder gave up, and points at the control that works', () => {
    const line = saveStatusLine(5, 5, true)
    expect(line).not.toBeNull()
    expect(line).not.toMatch(/retrying/i)
    expect(line).toMatch(/press Save/i)
  })
})

describe('MQA-192 — wiring', () => {
  it('the auto-save catch humanizes the rejection instead of storing e.message', () => {
    const body = code(blockBetween(appSource, 'const doSave = async ()', 'if (saveAttempts === 0)'))
    expect(body).toMatch(/setSaveError\(saveFailureReason\(outcome\.error\)\)/)
    // The bug verbatim: the raw message went straight into the banner.
    expect(body).not.toMatch(/const msg = e instanceof Error \? e\.message : String\(e\)/)
  })

  it('the auto-save catch records the give-up the render branch reads', () => {
    const body = code(blockBetween(appSource, 'const doSave = async ()', 'if (saveAttempts === 0)'))
    expect(body).toMatch(/setSaveGaveUp\(true\)/)
    // …and a success clears it, so a later retry that lands doesn't leave the terminal line up.
    expect(body).toMatch(/setSaveGaveUp\(false\)/)
  })

  it('the manual Save catch humanizes the same rejection', () => {
    const body = code(
      blockBetween(appSource, 'const manualSave = useCallback(', '// auto-save the meeting to the OneDrive folder')
    )
    expect(body).toMatch(/setSaveError\(saveFailureReason\(outcome\.error\)\)/)
    expect(body).not.toMatch(/const msg = e instanceof Error \? e\.message : String\(e\)/)
  })

  it('a new meeting clears the give-up along with the rest of the save state', () => {
    const body = code(
      blockBetween(
        appSource,
        "savingPromiseRef.current = null // this meeting hasn't autosaved yet",
        'listen.clear()'
      )
    )
    expect(body).toMatch(/setSaveAttempts\(0\)/)
    expect(body).toMatch(/setSaveGaveUp\(false\)/)
  })

  it('Review is told whether the ladder gave up', () => {
    const props = blockBetween(appSource, 'saveAttempts={pm ? 0 : saveAttempts}', 'startedAt={pm')
    expect(props).toMatch(/saveGaveUp=\{/)
    // The Review element is memoized off an explicit dep list — a flag missing from it would freeze the
    // banner on its stale copy.
    const deps = blockBetween(appSource, '}, [pastMeeting, recapGenTarget', '])')
    expect(deps).toMatch(/saveGaveUp/)
  })

  it('the Review banner routes its status line through saveStatusLine', () => {
    const banner = blockBetween(reviewSource, '{saveError && !savedPath && (', '{savedPath && !meetingMeta && (')
    expect(banner).toMatch(/saveStatusLine\(/)
    // The bug verbatim: an unconditional present-tense "Retrying…" gated only on saveAttempts > 0.
    expect(code(banner)).not.toMatch(/Retrying…/)
  })
})
