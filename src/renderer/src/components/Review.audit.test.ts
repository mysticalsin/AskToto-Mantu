import { describe, it, expect } from 'vitest'
import { displayedRecapText, crmPushDone, markCrmPushed, type CrmPayload } from './Review'

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
