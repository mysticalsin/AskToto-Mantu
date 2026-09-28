import { test } from 'node:test'
import assert from 'node:assert/strict'

import { KIT_BEATS, computeFilmStatus, loadClaims, validateClaims } from './check-claims.mjs'

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
  const hindsight = register.storyboard_scenes.find((scene) => scene.requires_live_verified_memory_proof)
  assert.equal(hindsight.id, 'LF-05')
  hindsight.state = 'live'
  hindsight.visible_label = ''
  const result = validateClaims(register)
  assert.equal(result.ok, false)
  assert.match(result.failures.join('\n'), /LF-05 cannot be live without LIVE_VERIFIED memory evidence/)
})

function failuresOf(register) {
  const result = validateClaims(register)
  assert.equal(result.ok, false)
  return result.failures.join('\n')
}

test('storyboard has exactly the kit beats LF-01..LF-08 with their titles and timings', () => {
  assert.deepEqual(
    validRegister.storyboard_scenes.map((scene) => scene.id),
    KIT_BEATS.map((beat) => beat.id)
  )
})

test('a missing kit beat fails the gate', () => {
  const register = clone(validRegister)
  register.storyboard_scenes = register.storyboard_scenes.filter((scene) => scene.id !== 'LF-04')
  assert.match(failuresOf(register), /missing kit beat LF-04/)
})

test('an extra beat fails the gate', () => {
  const register = clone(validRegister)
  const extra = clone(register.storyboard_scenes[0])
  extra.id = 'LF-09'
  register.storyboard_scenes.push(extra)
  assert.match(failuresOf(register), /unexpected scene LF-09/)
})

test('a retitled or retimed beat fails the gate', () => {
  const register = clone(validRegister)
  register.storyboard_scenes[2].title = 'Toolchain proof card'
  register.storyboard_scenes[3].end_s += 1
  const failures = failuresOf(register)
  assert.match(failures, /LF-03 title must be "Overlay appears"/)
  assert.match(failures, /LF-04 timing must be 24s-36s/)
})

test('every claim carries a capability class and a build hash field', () => {
  const register = clone(validRegister)
  register.claims[0].capability_class = 'shipping'
  delete register.claims[1].build_hash
  const failures = failuresOf(register)
  assert.match(failures, /CL-01 has invalid capability class shipping/)
  assert.match(failures, /CL-02 must carry a build_hash/)
})

test('a verified claim needs a build hash and proof-level evidence', () => {
  const register = clone(validRegister)
  register.claims[0].capability_class = 'verified'
  const failures = failuresOf(register)
  assert.match(failures, /CL-01 is verified but has no build hash/)
  assert.match(failures, /CL-01 is verified but its evidence record is not LIVE_VERIFIED/)
})

test('a live scene needs a verified claim', () => {
  const register = clone(validRegister)
  register.storyboard_scenes[2].state = 'live'
  assert.match(failuresOf(register), /LF-03 cannot be live unless its claim is verified/)
})

test('film status is computed from the classes: concept while unverified, product preview when all shown scenes are verified and live', () => {
  const claims = new Map(validRegister.claims.map((claim) => [claim.id, claim]))
  assert.equal(computeFilmStatus(validRegister.storyboard_scenes, claims), 'concept preview')
  assert.equal(validateClaims(validRegister).summary.film_status, 'concept preview')

  const verifiedClaims = new Map([['CL-V', { id: 'CL-V', capability_class: 'verified' }]])
  const liveScenes = [{ state: 'live', claim_id: 'CL-V' }, { state: 'cut', claim_id: null }]
  assert.equal(computeFilmStatus(liveScenes, verifiedClaims), 'verified product preview')
  assert.equal(computeFilmStatus([...liveScenes, { state: 'concept', claim_id: null }], verifiedClaims), 'concept preview')
})

test('a declared film status that disagrees with the computed one fails', () => {
  const register = clone(validRegister)
  register.film_status = 'verified product preview'
  assert.match(failuresOf(register), /film_status must be "concept preview"/)
})

test('a concept scene must show its label on screen', () => {
  const register = clone(validRegister)
  register.storyboard_scenes[0].captions = []
  assert.match(failuresOf(register), /LF-01 must show its visible label Concept UI sequence on screen/)
})

