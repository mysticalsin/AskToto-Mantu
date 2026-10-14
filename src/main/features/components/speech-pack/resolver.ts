import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { SpeechPackComponent, SpeechPackComponentId } from './manifest'

export interface SpeechPackReadiness {
  status: 'not-installed' | 'repair-needed' | 'ready'
  componentId: SpeechPackComponentId
  version: string
  manifestIdentity: string
  /** `ready` means prior verified activation plus cheap structure/size checks, not a new digest pass. */
  evidence: 'not-verified' | 'prior-activation-and-size-checked'
  reason?: 'marker' | 'manifest' | 'path' | 'file' | 'size'
}

const MARKER_SCHEMA = 2
const MAX_MARKER_BYTES = 4096
const SAFE_RELATIVE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** SHA-256 identity of the immutable component descriptor, including source and per-file pins. */
export function componentManifestIdentity(component: SpeechPackComponent): string {
  const normalized = {
    id: component.id,
    version: component.version,
    source: component.source,
    files: [...component.files].sort((a, b) => a.path.localeCompare(b.path))
  }
  return createHash('sha256').update(canonical(normalized)).digest('hex')
}

function isInside(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function lstatRegularFile(path: string, bytes?: number): boolean {
  try {
    const item = lstatSync(path)
    return item.isFile() && item.nlink === 1 && (bytes === undefined || item.size === bytes)
  } catch {
    return false
  }
}

function componentPathValid(component: SpeechPackComponent): boolean {
  if (!/^[a-z0-9][a-z0-9.-]{1,95}$/.test(component.id)) return false
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(component.version)) return false
  if (component.files.length === 0) return false
  const seen = new Set<string>()
  for (const file of component.files) {
    if (
      !SAFE_RELATIVE.test(file.path) ||
      file.path.includes('\\') ||
      file.path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      return false
    if (
      seen.has(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0 ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    )
      return false
    seen.add(file.path)
  }
  return true
}

function notReady(
  component: SpeechPackComponent,
  manifestIdentity: string,
  status: 'not-installed' | 'repair-needed',
  reason: SpeechPackReadiness['reason']
): SpeechPackReadiness {
  return {
    status,
    componentId: component.id,
    version: component.version,
    manifestIdentity,
    evidence: 'not-verified',
    reason
  }
}

/**
 * Resolve one activated component without opening model weights. The marker is a prior activation receipt;
 * matching sizes and regular paths keep it usable for boot/status without rereading gigabytes.
 */
export function resolveSpeechPack(rootDir: string, component: SpeechPackComponent): SpeechPackReadiness {
  const manifestIdentity = componentManifestIdentity(component)
  if (!componentPathValid(component)) return notReady(component, manifestIdentity, 'repair-needed', 'path')

  const componentDir = resolve(rootDir, component.id)
  const markerPath = resolve(componentDir, 'active.json')
  let rootReal: string
  let componentReal: string
  let rootStat: ReturnType<typeof lstatSync>
  let componentStat: ReturnType<typeof lstatSync>
  let markerStat: ReturnType<typeof lstatSync>
  try {
    rootStat = lstatSync(rootDir)
    rootReal = realpathSync(rootDir)
    componentStat = lstatSync(componentDir)
    componentReal = realpathSync(componentDir)
    markerStat = lstatSync(markerPath)
  } catch {
    return notReady(component, manifestIdentity, 'not-installed', 'marker')
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return notReady(component, manifestIdentity, 'repair-needed', 'path')
  }
  if (!componentStat.isDirectory() || componentStat.isSymbolicLink() || !isInside(rootReal, componentReal)) {
    return notReady(component, manifestIdentity, 'repair-needed', 'path')
  }
  if (
    !markerStat.isFile() ||
    markerStat.isSymbolicLink() ||
    markerStat.nlink !== 1 ||
    markerStat.size > MAX_MARKER_BYTES
  ) {
    return notReady(component, manifestIdentity, 'repair-needed', 'marker')
  }

  let marker: unknown
  let markerFd = -1
  try {
    markerFd = openSync(markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(markerFd)
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size > MAX_MARKER_BYTES ||
      opened.dev !== markerStat.dev ||
      opened.ino !== markerStat.ino
    ) {
      return notReady(component, manifestIdentity, 'repair-needed', 'marker')
    }
    marker = JSON.parse(readFileSync(markerFd, 'utf8'))
  } catch {
    return notReady(component, manifestIdentity, 'repair-needed', 'marker')
  } finally {
    if (markerFd >= 0) closeSync(markerFd)
  }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker))
    return notReady(component, manifestIdentity, 'repair-needed', 'marker')
  const record = marker as Record<string, unknown>
  if (
    Object.keys(record).sort().join(',') !== 'component,manifestIdentity,schema,version' ||
    record.schema !== MARKER_SCHEMA ||
    record.component !== component.id ||
    record.version !== component.version
  ) {
    return notReady(component, manifestIdentity, 'repair-needed', 'marker')
  }
  if (record.manifestIdentity !== manifestIdentity)
    return notReady(component, manifestIdentity, 'repair-needed', 'manifest')

  const packDir = resolve(componentDir, component.version)
  let packStat: ReturnType<typeof lstatSync>
  let packReal: string
  try {
    packStat = lstatSync(packDir)
    packReal = realpathSync(packDir)
  } catch {
    return notReady(component, manifestIdentity, 'repair-needed', 'path')
  }
  if (!packStat.isDirectory() || packStat.isSymbolicLink() || !isInside(componentReal, packReal)) {
    return notReady(component, manifestIdentity, 'repair-needed', 'path')
  }

  for (const file of component.files) {
    const target = resolve(packDir, ...file.path.split('/'))
    if (!isInside(packReal, target)) return notReady(component, manifestIdentity, 'repair-needed', 'path')
    let current = packDir
    for (const part of file.path.split('/')) {
      current = resolve(current, part)
      try {
        const item = lstatSync(current)
        if (item.isSymbolicLink()) return notReady(component, manifestIdentity, 'repair-needed', 'path')
        if (current !== target && !item.isDirectory())
          return notReady(component, manifestIdentity, 'repair-needed', 'file')
      } catch {
        return notReady(component, manifestIdentity, 'repair-needed', 'file')
      }
    }
    let targetReal: string
    try {
      targetReal = realpathSync(target)
    } catch {
      return notReady(component, manifestIdentity, 'repair-needed', 'file')
    }
    if (!isInside(packReal, targetReal) || !lstatRegularFile(target, file.bytes)) {
      return notReady(component, manifestIdentity, 'repair-needed', 'size')
    }
  }

  return {
    status: 'ready',
    componentId: component.id,
    version: component.version,
    manifestIdentity,
    evidence: 'prior-activation-and-size-checked'
  }
}
