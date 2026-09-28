import { test } from 'node:test'
import assert from 'node:assert/strict'

import { loadClaims, validateClaims } from './check-claims.mjs'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

const validRegister = loadClaims()

test('current launch-film register passes the readiness gate while owner approval is false', () => {
  const result = validateClaims(validRegister)
  assert.deepEqual(result.failures, [])
  assert.equal(result.ok, true)
  assert.equal(result.summary.release_claims_approved, false)
})

test('forbidden phrases are rejected across scripts and captions', () => {
  const register = clone(validRegister)
  register.storyboard_scenes[0].captions.push('remembers everything')
  const result = validateClaims(register)
  assert.equal(result.ok, false)
  assert.match(result.failures.join('\n'), /forbidden claim phrase: remembers everything/)
})

test('hindsight cannot move live without LIVE_VERIFIED memory evidence', () => {
  const register = clone(validRegister)
  const hindsight = register.storyboard_scenes.find((scene) => scene.id === 'LF-03')
  hindsight.state = 'live'
  hindsight.visible_label = ''
  const result = validateClaims(register)
  assert.equal(result.ok, false)
  assert.match(result.failures.join('\n'), /LF-03 cannot be live without LIVE_VERIFIED memory evidence/)
})

test('comparative claims are cut until competitive receipts and slices exist', () => {
  const register = clone(validRegister)
  register.claims.push({
    id: 'CL-COMP',
    text: 'Comparison claim.',
    type: 'comparative',
    evidence_record_id: 'EV-M2-0178-REGISTER',
    allowed_states: ['live', 'cut']
  })
  register.storyboard_scenes.push({
    id: 'LF-COMP',
    title: 'Comparison',
    state: 'live',
    claim_id: 'CL-COMP',
    evidence_record_id: 'EV-M2-0178-REGISTER',
    visible_label: '',
    script: 'A comparison appears.',
    captions: ['Comparison'],
    variants: {
      live: 'Live comparison.',
      concept: 'No concept comparison.',
      cut: 'Cut comparison.'
    }
  })
  const result = validateClaims(register)
  assert.equal(result.ok, false)
  assert.match(result.failures.join('\n'), /LF-COMP must be cut until competitive qualification receipts exist/)
})

test('rc1 re-evaluation must point to M2-0210 evidence', () => {
  const register = clone(validRegister)
  register.re_evaluations.find((entry) => entry.stage === 'rc1').evidence_ticket_id = 'M2-0178'
  const result = validateClaims(register)
  assert.equal(result.ok, false)
  assert.match(result.failures.join('\n'), /rc1 re-evaluation must be recorded as M2-0210 evidence/)
})
