#!/usr/bin/env node
/**
 * lock-mode-skills.mjs — SHA-256 lock for shipped mode skills + the shared humanizer.
 *
 * Source of truth: skills/humanizer/SKILL.md and skills/modes/<id>/SKILL.md
 * Writes:          src/shared/mode-skills.lock.json
 *
 *   node scripts/lock-mode-skills.mjs           write the lock from the files
 *   node scripts/lock-mode-skills.mjs --check   fail if a file drifted from the lock
 *
 * Updating a skill is a Métis release of that file's hash. Do not edit the lock by hand.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(__dirname, '..')
export const SKILLS_DIR = join(REPO_ROOT, 'skills')
export const LOCK_PATH = join(REPO_ROOT, 'src', 'shared', 'mode-skills.lock.json')

export const BUILTIN_MODE_IDS = [
  'interview',
  'recruiting',
  'meeting',
  'sales',
  'negotiation',
  'presentation',
  'support',
  'general',
  'cold-call'
]

export const SKILL_ENTRIES = [
  { id: 'humanizer', path: 'humanizer/SKILL.md' },
  ...BUILTIN_MODE_IDS.map((id) => ({ id, path: `modes/${id}/SKILL.md` }))
]

const HEADER_RE = /^---\n([\s\S]*?)\n---\n/

export function sha256Utf8(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function parseSkillHeader(raw) {
  const m = HEADER_RE.exec(raw)
  if (!m) throw new Error('Skill file is missing a YAML header between --- fences.')
  const fields = {}
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return {
    id: fields.id || '',
    version: fields.version || '',
    locked: fields.locked === 'true',
    body: raw.slice(m[0].length)
  }
}

export function readSkillFile(absPath) {
  if (!existsSync(absPath)) throw new Error(`Skill file missing: ${absPath}`)
  const raw = readFileSync(absPath, 'utf8')
  if (raw.includes('\r')) {
    throw new Error(`Skill file must be LF-only (found CR): ${absPath}`)
  }
  const header = parseSkillHeader(raw)
  return { raw, ...header }
}

export function buildLock(skillsDir = SKILLS_DIR) {
  const skills = {}
  for (const entry of SKILL_ENTRIES) {
    const abs = join(skillsDir, entry.path)
    const file = readSkillFile(abs)
    if (file.id !== entry.id) {
      throw new Error(`Skill header id ${JSON.stringify(file.id)} does not match path id ${entry.id} (${entry.path})`)
    }
    if (!file.version) throw new Error(`Skill ${entry.id} is missing version in the header`)
    if (!file.locked) throw new Error(`Skill ${entry.id} must set locked: true`)
    if (!file.body.trim()) throw new Error(`Skill ${entry.id} has an empty body`)
    skills[entry.id] = {
      path: entry.path,
      version: file.version,
      sha256: sha256Utf8(file.raw)
    }
  }
  return { schemaVersion: 1, algorithm: 'sha256', skills }
}

export function readLock(lockPath = LOCK_PATH) {
  return JSON.parse(readFileSync(lockPath, 'utf8'))
}

export function diffLock(current, expected) {
  const errors = []
  if (current.schemaVersion !== expected.schemaVersion) {
    errors.push(`schemaVersion ${current.schemaVersion} != ${expected.schemaVersion}`)
  }
  if (current.algorithm !== expected.algorithm) {
    errors.push(`algorithm ${current.algorithm} != ${expected.algorithm}`)
  }
  const currentIds = Object.keys(current.skills || {}).sort()
  const expectedIds = Object.keys(expected.skills || {}).sort()
  if (currentIds.join() !== expectedIds.join()) {
    errors.push(`skill ids ${currentIds.join(',')} != ${expectedIds.join(',')}`)
  }
  for (const id of expectedIds) {
    const a = current.skills?.[id]
    const b = expected.skills?.[id]
    if (!a) {
      errors.push(`missing ${id}`)
      continue
    }
    if (a.path !== b.path) errors.push(`${id} path ${a.path} != ${b.path}`)
    if (a.version !== b.version) errors.push(`${id} version ${a.version} != ${b.version}`)
    if (a.sha256 !== b.sha256) errors.push(`${id} sha256 mismatch`)
  }
  return errors
}

function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check')
  const current = buildLock()
  if (check) {
    if (!existsSync(LOCK_PATH)) {
      console.error(`mode-skills lock missing: ${LOCK_PATH}`)
      process.exit(1)
    }
    const expected = readLock()
    const errors = diffLock(current, expected)
    if (errors.length) {
      console.error('mode-skills lock is stale. Run: node scripts/lock-mode-skills.mjs')
      for (const e of errors) console.error(`  - ${e}`)
      process.exit(1)
    }
    console.log(`mode-skills lock ok (${Object.keys(current.skills).length} files)`)
    return
  }
  writeFileSync(LOCK_PATH, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
  console.log(`wrote ${LOCK_PATH}`)
}

export function composeLockedAppendix(modeId, skillsDir = SKILLS_DIR) {
  const humanizer = readSkillFile(join(skillsDir, 'humanizer/SKILL.md'))
  const parts = []
  if (modeId) {
    const skill = readSkillFile(join(skillsDir, `modes/${modeId}/SKILL.md`))
    parts.push(
      `\n\n--- LOCKED MODE SKILL (${skill.id} v${skill.version}) ---\n${skill.body.trim()}\n--- END LOCKED MODE SKILL ---`
    )
  }
  parts.push(
    `\n\n--- LOCKED HUMANIZER (v${humanizer.version}) ---\n${humanizer.body.trim()}\n--- END LOCKED HUMANIZER ---`
  )
  return parts.join('')
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invoked) {
  main()
}
