#!/usr/bin/env node
// Launch-film gate. Without flags it runs the claim register's truth gate (media/launch-film); with
// --storyboard it also checks that the pre-produced storyboard package under film/ answers to that register.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadClaims, validateClaims, writeReport } from '../../media/launch-film/check-claims.mjs'

const MODULE_PATH = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(MODULE_PATH), '../..')
const DEFAULT_OUT = join(REPO_ROOT, 'out', 'film')

const STORYBOARD = 'film/storyboard/storyboard.json'
const SHOT_LIST = 'film/storyboard/shot-list.json'
const SCRATCH_EDIT = 'film/storyboard/scratch-edit.json'
const APPROVAL_REQUEST = 'film/storyboard/claim-approval-request.md'
const VARIANTS = ['live', 'concept', 'cut']
const APPROVAL_SEND_BY = '2026-11-20'
/** The only remote reference a composition may carry: the pinned animation library. */
const PINNED_GSAP_URL = 'https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js'

function includesInsensitive(haystack, needle) {
  return haystack.toLocaleLowerCase('en-US').includes(needle.toLocaleLowerCase('en-US'))
}

/** The storyboard variant a register scene state selects. */
function activeVariantFor(state) {
  return state === 'reconstruction' ? 'concept' : state
}

function parseJson(path, readText, failures) {
  const text = readText(path)
  if (text === null) {
    failures.push(`${path} is missing`)
    return null
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    failures.push(`${path} is not valid JSON: ${error.message}`)
    return null
  }
}

