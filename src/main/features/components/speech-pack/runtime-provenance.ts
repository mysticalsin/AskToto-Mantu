/** Strict verification of a promoted optional-runtime catalog row and its Sigstore/SLSA bundle. */
import { createHash } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { bundleFromJSON } from '@sigstore/bundle'
import { TrustedRoot } from '@sigstore/protobuf-specs'
import { toSignedEntity, toTrustMaterial, Verifier } from '@sigstore/verify'

const MAX_BUNDLE_BYTES = 20 * 1024 * 1024
const MAX_INVENTORY_BYTES = 20 * 1024 * 1024
const MAX_TRUST_ROOT_BYTES = 2 * 1024 * 1024
const MAX_INVENTORY_FILES = 100_000
const MAX_INVENTORY_LICENSES = 10_000
const MAX_TOTAL_PAYLOAD_BYTES = 10_000_000_000
const SHA256 = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
const SOURCE_REPOSITORY = 'https://github.com/mysticalsin/AskToto-Mantu'
const SOURCE_REPOSITORY_ID = '1282463398'
const OID = {
  issuer: '1.3.6.1.4.1.57264.1.8',
  signerUri: '1.3.6.1.4.1.57264.1.9',
  signerDigest: '1.3.6.1.4.1.57264.1.10',
  runnerEnvironment: '1.3.6.1.4.1.57264.1.11',
  repositoryUri: '1.3.6.1.4.1.57264.1.12',
  sourceDigest: '1.3.6.1.4.1.57264.1.13',
  sourceRef: '1.3.6.1.4.1.57264.1.14',
  repositoryId: '1.3.6.1.4.1.57264.1.15'
} as const

export interface RuntimeCatalogRow {
  readonly kind: 'runtime'
  readonly componentId: string
  readonly artifactId: string
  readonly target: { readonly platform: 'darwin' | 'win32'; readonly arch: 'arm64' | 'x64' }
  readonly runtime: {
    readonly electronVersion: string
    readonly nodeAbi: string
    readonly napi: string
    readonly chromiumVersion: string
    readonly hostProtocol: 1
  }
  readonly archive: { readonly bytes: number; readonly sha256: string; readonly url: string; readonly releaseAssetId: number }
  readonly inventory: { readonly bytes: number; readonly sha256: string }
  readonly bundle: { readonly bytes: number; readonly sha256: string }
  readonly signer: {
    readonly issuer: string
    readonly repositoryUri: string
    readonly repositoryId: string
    readonly workflowPath: string
    readonly ref: string
    readonly sourceCommit: string
    readonly workflowCommit: string
    readonly predicateType: string
    readonly runnerEnvironment: string
  }
}

export interface RuntimeCatalogV1 {
  readonly schemaVersion: 1
  readonly protocolVersion: 1
  readonly catalogId: string
  readonly trustRoot: { readonly path: string; readonly bytes: number; readonly sha256: string; readonly source: string } | null
  readonly targets: readonly RuntimeCatalogRow[]
}

export interface RuntimeInventoryV1 {
  readonly schemaVersion: 1
  readonly kind: 'runtime'
  readonly componentId: string
  readonly artifactId: string
  readonly target: RuntimeCatalogRow['target']
  readonly runtime: RuntimeCatalogRow['runtime']
  readonly source: {
    readonly repositoryUri: string
    readonly commit: string
    readonly workflowPath: string
    readonly workflowCommit: string
    readonly runId: string
    readonly attempt: number
    readonly lockSha256: string
  }
  readonly builder: {
    readonly nodeVersion: string
    readonly npmVersion: string
    readonly zlibVersion: string
    readonly packages: readonly { readonly name: string; readonly version: string }[]
  }
  readonly upstream: readonly {
    readonly name: string
    readonly version: string
    readonly sourceUri: string
    readonly revision: string
    readonly digest: { readonly algorithm: 'sha256' | 'sha512'; readonly value: string }
  }[]
  readonly files: readonly { readonly path: string; readonly bytes: number; readonly sha256: string; readonly executable: boolean }[]
  readonly licenses: readonly {
    readonly package: string
    readonly version: string
    readonly spdx: string
    readonly sourceUri: string
    readonly noticePath: string
    readonly noticeBytes: number
    readonly noticeSha256: string
    readonly sourceReceiptUri: string
  }[]
}

export interface RuntimeExtractedFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  readonly executable: boolean
}

