// Acceptance for the film pre-production set (M2-0389).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { checkBrief, checkRenderLog, checkRoute, parseBrief } from './preproduction.mjs'

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const register = JSON.parse(read('../../media/launch-film/CLAIMS.json'))
const claimIds = register.claims.map((claim) => claim.id)
const storyboard = JSON.parse(read('./storyboard.json'))
const shotList = JSON.parse(read('./shot-list.json'))
const log = JSON.parse(read('./render-log.json'))
const shots = parseBrief(read('./composition-brief.md'))

test('the composition brief lists every field for every shot, against the register', () => {
  assert.ok(shots.length > 0)
  assert.deepEqual(checkBrief(shots, claimIds), [])
})

test('each shot runs as long as its storyboard source', () => {
  const durations = new Map([
    ...storyboard.non_product_scenes.map((s) => [s.id, s.duration_seconds]),
    ...shotList.shots.map((s) => [s.id, s.duration_seconds])
  ])
  for (const shot of shots) {
    assert.equal(Number(shot.Out) - Number(shot.In), durations.get(shot['Source capture']), shot.Shot)
  }
})

test('a shot with an empty field, unknown claim or timeline gap is reported', () => {
  const broken = [{ ...shots[0], 'Sound cue': '' }, { ...shots[1], Claim: 'CL-99', In: '5' }]
  const problems = checkBrief(broken, claimIds)
  assert.ok(problems.some((p) => p.includes('Sound cue is empty')))
  assert.ok(problems.some((p) => p.includes('CL-99')))
  assert.ok(problems.some((p) => p.includes('expected 4')))
})

test('the recorded route is the full /brag route', () => {
  assert.deepEqual(checkRoute(log), [])
})

test('a slim-route render fails the check', () => {
  for (const invocation of ['/brag', '/brag-slim', '/brag-slim --full', '/brag --fullish']) {
    assert.deepEqual(checkRoute({ ...log, route: { invocation } }), ['route is not /brag --full'], invocation)
  }
})

test('the final render is blocked until both reviews are signed off', () => {
  assert.ok(checkRenderLog({ ...log, signoffs: { ...log.signoffs, animatic: { status: 'PENDING' } } }).includes('animatic is not signed off'))
  const signed = { ...log, signoffs: { contact_sheet: { status: 'SIGNED_OFF' }, animatic: { status: 'SIGNED_OFF' } } }
  assert.deepEqual(checkRenderLog(signed), [])
})

test('the reference-clip attempt and result are recorded', () => {
  assert.equal(log.reference_clip.attempted, false)
  assert.equal(log.reference_clip.status, 'BLOCKED_EXTERNAL')
  assert.ok(['viewed', 'not viewed'].includes(log.reference_clip.result))
  assert.deepEqual(checkRenderLog({ ...log, reference_clip: undefined }).filter((p) => p.startsWith('reference')).length, 1)
})

test('the hook comparison and plan exist', () => {
  for (const file of ['hook-concepts.md', 'brag-plan.md']) assert.ok(existsSync(fileURLToPath(new URL(file, import.meta.url))), file)
  const hooks = read('./hook-concepts.md')
  for (const word of ['Clarity', 'Specificity', 'Emotion', 'Evidence', 'Selection note']) assert.ok(hooks.includes(word), word)
})
