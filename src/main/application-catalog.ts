import { createHmac } from 'node:crypto'
import { posix, win32 } from 'node:path'
import type { ApplicationDiscovery } from './application-discovery'
import type {
  ApplicationCatalogSnapshot, ApplicationKind, ApplicationResolution,
  ApplicationRevalidation, ApplicationView, CandidateSetVersion
} from './application-catalog-view'

const KINDS: readonly ApplicationKind[] = ['notes', 'browser', 'document-editor', 'terminal',
  'system-admin', 'installer', 'credential-security', 'camera-media-capture', 'unknown']
const ELIGIBLE = new Set<ApplicationKind>(['notes', 'browser', 'document-editor'])
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u
const normalize = (value: string): string => value.normalize('NFC').trim().replace(/\s+/gu, ' ')
const match = (value: string): string => normalize(value).toLowerCase()
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !UNSAFE_TEXT.test(value)

/** Validate and canonicalize only known native identity forms. No execution occurs. */
function nativeIdentity(value: unknown): { identity: readonly string[]; fingerprint: string } | null {
  if (!record(value) || !text(value.fingerprint, 512)) return null
  const keys = Object.keys(value).sort().join(',')
  if (value.platform === 'darwin' && keys === 'bundleId,bundlePath,fingerprint,platform' &&
      text(value.bundlePath, 4096) && text(value.bundleId, 256) &&
      /^\/[\s\S]+\.app$/.test(value.bundlePath) && !value.bundlePath.split('/').includes('..') &&
      /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value.bundleId)) {
    return { identity: ['darwin', posix.normalize(value.bundlePath), value.bundleId], fingerprint: value.fingerprint }
  }
  if (value.platform === 'win32' && keys === 'executablePath,fingerprint,platform' &&
      text(value.executablePath, 4096) && /^[A-Za-z]:\\/.test(value.executablePath) &&
      !value.executablePath.split(/[\\/]/).includes('..') && /\.exe$/i.test(value.executablePath) &&
      !/[<>"|?*]/.test(value.executablePath) && !value.executablePath.slice(2).includes(':')) {
    const path = win32.normalize(value.executablePath)
    return { identity: ['win32-exe', path[0].toUpperCase() + path.slice(1)], fingerprint: value.fingerprint }
  }
  if (value.platform === 'win32' && keys === 'aumid,fingerprint,platform' &&
      text(value.aumid, 256) && /^[A-Za-z0-9._-]+![A-Za-z0-9._-]+$/.test(value.aumid)) {
    return { identity: ['win32-aumid', value.aumid], fingerprint: value.fingerprint }
  }
  return null
}

function publicLabel(value: unknown, privateValues: readonly string[]): value is string {
  if (!text(value, 120) || /[\\/:]/.test(value) || /\.(?:exe|app)\b/i.test(value)) return false
  const normalized = match(value)
  return normalized.length > 0 && !privateValues.some(secret => normalized.includes(secret))
}

/** Collect native values before validating record metadata. An invalid kind, label,
 * fingerprint, or extra native field must not make another record's label safe.
 * The index is local to discovery and never retained in a public view or result.
 */
function privateLabelValues(discovered: readonly unknown[]): readonly string[] {
  const values = new Set<string>()
  for (const raw of discovered) {
    if (!record(raw) || !record(raw.native)) continue
    for (const field of ['bundlePath', 'bundleId', 'executablePath', 'aumid', 'fingerprint']) {
      const value = raw.native[field]
      if (!text(value, 4096)) continue
      const normalized = match(value)
      if (normalized.length > 0) values.add(normalized)
    }
  }
  return [...values]
}

export interface ApplicationCatalogOptions {
  discovery: ApplicationDiscovery
  /** A random, persisted, main-owned key of at least 32 bytes. Never expose it. */
  installationKey: Uint8Array
  ttlMs?: number
  now?: () => number
}

/** Selection only, not authorization. All mutable/private state uses true private fields.
 * Native targets are consumed while hashing then discarded, never returned or stored in views.
 * A future native adapter still must re-check its exact target at the execution boundary.
 */
export class ApplicationCatalog {
  #discovery: ApplicationDiscovery
  #key: Buffer
  #ttl: number
  #now: () => number
  #snapshot: ApplicationCatalogSnapshot | undefined
  #updatedAt = -Infinity
  #expiresAt = -Infinity
  #pending: Promise<ApplicationCatalogSnapshot> | undefined