/** Require every authenticated inventory file and reject every extra archive file after safe extraction. */
export function assertRuntimeFileClosure(
  inventory: RuntimeInventoryV1,
  extractedFiles: readonly RuntimeExtractedFile[]
): void {
  if (extractedFiles.length !== inventory.files.length || extractedFiles.length > MAX_INVENTORY_FILES) {
    throw new Error('RUNTIME_ARCHIVE_FILE_CLOSURE_MISMATCH')
  }
  const expected = new Map(inventory.files.map((file) => [file.path, file]))
  const seen = new Set<string>()
  const folded = new Set<string>()
  for (const file of extractedFiles) {
    const key = file.path.toLowerCase()
    const pin = expected.get(file.path)
    if (
      !safePath(file.path) ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
      !SHA256.test(file.sha256) || typeof file.executable !== 'boolean' ||
      !pin || pin.bytes !== file.bytes || pin.sha256 !== file.sha256 || pin.executable !== file.executable ||
      seen.has(file.path) || folded.has(key)
    ) throw new Error('RUNTIME_ARCHIVE_FILE_CLOSURE_MISMATCH')
    seen.add(file.path)
    folded.add(key)
  }
}

export interface RuntimeProvenanceInput {
  /** Parsed from the app-owned catalog resource, never from downloaded candidate data. */
  readonly row: RuntimeCatalogRow
  readonly trustRootPin: RuntimeCatalogV1['trustRoot']
  /** App-owned root snapshot whose bytes match the app-owned catalog pin and verified TUF receipt. */
  readonly trustedRootJson: Uint8Array
  readonly bundleBytes: Uint8Array
  readonly archivePath: string
  readonly inventoryBytes: Uint8Array
}

export interface VerifiedRuntimeProvenance {
  readonly inventory: RuntimeInventoryV1
  readonly archiveSha256: string
  readonly inventorySha256: string
  readonly bundleSha256: string
  readonly signer: {
    readonly repositoryUri: string
    readonly repositoryId: string
    readonly workflowPath: string
    readonly ref: string
    readonly sourceCommit: string
    readonly workflowCommit: string
    readonly runnerEnvironment: string
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function boundedUtf8Json(bytes: Uint8Array, limit: number, code: string): unknown {
  if (bytes.byteLength === 0 || bytes.byteLength > limit) throw new Error(code)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(code)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(code)
  }
}

function safePath(path: unknown): path is string {
  if (
    typeof path !== 'string' ||
    path.length < 1 ||
    path.length > 1024 ||
    !/^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/.test(path) ||
    /[. ](?:\/|$)/.test(path) ||
    /(?:^|\/)(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9]|lpt[1-9])(?:\.|\/|$)/iu.test(path)
  ) return false
  return path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function httpsImmutableUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.hostname.length > 0 && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
  } catch {
    return false
  }
}

function productionArchiveUrl(value: unknown): value is string {
  if (!httpsImmutableUrl(value)) return false
  try {
    const parsed = new URL(value)
    return parsed.hostname === 'github.com' &&
      /^\/mysticalsin\/AskToto-Mantu\/releases\/download\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(parsed.pathname)
  } catch {
    return false
  }
}

