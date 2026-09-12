import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  displayedRecapText,
  crmPushDone,
  crmPushKey,
  markCrmPushed,
  seedCrmPushed,
  type CrmPayload,
  nextStepPushed,
  markNextStepPushed,
  type NextStepArgs
} from './Review'

// MQA-073 — after editing a past meeting's notes, Regenerate rewrote the file on disk while the screen
// (and Copy Summary / Export JSON / Export PDF / the CRM payload) kept showing the old edited text.
describe('displayedRecapText — a saved recap edit yields to a regeneration (MQA-073)', () => {
  const original = '## Overview\nOriginal AI summary.\n'
  const edited = { base: original, text: '## Overview\nEDITED BY ME' }

  it('follows the prop when nothing has been edited in place', () => {
    expect(displayedRecapText(null, original)).toBe(original)
    expect(displayedRecapText(null, undefined)).toBe('')
  })

  it('shows the edit while App is still handing back the text that edit replaced', () => {
    expect(displayedRecapText(edited, original)).toBe(edited.text)
  })

  it('drops the edit as soon as a regeneration starts streaming', () => {
    // recapGenDisplay arrives with empty text (the pending placeholder), then partial tokens — neither is
    // the text the edit was made against, so the summary must follow the live generation.
    expect(displayedRecapText(edited, '')).toBe('')
    expect(displayedRecapText(edited, '## Over')).toBe('## Over')
  })

  it('shows the regenerated recap that was just written to disk, never the stale edit', () => {
    const regenerated = '## Overview\nRegenerated summary.\n'
    expect(displayedRecapText(edited, regenerated)).toBe(regenerated)
    expect(displayedRecapText(edited, regenerated)).not.toBe(edited.text)
  })

  it('keeps following the prop once App syncs the saved edit back down (same text either way)', () => {
    expect(displayedRecapText(edited, edited.text)).toBe(edited.text)
  })
})

// MQA-092 — re-opening an already-pushed meeting re-armed "Push to CRM", so a second Confirm push filed a
// byte-identical duplicate record with nothing on either side to dedupe on.
describe('crmPushDone — an already-pushed meeting stays pushed across remounts (MQA-092)', () => {
  const payload = (name: string): CrmPayload => ({
    title: name,
    date: '2026-06-12T09:00:00.000Z',
    summary: `## Overview\nNotes for ${name}.`
  })

  it('arms the chip until a push actually succeeds', () => {
    const p = payload('never pushed')
    expect(crmPushDone('idle', p)).toBe(false)
    expect(crmPushDone('sending', p)).toBe(false)
    expect(crmPushDone('error', p)).toBe(false)
    expect(crmPushDone('sent', p)).toBe(true)
  })

  it('still reports pushed after the push state is reset (meeting re-opened, or Review remounted)', () => {
    const p = payload('acme pricing')
    expect(crmPushDone('idle', p)).toBe(false)
    markCrmPushed(p) // Confirm push → mcpCrmPush resolved ok
    // Recent meetings → another meeting → back here flips savedPath twice, which resets pushState to idle.
    expect(crmPushDone('idle', p)).toBe(true)
  })

  it('leaves a different meeting armed, so the indicator never follows the user', () => {
    const pushed = payload('globex kickoff')
    markCrmPushed(pushed)
    expect(crmPushDone('idle', payload('initech discovery'))).toBe(false)
  })

  it('re-arms once the recap changed — that is a different record, not a duplicate', () => {
    const p = payload('umbrella renewal')
    markCrmPushed(p)
    expect(crmPushDone('idle', { ...p, summary: `${p.summary}\n- new action item` })).toBe(false)
  })
})

