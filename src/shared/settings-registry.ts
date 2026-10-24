/**
 * Typed settings registry, generated from `BaseSettingsSchema` so it cannot drift from the real settings.
 *
 * Each entry names a setting that exists (key, kind, default, enum options, numeric or length range, a label
 * and the owning feature module). Anything that has to name a setting (a voice or text request, a Settings
 * deep link, a migration report) resolves through here and gets `null` for a name that is not a setting, so it
 * can never invent one. Defaults are read off the schema, never restated: this module changes no default.
 */
import { z } from 'zod'
import { BaseSettingsSchema, DEFAULT_SETTINGS } from './ipc'
import { CLOUD_SPEECH_FEATURE } from './broker-speech-settings'
import { OPERATOR_REPORTING_FEATURE } from './operator-reporting-settings'
import { PROACTIVE_CONTROLS_FEATURE } from './proactive-settings'
import { SCREEN_OBSERVATION_FEATURE } from './screen-observation-settings'
import { QUIET_MODE_FEATURE } from './quiet-mode-settings'
import type { SettingsFeatureModule } from './settings-feature-module'
import { SPOKEN_REPLIES_FEATURE } from './spoken-replies-settings'
import { VOICE_ACTIONS_FEATURE } from './voice-actions-settings'

export type SettingKind = 'boolean' | 'number' | 'string' | 'enum' | 'array' | 'record' | 'object' | 'union' | 'unknown'

export interface SettingEntry {
  readonly key: string
  readonly label: string
  readonly kind: SettingKind
  /** The value a profile without the key loads with: the DEFAULT_SETTINGS layer, else the schema default. */
  readonly default: unknown
  readonly nullable: boolean
  readonly options?: readonly string[]
  /** Numeric bound, or string length bound, when the schema declares one. */
  readonly min?: number
  readonly max?: number
  /** Feature module id, or `core` for keys declared directly in ipc.ts. */
  readonly owner: string
  /** True when only main may write the key. */
  readonly mainOnly: boolean
}

/** Every feature module spread into BaseSettingsSchema. A new `*-settings.ts` module is added here. */
export const SETTINGS_FEATURE_MODULES: readonly SettingsFeatureModule[] = [
  CLOUD_SPEECH_FEATURE,
  OPERATOR_REPORTING_FEATURE,
  PROACTIVE_CONTROLS_FEATURE,
  SCREEN_OBSERVATION_FEATURE,
  QUIET_MODE_FEATURE,
  SPOKEN_REPLIES_FEATURE,
  VOICE_ACTIONS_FEATURE
]

const ACRONYMS = new Set(['asr', 'stt', 'llm', 'mcp', 'url', 'id', 'ai', 'cf', 'api', 'cli', 'ui', 'sso', 'jti', 'ocr'])

/** `cfAiGatewayId` -> `CF AI gateway ID`. */
function humanize(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
  const text = words.map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w)).join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

interface Described {
  kind: SettingKind
  nullable: boolean
  options?: readonly string[]
  min?: number
  max?: number
}

/** The zod 4 definition shape this module reads. Introspection goes through the public `_zod.def` contract. */
interface ZodDef {
  type: string
  innerType?: z.ZodType
  in?: z.ZodType
  out?: z.ZodType
  entries?: Record<string, string | number>
  checks?: Array<{
    _zod: { def: { check?: string; value?: unknown; minimum?: unknown; maximum?: unknown; inclusive?: boolean } }
  }>
}