function isCatalogRow(value: unknown): value is RuntimeCatalogRow {
  const row = record(value)
  if (!row || !exactKeys(row, ['kind', 'componentId', 'artifactId', 'target', 'runtime', 'archive', 'inventory', 'bundle', 'signer'])) return false
  const target = record(row.target)
  const runtime = record(row.runtime)
  const archive = record(row.archive)
  const inventory = record(row.inventory)
  const bundle = record(row.bundle)
  const signer = record(row.signer)
  return Boolean(
    row.kind === 'runtime' &&
    typeof row.componentId === 'string' && /^[a-z][a-z0-9.-]{0,79}$/.test(row.componentId) &&
    typeof row.artifactId === 'string' && /^[a-z][a-z0-9.-]{0,79}$/.test(row.artifactId) &&
    target && exactKeys(target, ['platform', 'arch']) && (target.platform === 'darwin' || target.platform === 'win32') &&
    (target.arch === 'arm64' || target.arch === 'x64') && runtime && exactKeys(runtime, ['electronVersion', 'nodeAbi', 'napi', 'chromiumVersion', 'hostProtocol']) &&
    typeof runtime.electronVersion === 'string' && /^\d+\.\d+\.\d+$/.test(runtime.electronVersion) &&
    typeof runtime.nodeAbi === 'string' && /^\d{1,8}$/.test(runtime.nodeAbi) &&
    typeof runtime.napi === 'string' && /^\d{1,8}$/.test(runtime.napi) &&
    typeof runtime.chromiumVersion === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(runtime.chromiumVersion) &&
    runtime.hostProtocol === 1 &&
    archive && exactKeys(archive, ['bytes', 'sha256', 'url', 'releaseAssetId']) && Number.isSafeInteger(archive.bytes) && (archive.bytes as number) > 0 && (archive.bytes as number) <= MAX_TOTAL_PAYLOAD_BYTES &&
    typeof archive.sha256 === 'string' && SHA256.test(archive.sha256) && productionArchiveUrl(archive.url) &&
    Number.isSafeInteger(archive.releaseAssetId) && (archive.releaseAssetId as number) > 0 &&
    inventory && exactKeys(inventory, ['bytes', 'sha256']) && Number.isSafeInteger(inventory.bytes) && (inventory.bytes as number) > 0 && (inventory.bytes as number) <= MAX_INVENTORY_BYTES &&
    typeof inventory.sha256 === 'string' && SHA256.test(inventory.sha256) &&
    bundle && exactKeys(bundle, ['bytes', 'sha256']) && Number.isSafeInteger(bundle.bytes) && (bundle.bytes as number) > 0 && (bundle.bytes as number) <= MAX_BUNDLE_BYTES &&
    typeof bundle.sha256 === 'string' && SHA256.test(bundle.sha256) && signer && exactKeys(signer, [
      'issuer', 'repositoryUri', 'repositoryId', 'workflowPath', 'ref', 'sourceCommit', 'workflowCommit', 'predicateType', 'runnerEnvironment'
    ]) && signer.issuer === 'https://token.actions.githubusercontent.com' && signer.repositoryUri === SOURCE_REPOSITORY &&
    signer.repositoryId === SOURCE_REPOSITORY_ID && typeof signer.workflowPath === 'string' &&
    /^\.github\/workflows\/[a-z0-9-]+\.yml$/.test(signer.workflowPath) &&
    signer.ref === 'refs/heads/main' &&
    typeof signer.sourceCommit === 'string' && COMMIT.test(signer.sourceCommit) &&
    typeof signer.workflowCommit === 'string' && COMMIT.test(signer.workflowCommit) &&
    signer.predicateType === 'https://slsa.dev/provenance/v1' && signer.runnerEnvironment === 'github-hosted'
  )
}

/** Parse only the closed application-owned catalog shape. Candidate files cannot define trust policy. */
export function parseRuntimeCatalog(bytes: Uint8Array): RuntimeCatalogV1 {
  const parsed = record(boundedUtf8Json(bytes, MAX_INVENTORY_BYTES, 'RUNTIME_CATALOG_INVALID'))
  if (!parsed || !exactKeys(parsed, ['schemaVersion', 'protocolVersion', 'catalogId', 'trustRoot', 'targets']) ||
      parsed.schemaVersion !== 1 || parsed.protocolVersion !== 1 || parsed.catalogId !== 'metis-runtime-catalog-v1' ||
      !Array.isArray(parsed.targets) || parsed.targets.length > 64) {
    throw new Error('RUNTIME_CATALOG_INVALID')
  }
  let trustRoot: RuntimeCatalogV1['trustRoot'] = null
  if (parsed.trustRoot !== null) {
    const root = record(parsed.trustRoot)
    if (!root || !exactKeys(root, ['path', 'bytes', 'sha256', 'source']) ||
        root.path !== 'runtime-trust/sigstore-trusted-root.json' ||
        !Number.isSafeInteger(root.bytes) || (root.bytes as number) < 1 || (root.bytes as number) > MAX_TRUST_ROOT_BYTES ||
        typeof root.sha256 !== 'string' || !SHA256.test(root.sha256) ||
        root.source !== 'https://tuf-repo-cdn.sigstore.dev/targets/trusted_root.json') {
      throw new Error('RUNTIME_TRUST_ROOT_UNAVAILABLE')
    }
    trustRoot = root as RuntimeCatalogV1['trustRoot']
  }
  const seen = new Set<string>()
  for (const row of parsed.targets) {
    if (!isCatalogRow(row)) throw new Error('RUNTIME_CATALOG_ROW_INVALID')
    const key = `${row.componentId}:${row.target.platform}:${row.target.arch}`
    if (seen.has(key)) throw new Error('RUNTIME_CATALOG_DUPLICATE_TARGET')
    seen.add(key)
  }
  return Object.freeze({
    schemaVersion: 1,
    protocolVersion: 1,
    catalogId: parsed.catalogId,
    trustRoot,
    targets: Object.freeze(parsed.targets as RuntimeCatalogRow[])
  })
}