// "Book next steps" — the per (action item × connection) push mirrors crmPushDone/markCrmPushed's own
// session-memory dedupe, so navigating away and back to an already-pushed item/connection pair never
// re-arms it and risks a duplicate task.
describe('nextStepPushed — an already-pushed (item, connection) pair stays pushed across remounts', () => {
  const args = (title: string): NextStepArgs => ({
    title,
    description: `${title}\n\nFrom meeting: Q3 sync (2026-06-12T09:00:00.000Z)`
  })

  it('arms the card until a push actually succeeds', () => {
    const a = args('Send the deck')
    expect(nextStepPushed('idle', 'plane', a)).toBe(false)
    expect(nextStepPushed('sending', 'plane', a)).toBe(false)
    expect(nextStepPushed('error', 'plane', a)).toBe(false)
    expect(nextStepPushed('sent', 'plane', a)).toBe(true)
  })

  it('still reports pushed after the push state is reset (meeting re-opened, or Review remounted)', () => {
    const a = args('Book the venue')
    expect(nextStepPushed('idle', 'plane', a)).toBe(false)
    markNextStepPushed('plane', a)
    expect(nextStepPushed('idle', 'plane', a)).toBe(true)
  })

  it('keys on connectionId — the same item pushed to two connections is tracked independently', () => {
    const a = args('Finalize copy')
    markNextStepPushed('plane', a)
    expect(nextStepPushed('idle', 'plane', a)).toBe(true)
    expect(nextStepPushed('idle', 'clickup', a)).toBe(false)
  })

  it('keys on project_id — the same title/description to a different container is a different card', () => {
    const withProject = { ...args('Draft the follow-up'), project_id: 'proj-1' }
    markNextStepPushed('plane', withProject)
    expect(nextStepPushed('idle', 'plane', withProject)).toBe(true)
    expect(nextStepPushed('idle', 'plane', { ...withProject, project_id: 'proj-2' })).toBe(false)
  })
})

/**
 * Review.tsx has no render harness in this repo (see Settings.contract.test.ts's header for the same
 * rationale), so these three user-facing fixes are pinned against the actual source.
 */
describe('Review.tsx — next steps and cold-call coaching cannot strand or duplicate work', () => {
  const src = readFileSync(join(__dirname, 'Review.tsx'), 'utf8')

  it('MQA-312 shows a truthful speaker-evidence label, not the number of audio channels', () => {
    expect(src.includes('new Set(lines.map((l) => l.speaker)).size')).toBe(false)
    expect(src.includes('reviewSpeakerLabel(speechLines)')).toBe(true)
    expect(src.includes('{speakerCountLabel}')).toBe(true)
  })

  // MQA-140: the dedupe reads React state and a set that is only written AFTER the await, so a second
  // click in the same tick sails past both and creates duplicate tasks in the user's tracker. A ref flips
  // synchronously; the CRM push already had an equivalent in-flight guard, next steps did not.
  it('MQA-140: the next-steps push has a synchronous in-flight guard, not just a state check', () => {
    const at = src.indexOf('const confirmNextSteps = async')
    expect(at).toBeGreaterThan(-1)
    const body = src.slice(at, at + 700)
    expect(body).toMatch(/pushingNextStepsRef\.current\) return/)
    expect(body).toMatch(/pushingNextStepsRef\.current = true/)
    // Released on every path, including a throw mid-push.
    expect(body).toMatch(/finally \{[\s\S]*?pushingNextStepsRef\.current = false/)
    // And the button reflects it rather than looking clickable.
    expect(src).toMatch(/disabled=\{pushingNextSteps\}/)
  })

  // MQA-141: coaching === null means it was never STARTED (nothing transcribed → generateColdCallCoaching
  // returns early). The old final `else` showed a spinner for that, so the panel span forever with no
  // error and therefore no Retry button.
  it('MQA-141: the cold-call panel only spins while coaching is actually streaming', () => {
    const at = src.indexOf('Cold call coaching')
    expect(at).toBeGreaterThan(-1)
    const body = src.slice(at, at + 5000)
    expect(body).toMatch(/coldCall\.coaching\?\.streaming \? \(/)
    // The never-started case offers the action instead of a spinner.
    expect(body).toMatch(/No coaching notes yet/)
    expect(body).toMatch(/onRetryCoaching/)
  })

  // MQA-142: the parsed action items were cached until the meeting changed, so editing the recap left the
  // panel pushing the user's OLD wording.
  it('MQA-142: the next-steps cache is keyed to the recap text it was parsed from', () => {
    expect(src).toMatch(/setNextStepsSource\(source\)/)
    const open = src.indexOf('const openNextSteps = async')
    const openBody = src.slice(open, open + 500)
    expect(openBody).toMatch(/nextStepsData && nextStepsSource === recapText/)
    // An edit under an already-open panel re-reads rather than serving stale items.
    expect(src).toMatch(/nextStepsSource !== null && nextStepsSource !== recapText\) void loadNextSteps\(\)/)
    // ...but never mid-stream, which would be a fetch storm on non-final text.
    expect(src).toMatch(/nextStepsLoading \|\| recap\?\.streaming\) return/)
  })
})