test('a platform-availability claim fails without release evidence for that platform', () => {
  const register = clone(validRegister)
  const platformScene = register.storyboard_scenes.find((scene) => scene.id === 'LF-07')
  platformScene.state = 'concept'
  platformScene.script = 'Available on both platforms.'
  platformScene.captions = [platformScene.visible_label]
  const failures = failuresOf(register)
  assert.match(failures, /LF-07 claims availability on macos without release evidence/)
  assert.match(failures, /LF-07 claims availability on windows without release evidence/)
})

test('an unsigned BLOCKED Windows candidate does not make the platform available', () => {
  const register = clone(validRegister)
  const platformScene = register.storyboard_scenes.find((scene) => scene.id === 'LF-07')
  platformScene.state = 'concept'
  platformScene.script = 'Available on both platforms.'
  platformScene.captions = [platformScene.visible_label]
  register.release_evidence.find((entry) => entry.platform === 'macos').status = 'AVAILABLE'
  register.release_evidence.find((entry) => entry.platform === 'macos').signed = true
  register.release_evidence.find((entry) => entry.platform === 'macos').evidence_record_id = 'EV-M2-0178-REGISTER'
  const failures = failuresOf(register)
  assert.doesNotMatch(failures, /availability on macos/)
  assert.match(failures, /LF-07 claims availability on windows without release evidence/)
})

test('claims must carry live, concept and cut storyboard variants', () => {
  const register = clone(validRegister)
  delete register.claims.find((claim) => claim.id === 'CL-01').variants.live
  const result = validateClaims(register)
  assert.equal(result.ok, false)
  assert.match(result.failures.join('\n'), /CL-01 is missing storyboard variant live/)
})

test('comparative claims are cut until competitive receipts and slices exist', () => {
  const register = clone(validRegister)
  register.claims.push({
    id: 'CL-COMP',
    text: 'Comparison claim.',
    type: 'comparative',
    evidence_record_id: 'EV-M2-0178-REGISTER',
    allowed_states: ['live', 'cut'],
    variants: {
      live: 'Live comparison.',
      concept: 'No concept comparison.',
      cut: 'Cut comparison.'
    }
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

test('competitive receipts for an unrelated slice do not qualify a live comparative claim', () => {
  const register = clone(validRegister)
  register.competitive_qualification.final_signed_windows_qa_receipt = 'EV-WINDOWS'
  register.competitive_qualification.final_signed_native_mac_qa_receipt = 'EV-MAC'
  register.competitive_qualification.allowed_claim_slices = [{ scene_id: 'LF-OTHER', claim_id: 'CL-OTHER' }]
  register.claims.push({
    id: 'CL-COMP',
    text: 'Comparison claim.',
    type: 'comparative',
    evidence_record_id: 'EV-M2-0178-REGISTER',
    allowed_states: ['live', 'cut'],
    variants: {
      live: 'Live comparison.',
      concept: 'No concept comparison.',
      cut: 'Cut comparison.'
    }
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
  assert.match(result.failures.join('\n'), /LF-COMP must be cut until competitive qualification receipts exist for claim CL-COMP/)
})

test('privacy line requires the exact verified M2-0149 sentence and rejects forbidden privacy wording', () => {
  const register = clone(validRegister)
  register.evidence_records.push({
    id: 'EV-GENERIC-PRIVACY',
    level: 'DESIGNED',
    verified: true,
    source: {
      type: 'ticket',
      id: 'M2-0178'
    },
    summary: 'Generic privacy evidence.'
  })
  register.privacy_line = {
    status: 'live',
    text: 'all data stays on your Mac',
    evidence_record_id: 'EV-GENERIC-PRIVACY'
  }
  const result = validateClaims(register)
  assert.equal(result.ok, false)
  assert.match(result.failures.join('\n'), /privacy_line contains forbidden claim phrase: all data stays on your Mac/)
  assert.match(result.failures.join('\n'), /privacy line must be cut unless it uses the exact verified M2-0149 privacy sentence and evidence/)
})

test('rc1 re-evaluation must point to M2-0210 evidence', () => {
  const register = clone(validRegister)
  register.re_evaluations.find((entry) => entry.stage === 'rc1').evidence_ticket_id = 'M2-0178'
  const result = validateClaims(register)
  assert.equal(result.ok, false)
  assert.match(result.failures.join('\n'), /rc1 re-evaluation must be recorded as M2-0210 evidence/)
})