function parseInventory(value: unknown, row: RuntimeCatalogRow): RuntimeInventoryV1 {
  const inventory = record(value)
  if (!inventory || !exactKeys(inventory, ['schemaVersion', 'kind', 'componentId', 'artifactId', 'target', 'runtime', 'source', 'builder', 'upstream', 'files', 'licenses'])) {
    throw new Error('RUNTIME_INVENTORY_INVALID')
  }
  const source = record(inventory.source)
  if (!source || !exactKeys(source, ['repositoryUri', 'commit', 'workflowPath', 'workflowCommit', 'runId', 'attempt', 'lockSha256'])) {
    throw new Error('RUNTIME_INVENTORY_INVALID')
  }
  const builder = record(inventory.builder)
  const target = record(inventory.target)
  const runtime = record(inventory.runtime)
  if (
    inventory.schemaVersion !== 1 || inventory.kind !== 'runtime' || inventory.componentId !== row.componentId || inventory.artifactId !== row.artifactId ||
    !target || !exactKeys(target, ['platform', 'arch']) || target.platform !== row.target.platform || target.arch !== row.target.arch ||
    !runtime || !exactKeys(runtime, ['electronVersion', 'nodeAbi', 'napi', 'chromiumVersion', 'hostProtocol']) ||
    runtime.electronVersion !== row.runtime.electronVersion || runtime.nodeAbi !== row.runtime.nodeAbi ||
    runtime.napi !== row.runtime.napi || runtime.chromiumVersion !== row.runtime.chromiumVersion || runtime.hostProtocol !== row.runtime.hostProtocol ||
    source.repositoryUri !== SOURCE_REPOSITORY || source.commit !== row.signer.sourceCommit ||
    source.workflowPath !== row.signer.workflowPath || source.workflowCommit !== row.signer.workflowCommit ||
    typeof source.runId !== 'string' || !/^\d{1,20}$/.test(source.runId) || !Number.isSafeInteger(source.attempt) || (source.attempt as number) < 1 ||
    typeof source.lockSha256 !== 'string' || !SHA256.test(source.lockSha256) ||
    !builder || !exactKeys(builder, ['nodeVersion', 'npmVersion', 'zlibVersion', 'packages']) ||
    typeof builder.nodeVersion !== 'string' || !/^v\d+\.\d+\.\d+$/.test(builder.nodeVersion) ||
    typeof builder.npmVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(builder.npmVersion) ||
    typeof builder.zlibVersion !== 'string' || builder.zlibVersion.length < 1 || builder.zlibVersion.length > 64 ||
    !Array.isArray(builder.packages) || builder.packages.length < 1 || builder.packages.length > 128 ||
    !Array.isArray(inventory.upstream) || inventory.upstream.length < 1 || inventory.upstream.length > 256 ||
    !Array.isArray(inventory.files) || inventory.files.length < 1 || inventory.files.length > MAX_INVENTORY_FILES ||
    !Array.isArray(inventory.licenses) || inventory.licenses.length < 1 || inventory.licenses.length > MAX_INVENTORY_LICENSES
  ) throw new Error('RUNTIME_INVENTORY_IDENTITY_MISMATCH')

  let previousPackage = ''
  for (const raw of builder.packages) {
    const item = record(raw)
    if (!item || !exactKeys(item, ['name', 'version']) || typeof item.name !== 'string' || item.name.length < 1 || item.name.length > 256 ||
        typeof item.version !== 'string' || item.version.length < 1 || item.version.length > 128 || item.name <= previousPackage) {
      throw new Error('RUNTIME_BUILDER_INVENTORY_INVALID')
    }
    previousPackage = item.name
  }
  for (const raw of inventory.upstream) {
    const item = record(raw)
    const digest = item && record(item.digest)
    if (!item || !exactKeys(item, ['name', 'version', 'sourceUri', 'revision', 'digest']) ||
        typeof item.name !== 'string' || item.name.length < 1 || item.name.length > 256 ||
        typeof item.version !== 'string' || item.version.length < 1 || item.version.length > 128 || !httpsImmutableUrl(item.sourceUri) ||
        typeof item.revision !== 'string' || item.revision.length < 1 || item.revision.length > 256 ||
        !digest || !exactKeys(digest, ['algorithm', 'value']) || (digest.algorithm !== 'sha256' && digest.algorithm !== 'sha512') ||
        typeof digest.value !== 'string' || (digest.algorithm === 'sha256' ? !SHA256.test(digest.value) : !/^[0-9a-f]{128}$/.test(digest.value))) {
      throw new Error('RUNTIME_UPSTREAM_INVENTORY_INVALID')
    }
  }

  let totalBytes = 0
  let previousPath = ''
  const exact = new Map<string, { bytes: number; sha256: string }>()
  const folded = new Set<string>()
  for (const raw of inventory.files) {
    const file = record(raw)
    if (!file || !exactKeys(file, ['path', 'bytes', 'sha256', 'executable']) || !safePath(file.path) ||
        !Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0 || typeof file.sha256 !== 'string' || !SHA256.test(file.sha256) ||
        typeof file.executable !== 'boolean' || file.path <= previousPath) throw new Error('RUNTIME_INVENTORY_INVALID')
    const key = file.path.toLowerCase()
    if (exact.has(file.path) || folded.has(key)) throw new Error('RUNTIME_INVENTORY_PATH_COLLISION')
    exact.set(file.path, { bytes: file.bytes as number, sha256: file.sha256 })
    folded.add(key)
    previousPath = file.path
    totalBytes += file.bytes as number
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_PAYLOAD_BYTES) throw new Error('RUNTIME_INVENTORY_TOO_LARGE')
  }
  for (const raw of inventory.licenses) {
    const license = record(raw)
    if (!license || !exactKeys(license, ['package', 'version', 'spdx', 'sourceUri', 'noticePath', 'noticeBytes', 'noticeSha256', 'sourceReceiptUri'])) {
      throw new Error('RUNTIME_LICENSE_RECEIPT_INVALID')
    }
    if (typeof license.package !== 'string' || !/^[A-Za-z0-9@/._+-]{1,200}$/.test(license.package) ||
        typeof license.version !== 'string' || !/^[A-Za-z0-9._+-]{1,80}$/.test(license.version) ||
        typeof license.spdx !== 'string' || !/^[A-Za-z0-9.+() -]{1,128}$/.test(license.spdx) ||
        !httpsImmutableUrl(license.sourceUri) || !safePath(license.noticePath) ||
        !Number.isSafeInteger(license.noticeBytes) || (license.noticeBytes as number) < 1 ||
        typeof license.noticeSha256 !== 'string' || !SHA256.test(license.noticeSha256) ||
        !httpsImmutableUrl(license.sourceReceiptUri)) throw new Error('RUNTIME_LICENSE_RECEIPT_INVALID')
    const notice = exact.get(license.noticePath)
    if (!notice || notice.bytes !== license.noticeBytes || notice.sha256 !== license.noticeSha256) {
      throw new Error('RUNTIME_LICENSE_NOTICE_MISSING')
    }
  }
  return inventory as unknown as RuntimeInventoryV1
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function hashPinnedArchive(path: string, expectedBytes: number): Promise<string> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== expectedBytes) {
    throw new Error('RUNTIME_ARCHIVE_SHAPE_MISMATCH')
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== expectedBytes || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('RUNTIME_ARCHIVE_SHAPE_MISMATCH')
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let offset = 0
    while (offset < expectedBytes) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expectedBytes - offset), offset)
      if (bytesRead === 0) throw new Error('RUNTIME_ARCHIVE_TRUNCATED')
      hash.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
    const after = await handle.stat()
    const pathAfter = await lstat(path)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino || pathAfter.size !== opened.size) {
      throw new Error('RUNTIME_ARCHIVE_CHANGED_DURING_VERIFY')
    }
    return hash.digest('hex')
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function textClaim(value: unknown): string | null {
  if (!(value instanceof Uint8Array)) return null
  try {
    const result = new TextDecoder('utf-8', { fatal: true }).decode(value)
    return result.length > 0 && !/[\u0000-\u001f\u007f]/.test(result) ? result : null
  } catch {
    return null
  }
}

