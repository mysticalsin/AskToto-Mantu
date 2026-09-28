import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { loadClaims } from '../../media/launch-film/check-claims.mjs'
import { validateStoryboard } from './check-claims.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const STORYBOARD = 'film/storyboard/storyboard.json'
const SHOT_LIST = 'film/storyboard/shot-list.json'
const SCRATCH_EDIT = 'film/storyboard/scratch-edit.json'
const APPROVAL_REQUEST = 'film/storyboard/claim-approval-request.md'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/** The committed storyboard package, read into the in-memory files validateStoryboard takes. */
function loadPackage() {
  const files = new Map()
  const read = (path) => {
    const text = readFileSync(`${REPO_ROOT}${path}`, 'utf8')
    files.set(path, text)
    return text
  }
  const storyboard = JSON.parse(read(STORYBOARD))
  read(SHOT_LIST)
  read(SCRATCH_EDIT)
  read(APPROVAL_REQUEST)
  for (const scene of storyboard.non_product_scenes) read(scene.composition)
  return files
}

const register = loadClaims()
const committed = loadPackage()

function validate(files = committed, changedRegister = register) {
  return validateStoryboard({ register: changedRegister, readText: (path) => files.get(path) ?? null })
}

/** The gate's failures on a copy of the committed package after `edit` changed it. */
function failuresOf(edit) {
  const files = new Map(committed)
  const changedRegister = clone(register)
  edit({
    files,
    register: changedRegister,
    json: (path) => JSON.parse(files.get(path)),
    save: (path, value) => files.set(path, `${JSON.stringify(value)}\n`)
  })
  return validate(files, changedRegister).failures.join('\n')
}

test('the committed storyboard package passes against the claim register', () => {
  const result = validate()
  assert.deepEqual(result.failures, [])
  assert.equal(result.ok, true)
})

test("the resolved scratch edit skips cut scenes and follows each scene's active variant", () => {
  const { timeline, duration_seconds: total } = validate()
  assert.ok(!timeline.some((entry) => entry.scene_id === 'LF-04' || entry.scene_id === 'LF-05'))
  assert.ok(
    timeline.some((entry) => entry.scene_id === 'LF-03' && entry.source === 'SH-03C'),
    'the hindsight beat plays its concept form while the register says concept'
  )
  assert.equal(total, timeline.at(-1).end)
  assert.equal(timeline[0].start, 0)
  for (let index = 1; index < timeline.length; index += 1) assert.equal(timeline[index].start, timeline[index - 1].end)
})

test('every register scene needs a storyboard entry with live, concept and cut variants', () => {
  const failures = failuresOf(({ json, save }) => {
    const storyboard = json(STORYBOARD)
    delete storyboard.scenes.find((scene) => scene.scene_id === 'LF-02').variants.cut
    storyboard.scenes = storyboard.scenes.filter((scene) => scene.scene_id !== 'LF-06')
    save(STORYBOARD, storyboard)
  })
  assert.match(failures, /LF-02 is missing storyboard variant cut/)
  assert.match(failures, /LF-06 has no storyboard entry/)
})

test('the active variant must follow the register state', () => {
  const failures = failuresOf(({ register: changed }) => {
    changed.storyboard_scenes.find((scene) => scene.id === 'LF-03').state = 'cut'
  })
  assert.match(failures, /LF-03 active variant concept does not match register state cut/)
})

test("a concept variant carries the register's visible label", () => {
  const failures = failuresOf(({ json, save }) => {
    const storyboard = json(STORYBOARD)
    storyboard.scenes.find((scene) => scene.scene_id === 'LF-01').variants.concept.label = 'Product footage'
    save(STORYBOARD, storyboard)
  })
  assert.match(failures, /LF-01 concept label must be the register label "Concept UI sequence"/)
})

test('forbidden claim phrases are rejected in storyboard treatments', () => {
  const failures = failuresOf(({ json, save }) => {
    const storyboard = json(STORYBOARD)
    storyboard.scenes[0].variants.live.treatment = 'The overlay never misses a beat.'
    save(STORYBOARD, storyboard)
  })
  assert.match(failures, /LF-01 live treatment contains forbidden claim phrase: never misses/)
})

test('the hindsight scene is prepared in a live and a concept shot, the live one gated on LIVE_VERIFIED', () => {
  const dropped = failuresOf(({ json, save }) => {
    const shots = json(SHOT_LIST)
    shots.shots = shots.shots.filter((shot) => !(shot.scene_id === 'LF-03' && shot.form === 'live'))
    save(SHOT_LIST, shots)
  })
  assert.match(dropped, /LF-03 has no live shot/)
  const ungated = failuresOf(({ json, save }) => {
    const shots = json(SHOT_LIST)
    shots.shots.find((shot) => shot.id === 'SH-03L').required_evidence_level = 'DESIGNED'
    save(SHOT_LIST, shots)
  })
  assert.match(ungated, /SH-03L must require LIVE_VERIFIED evidence/)
})

test('non-product scenes use original assets only', () => {
  const failures = failuresOf(({ files }) => {
    const path = 'film/scenes/NP-01-opening-title/index.html'
    files.set(path, files.get(path).replace('</body>', '<img src="https://example.com/logo.png"></body>'))
  })
  assert.match(failures, /NP-01 references an external asset: https:\/\/example.com\/logo.png/)
})

test("a non-product scene's duration must match its composition", () => {
  const failures = failuresOf(({ json, save }) => {
    const storyboard = json(STORYBOARD)
    storyboard.non_product_scenes.find((scene) => scene.id === 'NP-02').duration_seconds = 9
    save(STORYBOARD, storyboard)
  })
  assert.match(failures, /NP-02 duration 9s does not match its composition/)
})

test('a scratch-edit slot that names an unknown scene is rejected', () => {
  const failures = failuresOf(({ json, save }) => {
    const edit = json(SCRATCH_EDIT)
    edit.slots.find((slot) => slot.scene_id === 'LF-01').scene_id = 'LF-99'
    save(SCRATCH_EDIT, edit)
  })
  assert.match(failures, /S02 names unknown scene LF-99/)
  assert.match(failures, /LF-01 has no scratch-edit slot/)
})

test('the claim-approval request stays a draft, due by 2026-11-20, naming every non-cut claim', () => {
  const sent = failuresOf(({ files }) => {
    files.set(APPROVAL_REQUEST, files.get(APPROVAL_REQUEST).replace('Status: DRAFT', 'Status: SENT'))
  })
  assert.match(sent, /claim-approval request must be marked Status: DRAFT/)
  const late = failuresOf(({ files }) => {
    files.set(APPROVAL_REQUEST, files.get(APPROVAL_REQUEST).replace('Send by: 2026-11-20', 'Send by: 2026-12-01'))
  })
  assert.match(late, /claim-approval request must carry Send by: 2026-11-20/)
  const omitted = failuresOf(({ files }) => {
    files.set(APPROVAL_REQUEST, files.get(APPROVAL_REQUEST).replaceAll('CL-03', 'CL-XX'))
  })
  assert.match(omitted, /claim-approval request does not name claim CL-03/)
})