/** References a composition makes that are not inline: src/href attributes and CSS url() values. */
function assetReferences(html) {
  const references = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((match) => match[1])
  for (const match of html.matchAll(/url\(\s*['"]?([^'")]+)/g)) references.push(match[1])
  return references.filter((reference) => reference !== PINNED_GSAP_URL && !reference.startsWith('data:') && !reference.startsWith('#'))
}

function compositionAttribute(html, name) {
  const match = new RegExp(`data-${name}="([\\d.]+)"`).exec(html)
  return match ? Number(match[1]) : null
}

/**
 * Checks the storyboard package against the claim register. `readText(path)` returns a repository file's
 * text or null when it does not exist, so the same checks run on the committed files and on test fixtures.
 */
export function validateStoryboard({ register, readText }) {
  const failures = []
  const storyboard = parseJson(STORYBOARD, readText, failures)
  const shotList = parseJson(SHOT_LIST, readText, failures)
  const scratchEdit = parseJson(SCRATCH_EDIT, readText, failures)
  const approval = readText(APPROVAL_REQUEST)
  if (approval === null) failures.push(`${APPROVAL_REQUEST} is missing`)
  if (!storyboard || !shotList || !scratchEdit) return { ok: false, failures, timeline: [], duration_seconds: 0 }

  const forbidden = (register.forbidden_claims ?? []).map((rule) => rule.phrase).filter(Boolean)
  const scanForbidden = (label, text) => {
    for (const phrase of forbidden) {
      if (text && includesInsensitive(text, phrase)) failures.push(`${label} contains forbidden claim phrase: ${phrase}`)
    }
  }

  // Non-product scenes: original assets only, and a duration the composition itself declares.
  const nonProduct = new Map()
  for (const scene of storyboard.non_product_scenes ?? []) {
    nonProduct.set(scene.id, scene)
    const html = readText(scene.composition)
    if (html === null) {
      failures.push(`${scene.id} composition ${scene.composition} is missing`)
      continue
    }
    for (const reference of assetReferences(html)) failures.push(`${scene.id} references an external asset: ${reference}`)
    if (compositionAttribute(html, 'duration') !== scene.duration_seconds) {
      failures.push(`${scene.id} duration ${scene.duration_seconds}s does not match its composition`)
    }
    const { width, height, fps } = storyboard.format
    for (const [name, expected] of [['width', width], ['height', height], ['fps', fps]]) {
      if (compositionAttribute(html, name) !== expected) failures.push(`${scene.id} composition ${name} is not ${expected}`)
    }
    scanForbidden(`${scene.id} composition`, html)
  }

  // Shots: every product scene prepared in a live and a concept form; live forms gated on LIVE_VERIFIED.
  const shots = new Map()
  for (const shot of shotList.shots ?? []) {
    shots.set(shot.id, shot)
    if (shot.form === 'live' && shot.required_evidence_level !== 'LIVE_VERIFIED') {
      failures.push(`${shot.id} must require LIVE_VERIFIED evidence`)
    }
    scanForbidden(`${shot.id} framing`, shot.framing)
    scanForbidden(`${shot.id} action`, shot.action)
  }

  const entries = new Map((storyboard.scenes ?? []).map((entry) => [entry.scene_id, entry]))
  const registerScenes = new Map((register.storyboard_scenes ?? []).map((scene) => [scene.id, scene]))
  const claimIds = new Set()

  /** Resolves the source a variant plays and its duration, recording a failure when it does not resolve. */
  const resolveSource = (sceneId, variantName, variant) => {
    if (variantName === 'cut') {
      if (variant.bridge === null) return null
      const bridge = nonProduct.get(variant.bridge)
      if (!bridge) failures.push(`${sceneId} cut bridge ${variant.bridge} is not a non-product scene`)
      return bridge ? { ref: bridge.id, duration: bridge.duration_seconds } : null
    }
    const { kind, ref } = variant.source ?? {}
    const found = kind === 'shot' ? shots.get(ref) : kind === 'scene' ? nonProduct.get(ref) : null
    if (!found) failures.push(`${sceneId} ${variantName} source ${ref} does not resolve`)
    return found ? { ref, duration: found.duration_seconds } : null
  }

  for (const [sceneId, scene] of registerScenes) {
    const entry = entries.get(sceneId)
    if (!entry) {
      failures.push(`${sceneId} has no storyboard entry`)
      continue
    }
    if (scene.claim_id && scene.state !== 'cut') claimIds.add(scene.claim_id)

    for (const name of VARIANTS) {
      const variant = entry.variants?.[name]
      if (!variant) {
        failures.push(`${sceneId} is missing storyboard variant ${name}`)
        continue
      }
      scanForbidden(`${sceneId} ${name} treatment`, variant.treatment)
      scanForbidden(`${sceneId} ${name} label`, variant.label)
      if (!variant.available) {
        if (name === 'cut') failures.push(`${sceneId} cut variant must always be available`)
        if (!variant.reason) failures.push(`${sceneId} ${name} is unavailable without a reason`)
        continue
      }
      if (!variant.treatment) failures.push(`${sceneId} ${name} variant has no treatment`)
      const resolved = resolveSource(sceneId, name, variant)
      if (name === 'concept') {
        if (!variant.label) failures.push(`${sceneId} concept variant needs a visible label`)
        else if (scene.visible_label && variant.label !== scene.visible_label) {
          failures.push(`${sceneId} concept label must be the register label "${scene.visible_label}"`)
        }
      }
      if (resolved && variant.source?.kind === 'shot') {
        const shot = shots.get(variant.source.ref)
        if (shot.scene_id !== sceneId || shot.form !== name) {
          failures.push(`${sceneId} ${name} source ${shot.id} is not a ${name} shot of the scene`)
        }
      }
    }

    for (const form of ['live', 'concept']) {
      const variant = entry.variants?.[form]
      if (variant?.available && variant.source?.kind === 'shot' && ![...shots.values()].some((shot) => shot.scene_id === sceneId && shot.form === form)) {
        failures.push(`${sceneId} has no ${form} shot`)
      }
    }

    const expected = activeVariantFor(scene.state)
    if (entry.active_variant !== expected) {
      failures.push(`${sceneId} active variant ${entry.active_variant} does not match register state ${scene.state}`)
    } else if (!entry.variants?.[expected]?.available) {
      failures.push(`${sceneId} active variant ${expected} is unavailable`)
    }
  }

  for (const sceneId of entries.keys()) {
    if (!registerScenes.has(sceneId)) failures.push(`${sceneId} is in the storyboard but not in the register`)
  }

  // Twin shots must be interchangeable in the edit, so their lengths match.
  for (const sceneId of registerScenes.keys()) {
    const durations = new Set([...shots.values()].filter((shot) => shot.scene_id === sceneId).map((shot) => shot.duration_seconds))
    if (durations.size > 1) failures.push(`${sceneId} live and concept shots differ in duration`)
  }

  // Scratch edit: each register scene has one slot; resolving active variants yields a gapless timeline.
  const timeline = []
  let cursor = 0
  const seenScenes = new Set()
  const place = (slot, sceneId, source) => {
    timeline.push({ slot, scene_id: sceneId, source: source.ref, start: cursor, end: cursor + source.duration })
    cursor += source.duration
  }
  for (const slot of scratchEdit.slots ?? []) {
    if (slot.non_product) {
      const scene = nonProduct.get(slot.non_product)
      if (scene) place(slot.id, null, { ref: scene.id, duration: scene.duration_seconds })
      else failures.push(`${slot.id} names unknown non-product scene ${slot.non_product}`)
      continue
    }
    const entry = entries.get(slot.scene_id)
    if (!entry) {
      failures.push(`${slot.id} names unknown scene ${slot.scene_id}`)
      continue
    }
    seenScenes.add(slot.scene_id)
    const variant = entry.variants?.[entry.active_variant]
    if (!variant?.available) continue
    const source = resolveSource(slot.scene_id, entry.active_variant, variant)
    if (source) place(slot.id, slot.scene_id, source)
  }
  for (const sceneId of registerScenes.keys()) {
    if (!seenScenes.has(sceneId)) failures.push(`${sceneId} has no scratch-edit slot`)
  }

  // Claim-approval request: a draft, never sent, due by the send-by date, naming every claim on screen.
  if (approval !== null) {
    if (!/^Status: DRAFT\b/m.test(approval)) failures.push('claim-approval request must be marked Status: DRAFT')
    if (!new RegExp(`^Send by: ${APPROVAL_SEND_BY}$`, 'm').test(approval)) {
      failures.push(`claim-approval request must carry Send by: ${APPROVAL_SEND_BY}`)
    }
    for (const claimId of claimIds) {
      if (!approval.includes(claimId)) failures.push(`claim-approval request does not name claim ${claimId}`)
    }
    scanForbidden('claim-approval request', approval)
  }

  return { ok: failures.length === 0, failures, timeline, duration_seconds: cursor }
}

function parseArgs(argv) {
  const args = { claims: undefined, out: DEFAULT_OUT, storyboard: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--storyboard') {
      args.storyboard = true
    } else if (arg === '--claims' || arg === '--out') {
      const value = argv[++index]
      if (!value) throw new Error(`${arg} requires a path`)
      args[arg.slice(2)] = resolve(value)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

if (MODULE_PATH === resolve(process.argv[1] ?? '')) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const register = loadClaims(args.claims)
    const claimReport = validateClaims(register)
    const reportPath = writeReport(claimReport, args.out)
    const failures = [...claimReport.failures]
    const result = { ok: claimReport.ok, report: reportPath, summary: claimReport.summary }
    if (args.storyboard) {
      const storyboard = validateStoryboard({
        register,
        readText: (path) => {
          try {
            return readFileSync(join(REPO_ROOT, path), 'utf8')
          } catch {
            return null
          }
        }
      })
      mkdirSync(args.out, { recursive: true })
      const storyboardPath = join(args.out, 'storyboard-readiness.json')
      writeFileSync(storyboardPath, `${JSON.stringify(storyboard, null, 2)}\n`)
      failures.push(...storyboard.failures)
      result.ok = result.ok && storyboard.ok
      result.storyboard_report = storyboardPath
      result.storyboard_duration_seconds = storyboard.duration_seconds
    }
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) {
      for (const failure of failures) console.error(`claim gate: ${failure}`)
      process.exitCode = 1
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
