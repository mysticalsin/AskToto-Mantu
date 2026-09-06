import { CONVERSATION_MODES, type BuiltinMode, type ConversationMode } from './ipc'
import { DEFAULT_ASK_CAVEMAN, type AskCavemanLevel } from './caveman-ask'
import lockJson from './mode-skills.lock.json'

export const SKILL_HEADER_RE = /^---\n([\s\S]*?)\n---\n/

export const MODE_SKILL_LOCK_SCHEMA_VERSION = 1
export const MODE_SKILL_HASH_ALGORITHM = 'sha256'
export const HUMANIZER_SKILL_ID = 'humanizer' as const
export const CAVEMAN_SKILL_ID = 'caveman' as const

export type ModeSkillId = BuiltinMode | typeof HUMANIZER_SKILL_ID | typeof CAVEMAN_SKILL_ID

export interface ModeSkillLockEntry {
  path: string
  version: string
  sha256: string
}

export interface ModeSkillLock {
  schemaVersion: number
  algorithm: string
  skills: Record<string, ModeSkillLockEntry>
}

export interface LoadedSkill {
  id: ModeSkillId
  version: string
  path: string
  sha256: string
  body: string
  raw: string
}

export class ModeSkillIntegrityError extends Error {
  readonly code = 'MODE_SKILL_INTEGRITY'
  readonly skillId: string
  readonly reason: string

  constructor(skillId: string, reason: string) {
    super(
      `Métis refused to run ${skillId}: the shipped skill failed its integrity check (${reason}). Reinstall this Métis build or wait for a Métis update of that skill.`
    )
    this.name = 'ModeSkillIntegrityError'
    this.skillId = skillId
    this.reason = reason
  }
}

export function isModeSkillIntegrityError(err: unknown): err is ModeSkillIntegrityError {
  return err instanceof ModeSkillIntegrityError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { code?: unknown }).code === 'MODE_SKILL_INTEGRITY')
}

export function isBuiltinConversationMode(mode: string): mode is BuiltinMode {
  return (CONVERSATION_MODES as readonly string[]).includes(mode)
}

export function modeSkillLock(): ModeSkillLock {
  return lockJson as ModeSkillLock
}

