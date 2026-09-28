#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODULE_PATH = fileURLToPath(import.meta.url)
const ROOT = dirname(MODULE_PATH)
const DEFAULT_CLAIMS = join(ROOT, 'CLAIMS.json')
const DEFAULT_OUT = join(ROOT, 'out')
const EVIDENCE_LEVELS = new Set(['DESIGNED', 'LOCALLY_TESTED', 'HOST_CONFIGURED', 'LIVE_VERIFIED', 'ACCEPTED', 'MEASURED'])
const SCENE_STATES = new Set(['live', 'concept', 'reconstruction', 'cut'])
const STORYBOARD_VARIANTS = ['live', 'concept', 'cut']
const CLAIM_KINDS_REQUIRING_COMPETITIVE_PROOF = new Set(['comparative', 'superiority', 'affiliation', 'infallibility'])
const CAPABILITY_CLASSES = new Set(['verified', 'implemented-unverified', 'planned', 'unavailable'])
const PROOF_LEVELS = new Set(['LIVE_VERIFIED', 'ACCEPTED', 'MEASURED'])
const PLATFORMS = new Set(['macos', 'windows'])
export const KIT_BEATS = [
  { id: 'LF-01', title: 'Cold open', start_s: 0, end_s: 6 },
  { id: 'LF-02', title: 'The meeting problem', start_s: 6, end_s: 14 },
  { id: 'LF-03', title: 'Overlay appears', start_s: 14, end_s: 24 },
  { id: 'LF-04', title: 'Live capture and notes', start_s: 24, end_s: 36 },
  { id: 'LF-05', title: 'Hindsight recall', start_s: 36, end_s: 46 },
  { id: 'LF-06', title: 'Ask and act', start_s: 46, end_s: 54 },
  { id: 'LF-07', title: 'Runs on Mac and Windows', start_s: 54, end_s: 62 },
  { id: 'LF-08', title: 'Close', start_s: 62, end_s: 70 }
]
const VERIFIED_PRIVACY_SENTENCE = 'Authorized usage metadata is retained for administration'
const VERIFIED_PRIVACY_SOURCE_TICKET = 'M2-0149'

function parseArgs(argv) {
  const args = { claims: DEFAULT_CLAIMS, out: DEFAULT_OUT }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--claims') {
      const value = argv[++index]
      if (!value) throw new Error('--claims requires a path')
      args.claims = resolve(value)
    } else if (arg === '--out') {
      const value = argv[++index]
      if (!value) throw new Error('--out requires a path')
      args.out = resolve(value)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

function includesInsensitive(haystack, needle) {
  return haystack.toLocaleLowerCase('en-US').includes(needle.toLocaleLowerCase('en-US'))
}

function sceneText(scene) {
  return [scene.script, ...(scene.captions ?? [])].filter(Boolean).join('\n')
}

function claimSliceMatches(slice, scene, claim) {
  return slice?.scene_id === scene.id && slice?.claim_id === claim.id
}

function hasCompetitiveReceiptsForSlice(competitive, scene, claim) {
  return Boolean(
    competitive.final_signed_windows_qa_receipt &&
      competitive.final_signed_native_mac_qa_receipt &&
      Array.isArray(competitive.allowed_claim_slices) &&
      competitive.allowed_claim_slices.some((slice) => claimSliceMatches(slice, scene, claim))
  )
}

function hasPrecisePrivacyEvidence(record) {
  return Boolean(
    record?.verified === true &&
      record?.source?.type === 'ticket' &&
      record?.source?.id === VERIFIED_PRIVACY_SOURCE_TICKET &&
      record?.summary === VERIFIED_PRIVACY_SENTENCE
  )
}

function requireObject(value, label, failures) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    failures.push(`${label} must be an object`)
    return false
  }
  return true
}

// A film is a verified product preview only when every shown scene is live and backed by a verified claim.
export function computeFilmStatus(scenes, claims) {
  const shown = scenes.filter((scene) => scene?.state !== 'cut')
  const verified = shown.length > 0 && shown.every((scene) => scene.state === 'live' && claims.get(scene.claim_id)?.capability_class === 'verified')
  return verified ? 'verified product preview' : 'concept preview'
}

function platformAvailable(register, evidence, platform) {
  const entry = (register.release_evidence ?? []).find((item) => item?.platform === platform)
  return Boolean(entry && entry.status === 'AVAILABLE' && entry.signed === true && evidence.get(entry.evidence_record_id)?.verified === true)
}