// MQA-092, the durable half. The session Set above dies with the process, and the push panel has no
// other memory: push a recap, quit, relaunch, reopen the meeting, and "Push to CRM" is armed again over
// a record the CRM already holds. The recap's own frontmatter now carries the fingerprint of what was
// pushed (main/recall.ts's setMeetingCrmPushed), and Review seeds the session Set from it on mount.
describe('crmPushKey / seedCrmPushed — a push survives a relaunch (MQA-092)', () => {
  const payload = (name: string): CrmPayload => ({
    title: name,
    date: '2026-06-12T09:00:00.000Z',
    summary: `## Overview\nNotes for ${name}.`
  })

  it('fits a YAML scalar — main refuses anything else, so this shape is the contract', () => {
    // The exact regex main/recall.ts and SetCrmPushedPayloadSchema both enforce before interpolating it
    // into the frontmatter block.
    expect(crmPushKey(payload('anything at all: with punctuation\nand a newline'))).toMatch(/^[a-z0-9]{1,32}$/)
  })

  it('is stable for one payload and different for another', () => {
    const p = payload('acme renewal')
    expect(crmPushKey(p)).toBe(crmPushKey({ ...p }))
    expect(crmPushKey(p)).not.toBe(crmPushKey(payload('globex kickoff')))
    // An edited recap is a different record, so it must hash differently and re-arm the chip.
    expect(crmPushKey(p)).not.toBe(crmPushKey({ ...p, summary: `${p.summary}\n- new action item` }))
  })

  it('a seeded fingerprint reports the meeting as already pushed, with no push this session', () => {
    const p = payload('reopened after a relaunch')
    expect(crmPushDone('idle', p)).toBe(false)
    seedCrmPushed(crmPushKey(p)) // what App hands Review from the meeting's crm_pushed frontmatter
    expect(crmPushDone('idle', p)).toBe(true)
  })

  it('an absent marker seeds nothing — a never-pushed meeting stays armed', () => {
    const p = payload('never pushed, reopened')
    seedCrmPushed(undefined)
    expect(crmPushDone('idle', p)).toBe(false)
  })

  it('a stale marker from an earlier recap does not suppress the edited one', () => {
    const p = payload('edited since the push')
    seedCrmPushed(crmPushKey(p))
    expect(crmPushDone('idle', { ...p, summary: `${p.summary}\n- added later` })).toBe(false)
  })

  it('markCrmPushed and the durable marker agree on one identity', () => {
    // If these ever diverged, a meeting pushed this session would re-arm after a relaunch — the exact
    // defect, reintroduced through the back door.
    const p = payload('one identity')
    markCrmPushed(p)
    expect(crmPushDone('idle', p)).toBe(true)
    seedCrmPushed(crmPushKey(p)) // idempotent: same key, already present
    expect(crmPushDone('idle', p)).toBe(true)
  })
})