  constructor(options: ApplicationCatalogOptions) {
    const ttl = options.ttlMs ?? 30_000
    if (!(options.installationKey instanceof Uint8Array) || options.installationKey.byteLength < 32) {
      throw new Error('Application catalog requires a private installation key')
    }
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 300_000) throw new Error('Invalid application catalog TTL')
    this.#key = Buffer.from(options.installationKey)
    this.#discovery = options.discovery
    this.#ttl = ttl
    this.#now = options.now ?? (() => performance.now())
  }

  async snapshot(): Promise<ApplicationCatalogSnapshot> {
    if (this.#pending) return this.#pending
    const now = this.#now()
    if (this.#snapshot && now >= this.#updatedAt && now < this.#expiresAt) return this.#snapshot
    return this.refresh()
  }

  async refresh(): Promise<ApplicationCatalogSnapshot> {
    if (this.#pending) return this.#pending
    this.#expiresAt = -Infinity
    this.#pending = this.#discover()
    try { return await this.#pending } finally { this.#pending = undefined }
  }

  async resolve(query: string): Promise<ApplicationResolution> {
    const snapshot = await this.snapshot(), version = this.#version(snapshot)
    if (!text(query, 120)) return Object.freeze({ ...version, status: 'missing' })
    const alias = match(query)
    const candidates = snapshot.applications.filter(app => match(app.displayName) === alias || app.aliases.includes(alias))
    if (candidates.length === 0) return Object.freeze({ ...version, status: 'missing' })
    if (candidates.length > 1) return Object.freeze({ ...version, status: 'ambiguous', candidates: Object.freeze(candidates) })
    return Object.freeze({ ...version, status: candidates[0].availability === 'available' ? 'resolved' : 'unavailable', application: candidates[0] })
  }

  async revalidate(id: string, expected: CandidateSetVersion): Promise<ApplicationRevalidation> {
    // Always bypass TTL. A cached catalog cannot confirm that a prior target still exists.
    // An in-flight read may predate this request; finish it before starting a new read.
    if (this.#pending) await this.#pending
    const snapshot = await this.refresh(), version = this.#version(snapshot)
    const application = snapshot.applications.find(app => app.id === id)
    if (!application) return Object.freeze({ ...version, status: 'missing' })
    if (application.availability !== 'available') return Object.freeze({ ...version, status: 'unavailable', application })
    const same = expected?.revision === snapshot.revision && expected?.digest === snapshot.digest
    return Object.freeze({ ...version, status: same ? 'valid' : 'stale', application })
  }

  #version(snapshot: ApplicationCatalogSnapshot): CandidateSetVersion {
    return { revision: snapshot.revision, digest: snapshot.digest }
  }

  #hash(domain: string, value: unknown): string {
    return createHmac('sha256', this.#key).update(JSON.stringify([domain, value])).digest('hex')
  }

  async #discover(): Promise<ApplicationCatalogSnapshot> {
    try {
      const discovered = await this.#discovery.discover()
      if (!Array.isArray(discovered) || discovered.length > 5000) throw new Error('Invalid discovery')
      const privateValues = privateLabelValues(discovered)
      const entries = new Map<string, { view: ApplicationView; commitment: string }>()
      const conflicts = new Set<string>()
      for (const raw of discovered) {
        if (!record(raw)) continue
        const native = nativeIdentity(raw.native)
        if (!native || !KINDS.includes(raw.kind as ApplicationKind) || typeof raw.available !== 'boolean' ||
            !Array.isArray(raw.aliases) || raw.aliases.length > 32) continue
        if (!publicLabel(raw.displayName, privateValues) || !raw.aliases.every(alias => publicLabel(alias, privateValues))) continue
        const id = `app_${this.#hash('application-identity-v1', native.identity)}`
        const kind = raw.kind as ApplicationKind, eligible = ELIGIBLE.has(kind)
        const view: ApplicationView = Object.freeze({
          id, displayName: normalize(raw.displayName), aliases: Object.freeze([...new Set(raw.aliases.map(match))].sort()), kind,
          risk: eligible ? 'R1' : 'restricted', availability: !eligible ? 'restricted' : raw.available ? 'available' : 'unavailable'
        })
        const commitment = this.#hash('application-record-v1', [native.identity, native.fingerprint, view])
        const previous = entries.get(id)
        if (previous && previous.commitment !== commitment) conflicts.add(id)
        entries.set(id, { view, commitment })
      }
      for (const id of conflicts) entries.delete(id)
      const ordered = [...entries.values()].sort((a, b) => a.view.id < b.view.id ? -1 : a.view.id > b.view.id ? 1 : 0)
      const digest = this.#hash('application-candidate-set-v1', ordered.map(entry => entry.commitment))
      const revision = (this.#snapshot?.revision ?? 0) + (this.#snapshot?.digest === digest ? 0 : 1)
      const snapshot = Object.freeze({ revision, digest, applications: Object.freeze(ordered.map(entry => entry.view)) })
      const now = this.#now()
      if (!Number.isFinite(now)) throw new Error('Invalid clock')
      this.#snapshot = snapshot
      this.#updatedAt = now
      this.#expiresAt = now + this.#ttl
      return snapshot
    } catch {
      // Provider errors may contain private paths or native identifiers; never forward them.
      throw new Error('Application discovery unavailable')
    }
  }
}