export function parseSkillHeader(raw: string): { id: string; version: string; locked: boolean; body: string } {
  const m = SKILL_HEADER_RE.exec(raw)
  if (!m) throw new ModeSkillIntegrityError('unknown', 'missing YAML header')
  const fields: Record<string, string> = {}
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

export function expectedSkillIds(): ModeSkillId[] {
  return [HUMANIZER_SKILL_ID, CAVEMAN_SKILL_ID, ...CONVERSATION_MODES]
}

export const LOCKED_MODE_SKILL_BEGIN = '--- LOCKED MODE SKILL'
export const LOCKED_MODE_SKILL_END = '--- END LOCKED MODE SKILL ---'
export const LOCKED_HUMANIZER_BEGIN = '--- LOCKED HUMANIZER'
export const LOCKED_HUMANIZER_END = '--- END LOCKED HUMANIZER ---'
export const LOCKED_CAVEMAN_BEGIN = '--- LOCKED CAVEMAN'
export const LOCKED_CAVEMAN_END = '--- END LOCKED CAVEMAN ---'

export function formatLockedModeSkill(skill: LoadedSkill): string {
  return `\n\n${LOCKED_MODE_SKILL_BEGIN} (${skill.id} v${skill.version}) ---\n${skill.body.trim()}\n${LOCKED_MODE_SKILL_END}`
}

export function formatLockedHumanizer(skill: LoadedSkill): string {
  return `\n\n${LOCKED_HUMANIZER_BEGIN} (v${skill.version}) ---\n${skill.body.trim()}\n${LOCKED_HUMANIZER_END}`
}

export function formatLockedCaveman(
  skill: LoadedSkill,
  intensity: Exclude<AskCavemanLevel, 'off'> = DEFAULT_ASK_CAVEMAN
): string {
  const register =
    `ACTIVE REGISTER: ${intensity}. Use the ${intensity} row of the Intensity table for this answer. ` +
    'For this typed Ask answer, caveman register outranks humanizer spoken cadence. ' +
    'Humanizer still bans AI-tell words and invented first-person. Code fences stay exact.'
  return `\n\n${LOCKED_CAVEMAN_BEGIN} (v${skill.version} intensity=${intensity}) ---\n${register}\n\n${skill.body.trim()}\n${LOCKED_CAVEMAN_END}`
}

/**
 * Append locked skills AFTER the visible (user or default) mode prompt.
 * Builtin: exactly one mode skill + humanizer. Custom: humanizer only.
 * Typed Ask: caveman after humanizer when intensity is not off.
 */
export function composeLockedSkillsAppendix(
  mode: ConversationMode,
  loaded: { modeSkill: LoadedSkill | null; humanizer: LoadedSkill; caveman?: LoadedSkill | null },
  opts?: { caveman?: AskCavemanLevel }
): string {
  const parts: string[] = []
  if (isBuiltinConversationMode(mode)) {
    if (!loaded.modeSkill) {
      throw new ModeSkillIntegrityError(mode, 'missing mode skill in composition')
    }
    if (loaded.modeSkill.id !== mode) {
      throw new ModeSkillIntegrityError(mode, `composed skill id ${loaded.modeSkill.id} does not match mode`)
    }
    parts.push(formatLockedModeSkill(loaded.modeSkill))
  } else if (loaded.modeSkill) {
    throw new ModeSkillIntegrityError(mode, 'custom modes must not receive a builtin skill')
  }
  parts.push(formatLockedHumanizer(loaded.humanizer))
  const intensity = opts?.caveman ?? 'off'
  if (intensity !== 'off') {
    if (!loaded.caveman) {
      throw new ModeSkillIntegrityError(CAVEMAN_SKILL_ID, 'missing caveman skill in composition')
    }
    if (loaded.caveman.id !== CAVEMAN_SKILL_ID) {
      throw new ModeSkillIntegrityError(CAVEMAN_SKILL_ID, `composed skill id ${loaded.caveman.id} does not match caveman`)
    }
    parts.push(formatLockedCaveman(loaded.caveman, intensity))
  }
  return parts.join('')
}

export function countLockedModeSkills(system: string): number {
  return system.split(LOCKED_MODE_SKILL_BEGIN).length - 1
}

export function hasLockedHumanizer(system: string): boolean {
  return system.includes(LOCKED_HUMANIZER_BEGIN) && system.includes(LOCKED_HUMANIZER_END)
}

export function hasLockedCaveman(system: string): boolean {
  return system.includes(LOCKED_CAVEMAN_BEGIN) && system.includes(LOCKED_CAVEMAN_END)
}

export function lockedCavemanIntensityIn(system: string): string | null {
  const m = system.match(/--- LOCKED CAVEMAN \(v[\d.]+ intensity=([\w-]+)\)/)
  return m?.[1] ?? null
}

export function lockedModeSkillIdIn(system: string): string | null {
  const m = system.match(/--- LOCKED MODE SKILL \(([\w-]+) v/)
  return m?.[1] ?? null
}

export function emptyOverlayLock(): ModeSkillLock {
  return { schemaVersion: MODE_SKILL_LOCK_SCHEMA_VERSION, algorithm: MODE_SKILL_HASH_ALGORITHM, skills: {} }
}

export function overlaySkillRelPath(id: string): string {
  return `${id}/SKILL.md`
}

export function bumpSkillVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (!m) return '1.0.1'
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

export function setSkillHeaderVersion(raw: string, version: string): string {
  const m = SKILL_HEADER_RE.exec(raw)
  if (!m) return raw
  const header = m[1].replace(/^version:\s*.*$/m, `version: ${version}`)
  return `---\n${header}\n---\n${raw.slice(m[0].length)}`
}