function expectedSignerUri(row: RuntimeCatalogRow): string {
  return `${row.signer.repositoryUri}/${row.signer.workflowPath}@${row.signer.ref}`
}

function assertAuthenticatedIdentity(signer: unknown, row: RuntimeCatalogRow): void {
  const signerRecord = record(signer)
  const identity = signerRecord && record(signerRecord.identity)
  if (!identity || identity.issuer !== row.signer.issuer || identity.subjectAlternativeName !== expectedSignerUri(row) || !Array.isArray(identity.oids)) {
    throw new Error('RUNTIME_CERTIFICATE_IDENTITY_UNSUPPORTED')
  }
  const claims = new Map<string, string>()
  for (const raw of identity.oids) {
    const extension = record(raw)
    const oid = extension && record(extension.oid)
    if (!extension || !oid || !Array.isArray(oid.id) || !oid.id.every((part) => Number.isInteger(part) && part >= 0 && part <= 4_294_967_295)) {
      throw new Error('RUNTIME_CERTIFICATE_EXTENSION_UNSUPPORTED')
    }
    const id = oid.id.join('.')
    const value = textClaim(extension.value)
    if (!value || claims.has(id)) throw new Error('RUNTIME_CERTIFICATE_EXTENSION_UNSUPPORTED')
    claims.set(id, value)
  }
  const expected = new Map<string, string>([
    [OID.issuer, row.signer.issuer],
    [OID.signerUri, expectedSignerUri(row)],
    [OID.signerDigest, row.signer.workflowCommit],
    [OID.runnerEnvironment, row.signer.runnerEnvironment],
    [OID.repositoryUri, row.signer.repositoryUri],
    [OID.sourceDigest, row.signer.sourceCommit],
    [OID.sourceRef, row.signer.ref],
    [OID.repositoryId, row.signer.repositoryId]
  ])
  for (const [oid, value] of expected) if (claims.get(oid) !== value) throw new Error('RUNTIME_CERTIFICATE_CLAIM_MISMATCH')
}

