import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * EU AI Act Art. 5(1)(f) guard — no per-person emotion/engagement inference in the workplace.
 *
 * Art. 5(1)(f) prohibits AI systems that infer the emotions of a natural person in the workplace (with
 * narrow medical/safety exceptions this app does not use). Métis ingests meeting transcripts and could,
 * in principle, drift into scoring how each attendee "felt" during a call — that would be exactly the
 * prohibited practice, since a meeting attendee is a natural person in a workplace context.
 *
 * What is explicitly ALLOWED and stays out of this test's reach: BRAIN_EXTRACTION_PROMPT
 * (src/shared/brain.ts) asks for one `sentiment: "good" | "mixed" | "concerning"` field per MEETING —
 * a qualitative read on how the deal/conversation as a whole is trending (paired with `band_evidence`,
 * grounded in what was said), not an emotional state attributed to any individual speaker. That field,
 * and the ordinary business sense of "engagement" (a client/candidate engagement — see
 * src/shared/prompts.ts's recruiting-mode focus text), are legitimate and must keep passing this test.
 *
 * What is BANNED: any prompt-building source instructing the model to infer, score, or analyze the
 * emotional state of a person, to score/rate "engagement" (attentiveness/interest as a per-person
 * metric), or to characterize an individual speaker's or participant's sentiment. The regex below is
 * deliberately scoped so today's tree (verified clean before this test was written) passes, while any of
 * those three prohibited shapes would fail it:
 *   - /emotion(al)? (state|score|analysis)/i        — "emotional state", "emotion score", "emotion analysis"
 *   - /engagement (score|level)/i                    — "engagement score" / "engagement level" as a metric,
 *                                                       distinct from the ordinary noun "a client engagement"
 *   - /sentiment of (the|each) (speaker|participant)/i — per-person sentiment, distinct from the meeting-
 *                                                       level `sentiment` field described above
 *
 * Source is read as tracked files (git ls-files), not walked with fs, so untracked scratch files can
 * never make this test spuriously pass or fail. Tests themselves are excluded — a test fixture that
 * exercises redaction/rejection of banned language is not itself banned language in a shipped prompt.
 */

const root = join(__dirname, '..', '..')

const BANNED_PATTERN =
  /emotion(al)? (state|score|analysis)|engagement (score|level)|sentiment of (the|each) (speaker|participant)/i

function promptSourceFiles(): string[] {
  const git = execSync('git ls-files -- src/main src/shared', { cwd: root, encoding: 'utf8' })
  return git
    .split('\n')
    .filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
}

describe('AI Act Art. 5(1)(f) — no per-person emotion/engagement inference in prompt-building source', () => {
  it('scans a non-trivial surface (regression guard on the file list itself)', () => {
    expect(promptSourceFiles().length).toBeGreaterThan(50)
  })

  it('no prompt-building source file instructs per-person emotion/engagement scoring', () => {
    const hits: string[] = []
    for (const file of promptSourceFiles()) {
      const src = readFileSync(join(root, file), 'utf8')
      src.split('\n').forEach((line, i) => {
        if (BANNED_PATTERN.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(hits).toEqual([])
  })

  it('the legitimate meeting-level sentiment field stays untouched by the ban (sanity check on the regex)', () => {
    const brainSrc = readFileSync(join(root, 'src', 'shared', 'brain.ts'), 'utf8')
    expect(brainSrc).toMatch(/"sentiment": "good" \| "mixed" \| "concerning"/)
    expect(BANNED_PATTERN.test('"sentiment": "good" | "mixed" | "concerning",')).toBe(false)
  })

  it('the regex does catch each banned shape (sanity check the gate is not a no-op)', () => {
    expect(BANNED_PATTERN.test('Rate each speaker\'s emotional state from 1-10.')).toBe(true)
    expect(BANNED_PATTERN.test('Return an engagement score per participant.')).toBe(true)
    expect(BANNED_PATTERN.test('Report the sentiment of each speaker.')).toBe(true)
  })
})
