import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConversationMode } from '@shared/ipc'
import {
  composeLockedSkillsAppendix,
  HUMANIZER_SKILL_ID,
  isBuiltinConversationMode,
  ModeSkillIntegrityError,
  modeSkillLock,
  parseSkillHeader,
  type LoadedSkill,
  type ModeSkillId,
  type ModeSkillLock
} from '@shared/mode-skills'

export function sha256Utf8(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

export function verifySkillRaw(
  expectedId: ModeSkillId,
  raw: string,
  lock: ModeSkillLock = modeSkillLock()
): LoadedSkill {
  if (raw.includes('\r')) {
    throw new ModeSkillIntegrityError(expectedId, 'CR in file; skills must be LF-only')
  }
  const entry = lock.skills[expectedId]
  if (!entry) throw new ModeSkillIntegrityError(expectedId, 'not in lock')
  const digest = sha256Utf8(raw)
  if (digest !== entry.sha256) {
    throw new ModeSkillIntegrityError(expectedId, 'hash mismatch')
  }
  const header = parseSkillHeader(raw)
  if (header.id !== expectedId) {
    throw new ModeSkillIntegrityError(expectedId, `header id ${header.id} != ${expectedId}`)
  }
  if (header.version !== entry.version) {
    throw new ModeSkillIntegrityError(expectedId, `header version ${header.version} != lock ${entry.version}`)
  }
  if (!header.locked) {
    throw new ModeSkillIntegrityError(expectedId, 'header locked is not true')
  }
  if (!header.body.trim()) {
    throw new ModeSkillIntegrityError(expectedId, 'empty body')
  }
  return {
    id: expectedId,
    version: header.version,
    path: entry.path,
    sha256: digest,
    body: header.body,
    raw
  }
}

let skillsRootOverride: string | null = null
let lockOverride: ModeSkillLock | null = null
const cache = new Map<string, LoadedSkill>()

export function setModeSkillsRootForTests(root: string | null): void {
  skillsRootOverride = root
  cache.clear()
}

export function setModeSkillsLockForTests(lock: ModeSkillLock | null): void {
  lockOverride = lock
  cache.clear()
}

export function clearModeSkillsCacheForTests(): void {
  cache.clear()
}

function findRepoRoot(startDir: string): string {
  let dir = startDir
  for (let i = 0; i < 8; i++) {
    if (
      existsSync(join(dir, 'package.json')) &&
      existsSync(join(dir, 'skills', 'humanizer', 'SKILL.md'))
    ) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

export function resolveSkillsRoot(): string {
  if (skillsRootOverride) return skillsRootOverride
  const packaged = typeof process.resourcesPath === 'string' && process.resourcesPath
    ? join(process.resourcesPath, 'skills')
    : ''
  if (packaged && existsSync(join(packaged, 'humanizer', 'SKILL.md'))) return packaged
  const here = typeof __dirname === 'string' && __dirname
    ? __dirname
    : dirname(fileURLToPath(import.meta.url))
  return join(findRepoRoot(here), 'skills')
}

function lock(): ModeSkillLock {
  return lockOverride ?? modeSkillLock()
}

export function loadVerifiedSkill(id: ModeSkillId): LoadedSkill {
  const cacheKey = `${resolveSkillsRoot()}::${id}`
  const hit = cache.get(cacheKey)
  if (hit) return hit
  const entry = lock().skills[id]
  if (!entry) throw new Error(`No lock entry for skill ${id}`)
  const abs = join(resolveSkillsRoot(), entry.path)
  if (!existsSync(abs)) {
    throw new ModeSkillIntegrityError(id, `missing file ${abs}`)
  }
  const raw = readFileSync(abs, 'utf8')
  const loaded = verifySkillRaw(id, raw, lock())
  cache.set(cacheKey, loaded)
  return loaded
}

/** Locked appendix after the visible mode prompt. Custom modes: humanizer only. */
export function lockedSkillsAppendix(mode: ConversationMode): string {
  const humanizer = loadVerifiedSkill(HUMANIZER_SKILL_ID)
  if (isBuiltinConversationMode(mode)) {
    return composeLockedSkillsAppendix(mode, {
      modeSkill: loadVerifiedSkill(mode),
      humanizer
    })
  }
  return composeLockedSkillsAppendix(mode, { modeSkill: null, humanizer })
}