function assertStatement(statement: unknown, row: RuntimeCatalogRow, archiveHash: string, inventoryHash: string): void {
  const recordValue = record(statement)
  if (!recordValue || !exactKeys(recordValue, ['_type', 'subject', 'predicateType', 'predicate']) ||
      recordValue._type !== 'https://in-toto.io/Statement/v1' || recordValue.predicateType !== row.signer.predicateType ||
      !Array.isArray(recordValue.subject) || recordValue.subject.length !== 2 || !record(recordValue.predicate)) {
    throw new Error('RUNTIME_ATTESTATION_FORMAT_UNSUPPORTED')
  }
  const subjects = new Map<string, string>()
  for (const raw of recordValue.subject) {
    const subject = record(raw)
    const digest = subject && record(subject.digest)
    if (!subject || !exactKeys(subject, ['name', 'digest']) || typeof subject.name !== 'string' || subject.name.length < 1 ||
        subject.name.length > 512 || !safePath(subject.name) || !digest || !exactKeys(digest, ['sha256']) ||
        typeof digest.sha256 !== 'string' || !SHA256.test(digest.sha256) || subjects.has(subject.name)) {
      throw new Error('RUNTIME_ATTESTATION_FORMAT_UNSUPPORTED')
    }
    subjects.set(subject.name, digest.sha256)
  }
  const archiveParts = new URL(row.archive.url).pathname.split('/')
  const archiveName = archiveParts[archiveParts.length - 1]
  const inventoryName = `${row.artifactId}.inventory.json`
  if (
    !archiveName ||
    subjects.size !== 2 ||
    subjects.get(archiveName) !== archiveHash ||
    subjects.get(inventoryName) !== inventoryHash
  ) {
    throw new Error('RUNTIME_ATTESTATION_SUBJECT_MISMATCH')
  }
}

/**
 * Verify the maintained Sigstore implementation's signature, transparency-log inclusion, certificate
 * chain and timestamp using the library's secure defaults, then bind the authenticated SLSA statement to
 * the exact archive and inventory bytes. Unsupported certificate encodings fail closed.
 */