export function validateClaims(register) {
  const failures = []
  const warnings = []

  if (!requireObject(register, 'register', failures)) return { ok: false, failures, warnings, summary: {} }
  if (register.ticket_id !== 'M2-0178') failures.push('ticket_id must be M2-0178')
  if (register.release_claims_approved !== false) failures.push('release_claims_approved must stay false until owner approval')

  const evidence = new Map()
  for (const record of register.evidence_records ?? []) {
    if (!record?.id) {
      failures.push('every evidence record needs an id')
      continue
    }
    if (!EVIDENCE_LEVELS.has(record.level)) failures.push(`${record.id} has invalid evidence level ${record.level}`)
    if (record.verified !== true) failures.push(`${record.id} must be verified before it can back a film claim`)
    evidence.set(record.id, record)
  }
  if (evidence.size === 0) failures.push('at least one verified evidence record is required')

  const claims = new Map()
  for (const claim of register.claims ?? []) {
    if (!claim?.id) {
      failures.push('every claim needs an id')
      continue
    }
    if (!evidence.has(claim.evidence_record_id)) failures.push(`${claim.id} references missing evidence ${claim.evidence_record_id}`)
    for (const variant of STORYBOARD_VARIANTS) {
      if (!claim?.variants?.[variant]) failures.push(`${claim.id} is missing storyboard variant ${variant}`)
    }
    if (!CAPABILITY_CLASSES.has(claim.capability_class)) failures.push(`${claim.id} has invalid capability class ${claim.capability_class}`)
    if (!('build_hash' in claim) || (claim.build_hash !== null && typeof claim.build_hash !== 'string')) {
      failures.push(`${claim.id} must carry a build_hash (a string, or null when no build exists)`)
    }
    if (claim.capability_class === 'verified') {
      if (!/^[0-9a-f]{7,40}$/.test(claim.build_hash ?? '')) failures.push(`${claim.id} is verified but has no build hash`)
      if (!PROOF_LEVELS.has(evidence.get(claim.evidence_record_id)?.level)) {
        failures.push(`${claim.id} is verified but its evidence record is not LIVE_VERIFIED, ACCEPTED or MEASURED`)
      }
    }
    if (claim.type === 'platform-availability') {
      const platforms = claim.platforms
      if (!Array.isArray(platforms) || platforms.length === 0 || !platforms.every((platform) => PLATFORMS.has(platform))) {
        failures.push(`${claim.id} is a platform-availability claim and must list platforms macos and/or windows`)
      }
    }
    claims.set(claim.id, claim)
  }

  const forbidden = register.forbidden_claims ?? []
  if (forbidden.length === 0) failures.push('forbidden_claims must not be empty')

  const scenes = register.storyboard_scenes ?? []
  if (scenes.length === 0) failures.push('storyboard_scenes must not be empty')

  const sceneIds = scenes.map((scene) => scene?.id)
  for (const beat of KIT_BEATS) {
    const scene = scenes.find((item) => item?.id === beat.id)
    if (!scene) {
      failures.push(`missing kit beat ${beat.id}`)
      continue
    }
    if (scene.title !== beat.title) failures.push(`${beat.id} title must be "${beat.title}"`)
    if (scene.start_s !== beat.start_s || scene.end_s !== beat.end_s) {
      failures.push(`${beat.id} timing must be ${beat.start_s}s-${beat.end_s}s`)
    }
  }
  for (const id of sceneIds) {
    if (!KIT_BEATS.some((beat) => beat.id === id)) failures.push(`unexpected scene ${id}: storyboard_scenes must be exactly LF-01..LF-08`)
  }
  if (new Set(sceneIds).size !== sceneIds.length) failures.push('storyboard_scenes must not repeat a beat id')

  for (const scene of scenes) {
    const label = scene?.id ?? '<missing scene id>'
    if (!scene?.id) failures.push('every scene needs an id')
    if (!SCENE_STATES.has(scene?.state)) failures.push(`${label} has invalid state ${scene?.state}`)
    for (const variant of STORYBOARD_VARIANTS) {
      if (!scene?.variants?.[variant]) failures.push(`${label} is missing storyboard variant ${variant}`)
    }

    if (scene.state === 'cut') {
      if (scene.script || (scene.captions ?? []).length > 0) failures.push(`${label} is cut but still has script or captions`)
    } else if (scene.claim_id) {
      const claim = claims.get(scene.claim_id)
      if (!claim) {
        failures.push(`${label} references missing claim ${scene.claim_id}`)
      } else if (!claim.allowed_states?.includes(scene.state)) {
        failures.push(`${label} state ${scene.state} is not allowed by claim ${claim.id}`)
      }
      if (!evidence.has(scene.evidence_record_id)) failures.push(`${label} references missing evidence ${scene.evidence_record_id}`)
    } else if (!scene.visible_label) {
      failures.push(`${label} must have a claim/evidence record or a visible concept/reconstruction label`)
    }

    if ((scene.state === 'concept' || scene.state === 'reconstruction') && !scene.visible_label) {
      failures.push(`${label} is ${scene.state} but has no visible label`)
    }

    if (scene.state === 'live' && claims.get(scene.claim_id)?.capability_class !== 'verified') {
      failures.push(`${label} cannot be live unless its claim is verified`)
    }
    if ((scene.state === 'concept' || scene.state === 'reconstruction') && scene.visible_label && !(scene.captions ?? []).includes(scene.visible_label)) {
      failures.push(`${label} must show its visible label ${scene.visible_label} on screen as a caption`)
    }
    const shownClaim = scene.state === 'cut' ? undefined : claims.get(scene.claim_id)
    if (shownClaim?.type === 'platform-availability') {
      for (const platform of shownClaim.platforms ?? []) {
        if (!platformAvailable(register, evidence, platform)) {
          failures.push(`${label} claims availability on ${platform} without release evidence for that platform`)
        }
      }
    }

    if (scene.requires_live_verified_memory_proof && scene.state === 'live') {
      const record = evidence.get(scene.evidence_record_id)
      if (record?.level !== 'LIVE_VERIFIED') failures.push(`${label} cannot be live without LIVE_VERIFIED memory evidence`)
    }

    const text = sceneText(scene)
    for (const rule of forbidden) {
      if (rule?.phrase && includesInsensitive(text, rule.phrase)) {
        failures.push(`${label} contains forbidden claim phrase: ${rule.phrase}`)
      }
    }
  }

  const competitive = register.competitive_qualification ?? {}
  for (const scene of scenes) {
    const claim = claims.get(scene.claim_id)
    if (!claim) continue
    if (
      CLAIM_KINDS_REQUIRING_COMPETITIVE_PROOF.has(claim.type) &&
      scene.state !== 'cut' &&
      !hasCompetitiveReceiptsForSlice(competitive, scene, claim)
    ) {
      failures.push(`${scene.id} must be cut until competitive qualification receipts exist for claim ${claim.id}`)
    }
  }

  const reEvaluations = new Map((register.re_evaluations ?? []).map((entry) => [entry.stage, entry]))
  for (const stage of ['T2', 'T3', 'rc1']) {
    if (!reEvaluations.has(stage)) failures.push(`missing ${stage} re-evaluation entry`)
  }
  if (reEvaluations.get('rc1')?.evidence_ticket_id !== 'M2-0210') {
    failures.push('rc1 re-evaluation must be recorded as M2-0210 evidence')
  }

  const privacy = register.privacy_line ?? {}
  const privacyText = privacy.text ?? ''
  for (const rule of forbidden) {
    if (rule?.phrase && includesInsensitive(privacyText, rule.phrase)) {
      failures.push(`privacy_line contains forbidden claim phrase: ${rule.phrase}`)
    }
  }
  if (privacy.status !== 'cut') {
    const record = evidence.get(privacy.evidence_record_id)
    if (privacyText !== VERIFIED_PRIVACY_SENTENCE || !hasPrecisePrivacyEvidence(record)) {
      failures.push('privacy line must be cut unless it uses the exact verified M2-0149 privacy sentence and evidence')
    }
  }

  const filmStatus = computeFilmStatus(scenes, claims)
  if (register.film_status !== filmStatus) failures.push(`film_status must be "${filmStatus}" as computed from the claim classes`)

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    summary: {
      scenes: scenes.length,
      claims: claims.size,
      evidence_records: evidence.size,
      release_claims_approved: register.release_claims_approved,
      film_status: filmStatus,
      live_scenes: scenes.filter((scene) => scene.state === 'live').length,
      concept_or_reconstruction_scenes: scenes.filter((scene) => scene.state === 'concept' || scene.state === 'reconstruction').length,
      cut_scenes: scenes.filter((scene) => scene.state === 'cut').length
    }
  }
}

export function loadClaims(path = DEFAULT_CLAIMS) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function writeReport(report, outDir) {
  mkdirSync(outDir, { recursive: true })
  const reportPath = join(outDir, 'claim-readiness.json')
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  return reportPath
}

if (MODULE_PATH === resolve(process.argv[1] ?? '')) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const report = validateClaims(loadClaims(args.claims))
    const reportPath = writeReport(report, args.out)
    console.log(JSON.stringify({ ok: report.ok, report: reportPath, summary: report.summary }, null, 2))
    if (!report.ok) {
      for (const failure of report.failures) console.error(`claim gate: ${failure}`)
      process.exitCode = 1
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
