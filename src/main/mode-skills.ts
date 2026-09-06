import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConversationMode } from '@shared/ipc'
import type { AskCavemanLevel } from '@shared/caveman-ask'
import {
  CAVEMAN_SKILL_ID,
  composeLockedSkillsAppendix,
  emptyOverlayLock,
  HUMANIZER_SKILL_ID,
  isBuiltinConversationMode,
  ModeSkillIntegrityError,
  modeSkillLock,
  overlaySkillRelPath,
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
let overlayRoot: string | null = null
const cache = new Map<string, LoadedSkill>()

export function setModeSkillsRootForTests(root: string | null): void {
  skillsRootOverride = root
  cache.clear()
}

export function setModeSkillsLockForTests(lock: ModeSkillLock | null): void {
  lockOverride = lock
  cache.clear()
}

export function setModeSkillsOverlayRoot(root: string | null): void {
  overlayRoot = root
  cache.clear()
}

export function clearModeSkillsCacheForTests(): void {
  cache.clear()
}

export function getModeSkillsOverlayRoot(): string | null {
  return overlayRoot
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

function readOverlayLock(): ModeSkillLock {
  if (!overlayRoot) return emptyOverlayLock()
  const p = join(overlayRoot, 'lock.json')
  if (!existsSync(p)) return emptyOverlayLock()
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as ModeSkillLock
  } catch {
    throw new ModeSkillIntegrityError('unknown', 'overlay lock unreadable')
  }
}

export function loadVerifiedSkill(id: ModeSkillId): LoadedSkill {
  const overlay = overlayRoot
  const cacheKey = `${resolveSkillsRoot()}::${overlay ?? ''}::${id}`
  const hit = cache.get(cacheKey)
  if (hit) return hit
  if (overlay) {
    const oLock = readOverlayLock()
    const oEntry = oLock.skills[id]
    const oAbs = join(overlay, overlaySkillRelPath(id))
    const oExists = existsSync(oAbs)
    if (oExists || oEntry) {
      if (!oExists || !oEntry) {
        throw new ModeSkillIntegrityError(id, 'overlay present without matching lock')
      }
      const raw = readFileSync(oAbs, 'utf8')
      const loaded = verifySkillRaw(id, raw, oLock)
      cache.set(cacheKey, loaded)
      return loaded
    }
  }
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

/**
 * Write a verified overlay skill + lock entry. Callers must already trust the bytes
 * (signed Operator pack). Tamper after write fails closed on the next load.
 */
export function applyOverlaySkillFile(id: ModeSkillId, raw: string): LoadedSkill {
  if (!overlayRoot) {
    throw new ModeSkillIntegrityError(id, 'overlay root not set')
  }
  if (raw.includes('\r')) {
    throw new ModeSkillIntegrityError(id, 'CR in file; skills must be LF-only')
  }
  const header = parseSkillHeader(raw)
  if (header.id !== id) {
    throw new ModeSkillIntegrityError(id, `header id ${header.id} != ${id}`)
  }
  if (!header.locked) {
    throw new ModeSkillIntegrityError(id, 'header locked is not true')
  }
  if (!header.body.trim()) {
    throw new ModeSkillIntegrityError(id, 'empty body')
  }
  const digest = sha256Utf8(raw)
  const lock = readOverlayLock()
  lock.skills[id] = { path: overlaySkillRelPath(id), version: header.version, sha256: digest }
  mkdirSync(join(overlayRoot, id), { recursive: true })
  writeFileSync(join(overlayRoot, overlaySkillRelPath(id)), raw, 'utf8')
  writeFileSync(join(overlayRoot, 'lock.json'), `${JSON.stringify(lock, null, 2)}\n`, 'utf8')
  cache.clear()
  return verifySkillRaw(id, raw, lock)
}

export function skillLockHashForMode(mode: ConversationMode): string {
  const shipped = lock()
  const overlay = overlayRoot ? readOverlayLock() : emptyOverlayLock()
  const parts: string[] = []
  const pick = (id: string): string => {
    const e = overlay.skills[id] ?? shipped.skills[id]
    return e ? `${id}:${e.version}:${e.sha256}` : id
  }
  if (isBuiltinConversationMode(mode)) parts.push(pick(mode))
  parts.push(pick(HUMANIZER_SKILL_ID))
  parts.push(pick(CAVEMAN_SKILL_ID))
  return sha256Utf8(parts.join('|')).slice(0, 16)
}

/** Locked appendix after the visible mode prompt. Custom modes: humanizer only. Typed Ask may add caveman. */
export function lockedSkillsAppendix(
  mode: ConversationMode,
  opts?: { caveman?: AskCavemanLevel }
): string {
  const humanizer = loadVerifiedSkill(HUMANIZER_SKILL_ID)
  const cavemanLevel = opts?.caveman ?? 'off'
  const caveman = cavemanLevel === 'off' ? null : loadVerifiedSkill(CAVEMAN_SKILL_ID)
  if (isBuiltinConversationMode(mode)) {
    return composeLockedSkillsAppendix(
      mode,
      {
        modeSkill: loadVerifiedSkill(mode),
        humanizer,
        caveman
      },
      { caveman: cavemanLevel }
    )
  }
  return composeLockedSkillsAppendix(mode, { modeSkill: null, humanizer, caveman }, { caveman: cavemanLevel })
}