// MQA-092, the variant the durable marker would otherwise miss. The push panel needs only recapText,
// not a saved path, and a LIVE meeting's savedPath stays null until autosave lands — which can be
// deferred behind up to 5 retries with backoff. A push in that window has no file to stamp, so the
// marker has to be parked and written when the path finally arrives, guarded so it can never land on a
// different meeting's file.
describe('the deferred CRM marker — a push that beat its own autosave (MQA-092)', () => {
  const source = readFileSync(join(__dirname, 'Review.tsx'), 'utf8').replace(/\r\n/g, '\n')
  const between = (start: string, end: string): string => {
    const from = source.indexOf(start)
    expect(from, `anchor moved: ${start}`).toBeGreaterThan(-1)
    const to = source.indexOf(end, from + start.length)
    expect(to, `end anchor moved: ${end}`).toBeGreaterThan(-1)
    return source.slice(from, to)
  }

  it('parks the fingerprint when there is no file yet instead of dropping it', () => {
    const send = between('const sendToCrm = async ()', 'const taskConnections')
    expect(send).toMatch(/if \(file\) void window\.toto\.recallSetCrmPushed\(file, crmPushKey\(payload\)\)/)
    expect(send).toMatch(/else pendingCrmMarker = crmPushKey\(payload\)/)
  })

  it('writes the parked marker only once a path exists AND it matches this payload', () => {
    const flush = between('const crmPayloadKey = crmPushKey(crmPayload)', 'const sendToCrm')
    // Both halves of the guard are load-bearing: without the fingerprint check, navigating to another
    // meeting after a file-less push would stamp THIS fingerprint onto THAT meeting's frontmatter.
    expect(flush).toMatch(/if \(!savedPath \|\| pendingCrmMarker !== crmPayloadKey\) return/)
    // Cleared before the write, so a re-render mid-flight cannot fire it twice.
    expect(flush.indexOf('pendingCrmMarker = null')).toBeLessThan(flush.indexOf('recallSetCrmPushed'))
    expect(flush).toMatch(/\}, \[savedPath, crmPayloadKey\]\)/)
  })

  it('is one slot, because only the live meeting can lack a path', () => {
    expect(source).toMatch(/^let pendingCrmMarker: string \| null = null$/m)
  })
})

describe('Review.tsx — ClickUp create-task destination (CLICKUP-PUSH.md)', () => {
  const src = readFileSync(join(__dirname, 'Review.tsx'), 'utf8')

  it('shows Push to ClickUp and Task in, never attach_task_file or a ClickUp project-ID paste', () => {
    expect(src).toMatch(/Push to ClickUp/)
    expect(src).toMatch(/Task in \$\{clickupDestName\}/)
    expect(src).toMatch(/toolName: 'clickup_create_task'/)
    expect(src).not.toMatch(/attach_task_file/)
    const clickupBranch = src.slice(src.indexOf("conn.kind === 'clickup' ? ("), src.indexOf("conn.kind === 'clickup' ? (") + 900)
    expect(clickupBranch).toMatch(/Task in/)
    expect(clickupBranch).not.toMatch(/project ID/)
  })

  it('names an already-connected dest on Push click, never a mount effect', () => {
    expect(src).toMatch(/mcpClickupDiscoverDestination/)
    expect(src).toMatch(/void ensureClickupDest\(\)/)
    const effects = src.match(/useEffect\(\(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\)/g) ?? []
    expect(effects.length).toBeGreaterThan(0)
    for (const block of effects) {
      expect(block).not.toMatch(/mcpPush/)
      expect(block).not.toMatch(/mcpClickupDiscoverDestination/)
      expect(block).not.toMatch(/mcpClickupConnect/)
    }
  })

  it('never auto-sends: no useEffect calls mcpPush', () => {
    const effects = src.match(/useEffect\(\(\) => \{[\s\S]*?\n  \}, \[[^\]]*\]\)/g) ?? []
    expect(effects.length).toBeGreaterThan(0)
    for (const block of effects) {
      expect(block).not.toMatch(/mcpPush/)
    }
  })
})