function describeSchema(schema: z.ZodType): Described {
  let current = schema
  let nullable = false
  for (;;) {
    const def = current._zod.def as unknown as ZodDef
    switch (def.type) {
      case 'default':
      case 'prefault':
      case 'optional':
      case 'catch':
      case 'readonly':
        current = def.innerType!
        continue
      case 'nullable':
        nullable = true
        current = def.innerType!
        continue
      case 'pipe':
        // `.transform()` and `.preprocess()` are pipes with a transform on one side: describe the real side.
        // A pipe between two real schemas (`.pipe()`) stays `unknown`, as it always did.
        if (def.out!._zod.def.type === 'transform') current = def.in!
        else if (def.in!._zod.def.type === 'transform') current = def.out!
        else return { kind: 'unknown', nullable }
        continue
      case 'boolean':
        return { kind: 'boolean', nullable }
      case 'number':
        return { kind: 'number', nullable, ...bounds(def.checks ?? []) }
      case 'string':
        return { kind: 'string', nullable, ...bounds(def.checks ?? []) }
      case 'enum':
        return { kind: 'enum', nullable, options: Object.values(def.entries!).map(String) }
      case 'array':
        return { kind: 'array', nullable }
      case 'record':
      case 'map':
        return { kind: 'record', nullable }
      case 'object':
        return { kind: 'object', nullable }
      case 'union':
        return { kind: 'union', nullable }
      default:
        return { kind: 'unknown', nullable }
    }
  }
}

/** Explicit `.min()` / `.max()` (numeric value or string length). Format checks such as `.int()` are not bounds. */
function bounds(checks: NonNullable<ZodDef['checks']>): { min?: number; max?: number } {
  const out: { min?: number; max?: number } = {}
  for (const check of checks) {
    const def = check._zod.def
    if (def.check === 'greater_than' && typeof def.value === 'number') out.min = def.value
    if (def.check === 'less_than' && typeof def.value === 'number') out.max = def.value
    if (def.check === 'min_length' && typeof def.minimum === 'number') out.min = def.minimum
    if (def.check === 'max_length' && typeof def.maximum === 'number') out.max = def.maximum
  }
  return out
}

/** Pure: builds the registry for a schema shape and its feature modules. Throws if the two disagree. */
export function buildSettingsRegistry(
  shape: Readonly<Record<string, z.ZodType>>,
  modules: readonly SettingsFeatureModule[],
  defaults: Readonly<Record<string, unknown>> = {}
): readonly SettingEntry[] {
  const owner = new Map<string, string>()
  const mainOnly = new Set<string>()
  for (const module of modules) {
    for (const key of Object.keys(module.shape)) {
      if (!Object.hasOwn(shape, key))
        throw new Error(`Settings feature "${module.id}" declares "${key}", which is not in the schema`)
      const previous = owner.get(key)
      if (previous) throw new Error(`Setting "${key}" is claimed by both "${previous}" and "${module.id}"`)
      owner.set(key, module.id)
    }
    for (const key of module.mainOnlyKeys) mainOnly.add(key)
  }
  return Object.freeze(
    Object.keys(shape).map((key): SettingEntry => {
      const field = shape[key]
      const parsedDefault = field.safeParse(undefined)
      return Object.freeze({
        key,
        label: humanize(key),
        ...describeSchema(field),
        default: Object.hasOwn(defaults, key) ? defaults[key] : parsedDefault.success ? parsedDefault.data : undefined,
        owner: owner.get(key) ?? 'core',
        mainOnly: mainOnly.has(key)
      })
    })
  )
}

export const SETTINGS_REGISTRY: readonly SettingEntry[] = buildSettingsRegistry(
  BaseSettingsSchema.shape,
  SETTINGS_FEATURE_MODULES,
  DEFAULT_SETTINGS
)

const BY_KEY: ReadonlyMap<string, SettingEntry> = new Map(SETTINGS_REGISTRY.map((entry) => [entry.key, entry]))

export function findSetting(key: string): SettingEntry | undefined {
  return BY_KEY.get(key)
}

export function isRegisteredSettingKey(key: string): boolean {
  return BY_KEY.has(key)
}

function normalizeName(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

const BY_NAME: ReadonlyMap<string, SettingEntry | null> = (() => {
  const map = new Map<string, SettingEntry | null>()
  for (const entry of SETTINGS_REGISTRY) {
    for (const name of new Set([normalizeName(entry.key), normalizeName(entry.label)])) {
      map.set(name, map.has(name) && map.get(name) !== entry ? null : entry) // an ambiguous name resolves to nothing
    }
  }
  return map
})()

/** Resolve a typed or spoken name (the key or its label, case and spacing ignored) to a real setting, else null. */
export function resolveSettingByName(text: string): SettingEntry | null {
  const name = normalizeName(text)
  return name ? (BY_NAME.get(name) ?? null) : null
}
