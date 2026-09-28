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
const CLAIM_KINDS_REQUIRING_COMPETITIVE_PROOF = new Set(['comparative', 'superiority', 'affiliation', 'infallibility'])

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

function requireObject(value, label, failures) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    failures.push(`${label} must be an object`)
    return false
  }
  return true
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
    claims.set(claim.id, claim)
  }

  const forbidden = register.forbidden_claims ?? []
  if (forbidden.length === 0) failures.push('forbidden_claims must not be empty')

  const scenes = register.storyboard_scenes ?? []
  if (scenes.length === 0) failures.push('storyboard_scenes must not be empty')

  for (const scene of scenes) {
    const label = scene?.id ?? '<missing scene id>'
    if (!scene?.id) failures.push('every scene needs an id')
    if (!SCENE_STATES.has(scene?.state)) failures.push(`${label} has invalid state ${scene?.state}`)
    for (const variant of ['live', 'concept', 'cut']) {
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
  const hasCompetitiveReceipts = Boolean(
    competitive.final_signed_windows_qa_receipt &&
      competitive.final_signed_native_mac_qa_receipt &&
      Array.isArray(competitive.allowed_claim_slices) &&
      competitive.allowed_claim_slices.length > 0
  )
  for (const scene of scenes) {
    const claim = claims.get(scene.claim_id)
    if (!claim) continue
    if (CLAIM_KINDS_REQUIRING_COMPETITIVE_PROOF.has(claim.type) && !hasCompetitiveReceipts && scene.state !== 'cut') {
      failures.push(`${scene.id} must be cut until competitive qualification receipts exist`)
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
  if (privacy.status !== 'cut' && !privacy.evidence_record_id) {
    failures.push('privacy line must be cut unless it has exact verified privacy evidence')
  }

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    summary: {
      scenes: scenes.length,
      claims: claims.size,
      evidence_records: evidence.size,
      release_claims_approved: register.release_claims_approved,
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