export async function verifyWithCatalogIdentity(input: RuntimeProvenanceInput): Promise<VerifiedRuntimeProvenance> {
  const { row, trustRootPin, bundleBytes, archivePath, inventoryBytes, trustedRootJson } = input
  if (!isCatalogRow(row)) throw new Error('RUNTIME_CATALOG_ROW_INVALID')
  if (!trustRootPin) throw new Error('RUNTIME_TRUST_ROOT_UNAVAILABLE')
  if (trustedRootJson.byteLength !== trustRootPin.bytes || trustedRootJson.byteLength > MAX_TRUST_ROOT_BYTES || sha256(trustedRootJson) !== trustRootPin.sha256) {
    throw new Error('RUNTIME_TRUST_ROOT_PIN_MISMATCH')
  }
  if (bundleBytes.byteLength !== row.bundle.bytes || bundleBytes.byteLength > MAX_BUNDLE_BYTES || sha256(bundleBytes) !== row.bundle.sha256) {
    throw new Error('RUNTIME_BUNDLE_PIN_MISMATCH')
  }
  if (inventoryBytes.byteLength !== row.inventory.bytes || inventoryBytes.byteLength > MAX_INVENTORY_BYTES || sha256(inventoryBytes) !== row.inventory.sha256) {
    throw new Error('RUNTIME_INVENTORY_PIN_MISMATCH')
  }
  const archiveHash = await hashPinnedArchive(archivePath, row.archive.bytes)
  if (archiveHash !== row.archive.sha256) throw new Error('RUNTIME_ARCHIVE_PIN_MISMATCH')
  const inventoryHash = sha256(inventoryBytes)
  const inventory = parseInventory(boundedUtf8Json(inventoryBytes, MAX_INVENTORY_BYTES, 'RUNTIME_INVENTORY_INVALID'), row)
  const trustedRoot = record(boundedUtf8Json(trustedRootJson, MAX_TRUST_ROOT_BYTES, 'RUNTIME_TRUST_ROOT_UNAVAILABLE'))
  if (!trustedRoot) throw new Error('RUNTIME_TRUST_ROOT_UNAVAILABLE')
  const bundleJson = boundedUtf8Json(bundleBytes, MAX_BUNDLE_BYTES, 'RUNTIME_BUNDLE_INVALID')
  let bundle: unknown
  try {
    bundle = (bundleFromJSON as (value: unknown) => unknown)(bundleJson)
  } catch {
    throw new Error('RUNTIME_BUNDLE_INVALID')
  }
  const dsse = record(bundle)
  const envelope = dsse && record(dsse.dsseEnvelope)
  if (!envelope || typeof envelope.payload !== 'string' || envelope.payload.length > MAX_BUNDLE_BYTES * 2 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload)) {
    throw new Error('RUNTIME_ATTESTATION_FORMAT_UNSUPPORTED')
  }
  const rootProto = TrustedRoot.fromJSON(trustedRoot)
  const trustMaterial = toTrustMaterial(rootProto)
  // Explicit values preserve the maintained library's production thresholds rather than relaxing them.
  const verifier = new Verifier(trustMaterial, { tlogThreshold: 1, ctlogThreshold: 1, timestampThreshold: 1 })
  let authenticatedSigner: unknown
  try {
    const entity = toSignedEntity(bundle as Parameters<typeof toSignedEntity>[0])
    authenticatedSigner = await verifier.verify(entity)
  } catch {
    throw new Error('RUNTIME_SIGNATURE_OR_TRANSPARENCY_INVALID')
  }
  assertAuthenticatedIdentity(authenticatedSigner, row)
  let statement: unknown
  try {
    const payload = Buffer.from(envelope.payload, 'base64')
    if (payload.toString('base64') !== envelope.payload) throw new Error('payload encoding')
    if (payload.length === 0 || payload.length > MAX_BUNDLE_BYTES) throw new Error('payload size')
    statement = boundedUtf8Json(payload, MAX_BUNDLE_BYTES, 'RUNTIME_ATTESTATION_FORMAT_UNSUPPORTED')
  } catch {
    throw new Error('RUNTIME_ATTESTATION_FORMAT_UNSUPPORTED')
  }
  assertStatement(statement, row, archiveHash, inventoryHash)
  return Object.freeze({
    inventory,
    archiveSha256: archiveHash,
    inventorySha256: inventoryHash,
    bundleSha256: sha256(bundleBytes),
    signer: Object.freeze({
      repositoryUri: row.signer.repositoryUri,
      repositoryId: row.signer.repositoryId,
      workflowPath: row.signer.workflowPath,
      ref: row.signer.ref,
      sourceCommit: row.signer.sourceCommit,
      workflowCommit: row.signer.workflowCommit,
      runnerEnvironment: row.signer.runnerEnvironment
    })
  })
}
