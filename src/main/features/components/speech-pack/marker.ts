import { isSafeEntryName } from './archive'
import type { SpeechPackComponentId } from './manifest'

export interface SpeechPackActivationMarker {
  schema: 2
  component: SpeechPackComponentId
  version: string
  manifestIdentity: string
}

export interface SpeechPackMarkerSnapshot {
  marker: SpeechPackActivationMarker
  bytes: Buffer
}

export function isSafeSpeechPackVersion(version: unknown): version is string {
  return (
    typeof version === 'string' &&
    version.length <= 64 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version) &&
    isSafeEntryName(version)
  )
}

export function parseSpeechPackActivationMarker(
  bytes: Buffer,
  component: SpeechPackComponentId
): SpeechPackActivationMarker | null {
  try {
    const value = parseMarkerObject(bytes, component)
    if (!value || !isSafeSpeechPackVersion(value.version)) return null
    return value as unknown as SpeechPackActivationMarker
  } catch {
    return null
  }
}

export function hasUnsafeSpeechPackMarkerVersion(bytes: Buffer, component: SpeechPackComponentId): boolean {
  const value = parseMarkerObject(bytes, component)
  return value !== null && !isSafeSpeechPackVersion(value.version)
}

function parseMarkerObject(bytes: Buffer, component: SpeechPackComponentId): Record<string, unknown> | null {
  try {
    const marker: unknown = JSON.parse(bytes.toString('utf8'))
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null
    const value = marker as Record<string, unknown>
    if (
      Object.keys(value).sort().join(',') !== 'component,manifestIdentity,schema,version' ||
      value.schema !== 2 ||
      value.component !== component ||
      typeof value.manifestIdentity !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.manifestIdentity)
    )
      return null
    return value
  } catch {
    return null
  }
}
