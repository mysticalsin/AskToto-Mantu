/** Strict verification of a promoted optional-runtime catalog row and its Sigstore/SLSA bundle. */
import { createHash } from 'node:crypto'
import { bundleFromJSON, type Bundle } from '@sigstore/bundle'
import { TrustedRoot } from '@sigstore/protobuf-specs'
import { toSignedEntity, toTrustMaterial, Verifier } from '@sigstore/verify'
import { parseRuntimeInventory } from './runtime-inventory'
import { hashPinnedArchive } from './runtime-archive'
import { verifyPinnedRuntimeTrust } from './runtime-trust'
import type { RuntimeEntryRole, RuntimeModelId } from './runtime-lease'

const MAX_BUNDLE_BYTES = 20 * 1024 * 1024
const MAX_INVENTORY_BYTES = 20 * 1024 * 1024
const MAX_TRUST_ROOT_BYTES = 2 * 1024 * 1024
const MAX_INVENTORY_FILES = 100_000
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
  readonly kind: 'runtime' | 'model'
  readonly componentId: string
  readonly artifactId: string
  readonly target: { readonly platform: 'darwin' | 'win32' | 'any'; readonly arch: 'arm64' | 'x64' | 'any' }
  readonly runtime: {
    readonly electronVersion: string
    readonly nodeAbi: string
    readonly napi: string
    readonly chromiumVersion: string
    readonly hostProtocol: 1
  } | null
  readonly payloadBytes: number
  readonly archive: {
    readonly bytes: number
    readonly sha256: string
    readonly url: string
    readonly releaseAssetId: number
  }
  readonly inventory: {
    readonly bytes: number
    readonly sha256: string
    readonly url: string
    readonly releaseAssetId: number
  }
  readonly bundle: {
    readonly bytes: number
    readonly sha256: string
    readonly url: string
    readonly releaseAssetId: number
  }
  readonly entrypoints: Readonly<Partial<Record<RuntimeEntryRole, string>>>
  readonly models: readonly {
    readonly id: RuntimeModelId
    readonly root: string
    readonly members: readonly string[]
  }[]
  readonly directories: Readonly<
    Partial<
      Record<
        'whisper-ort-wasm',
        {
          readonly root: string
          readonly members: readonly string[]
        }
      >
    >
  >
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
  readonly trustRoot: {
    readonly path: string
    readonly bytes: number
    readonly sha256: string
    readonly source: string
    readonly receipt: { readonly path: string; readonly bytes: number; readonly sha256: string }
  } | null
  readonly targets: readonly RuntimeCatalogRow[]
}

export interface RuntimeInventoryV1 {
  readonly schemaVersion: 1
  readonly kind: 'runtime' | 'model'
  readonly componentId: string
  readonly artifactId: string
  readonly target: RuntimeCatalogRow['target']
  readonly runtime: RuntimeCatalogRow['runtime']
  readonly source: {
    readonly repositoryUri: string
    readonly commit: string
    readonly ref: string
    readonly workflowPath: string
    readonly workflowCommit: string
    readonly runId: string
    readonly attempt: number
    readonly lockSha256: string
    readonly runnerEnvironment: string
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
  readonly files: readonly {
    readonly path: string
    readonly bytes: number
    readonly sha256: string
    readonly executable: boolean
  }[]
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
  readonly entrypoints: RuntimeCatalogRow['entrypoints']
  readonly models: RuntimeCatalogRow['models']
  readonly directories: RuntimeCatalogRow['directories']
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
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !SHA256.test(file.sha256) ||
      typeof file.executable !== 'boolean' ||
      !pin ||
      pin.bytes !== file.bytes ||
      pin.sha256 !== file.sha256 ||
      pin.executable !== file.executable ||
      seen.has(file.path) ||
      folded.has(key)
    )
      throw new Error('RUNTIME_ARCHIVE_FILE_CLOSURE_MISMATCH')
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
  /** App-owned acquisition receipt, separately pinned by the app-owned catalog. */
  readonly trustedRootReceiptJson: Uint8Array
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
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child)
    Object.freeze(value)
  }
  return value
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
  )
    return false
  return path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function httpsImmutableUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const parsed = new URL(value)
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.length > 0 &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    )
  } catch {
    return false
  }
}

function productionArchiveUrl(value: unknown): value is string {
  if (!httpsImmutableUrl(value)) return false
  try {
    const parsed = new URL(value)
    return (
      parsed.hostname === 'github.com' &&
      /^\/mysticalsin\/AskToto-Mantu\/releases\/download\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(parsed.pathname)
    )
  } catch {
    return false
  }
}

function validModelRows(rows: readonly unknown[], allowed: readonly string[]): boolean {
  const ids = new Set<string>()
  const members = new Set<string>()
  return (
    rows.length <= allowed.length &&
    rows.every((raw) => {
      const model = record(raw)
      if (
        !model ||
        !exactKeys(model, ['id', 'root', 'members']) ||
        typeof model.id !== 'string' ||
        !allowed.includes(model.id) ||
        ids.has(model.id) ||
        !safePath(model.root) ||
        !Array.isArray(model.members) ||
        model.members.length === 0 ||
        model.members.length > MAX_INVENTORY_FILES
      )
        return false
      ids.add(model.id)
      for (const member of model.members) {
        if (
          typeof member !== 'string' ||
          !safePath(member) ||
          members.has(member.toLowerCase()) ||
          !member.startsWith(`${model.root}/`)
        )
          return false
        members.add(member.toLowerCase())
      }
      return true
    })
  )
}

function isCatalogRow(value: unknown): value is RuntimeCatalogRow {
  const row = record(value)
  if (
    !row ||
    !exactKeys(row, [
      'kind',
      'componentId',
      'artifactId',
      'target',
      'runtime',
      'payloadBytes',
      'archive',
      'inventory',
      'bundle',
      'signer',
      'entrypoints',
      'models',
      'directories'
    ])
  )
    return false
  const target = record(row.target)
  const runtime = record(row.runtime)
  const archive = record(row.archive)
  const inventory = record(row.inventory)
  const bundle = record(row.bundle)
  const signer = record(row.signer)
  const entrypoints = record(row.entrypoints)
  const directories = record(row.directories)
  const roles = [
    'parakeet-host',
    'whisper-import-host',
    'whisper-renderer-worker',
    'speaker-embedding-host',
    'llama-server'
  ]
  const modelIds = [
    'asr.parakeet-tdt-0.6b-v3-int8',
    'asr.whisper-base-q8',
    'speaker.embedding',
    'qwen3.5-0.8b',
    'qwen3.5-4b'
  ]
  const models = Array.isArray(row.models) ? row.models : null
  const modelRowsValid = models !== null && validModelRows(models, modelIds)
  const runtimeShape =
    row.kind === 'runtime'
      ? Boolean(
          runtime &&
            target &&
            target.platform !== 'any' &&
            target.arch !== 'any' &&
            modelRowsValid &&
            models?.length === 0 &&
            entrypoints &&
            Object.keys(entrypoints).length > 0
        )
      : Boolean(
          row.kind === 'model' &&
            row.runtime === null &&
            target?.platform === 'any' &&
            target.arch === 'any' &&
            runtime === null &&
            modelRowsValid &&
            models?.length > 0 &&
            entrypoints &&
            Object.keys(entrypoints).length === 0
        )
  return Boolean(
    (row.kind === 'runtime' || row.kind === 'model') &&
      runtimeShape &&
      Number.isSafeInteger(row.payloadBytes) &&
      (row.payloadBytes as number) > 0 &&
      (row.payloadBytes as number) <= MAX_TOTAL_PAYLOAD_BYTES &&
      typeof row.componentId === 'string' &&
      /^[a-z][a-z0-9.-]{0,79}$/.test(row.componentId) &&
      typeof row.artifactId === 'string' &&
      /^[a-z][a-z0-9.-]{0,79}$/.test(row.artifactId) &&
      target &&
      exactKeys(target, ['platform', 'arch']) &&
      (target.platform === 'darwin' || target.platform === 'win32' || target.platform === 'any') &&
      (target.arch === 'arm64' || target.arch === 'x64' || target.arch === 'any') &&
      (row.kind === 'model' ||
        Boolean(
          runtime &&
            exactKeys(runtime, ['electronVersion', 'nodeAbi', 'napi', 'chromiumVersion', 'hostProtocol']) &&
            typeof runtime.electronVersion === 'string' &&
            /^\d+\.\d+\.\d+$/.test(runtime.electronVersion) &&
            typeof runtime.nodeAbi === 'string' &&
            /^\d{1,8}$/.test(runtime.nodeAbi) &&
            typeof runtime.napi === 'string' &&
            /^\d{1,8}$/.test(runtime.napi) &&
            typeof runtime.chromiumVersion === 'string' &&
            /^\d+\.\d+\.\d+\.\d+$/.test(runtime.chromiumVersion) &&
            runtime.hostProtocol === 1
        )) &&
      archive &&
      exactKeys(archive, ['bytes', 'sha256', 'url', 'releaseAssetId']) &&
      Number.isSafeInteger(archive.bytes) &&
      (archive.bytes as number) > 0 &&
      (archive.bytes as number) <= MAX_TOTAL_PAYLOAD_BYTES &&
      typeof archive.sha256 === 'string' &&
      SHA256.test(archive.sha256) &&
      productionArchiveUrl(archive.url) &&
      Number.isSafeInteger(archive.releaseAssetId) &&
      (archive.releaseAssetId as number) > 0 &&
      inventory &&
      exactKeys(inventory, ['bytes', 'sha256', 'url', 'releaseAssetId']) &&
      Number.isSafeInteger(inventory.bytes) &&
      (inventory.bytes as number) > 0 &&
      (inventory.bytes as number) <= MAX_INVENTORY_BYTES &&
      typeof inventory.sha256 === 'string' &&
      SHA256.test(inventory.sha256) &&
      productionArchiveUrl(inventory.url) &&
      Number.isSafeInteger(inventory.releaseAssetId) &&
      (inventory.releaseAssetId as number) > 0 &&
      bundle &&
      exactKeys(bundle, ['bytes', 'sha256', 'url', 'releaseAssetId']) &&
      Number.isSafeInteger(bundle.bytes) &&
      (bundle.bytes as number) > 0 &&
      (bundle.bytes as number) <= MAX_BUNDLE_BYTES &&
      typeof bundle.sha256 === 'string' &&
      SHA256.test(bundle.sha256) &&
      productionArchiveUrl(bundle.url) &&
      Number.isSafeInteger(bundle.releaseAssetId) &&
      (bundle.releaseAssetId as number) > 0 &&
      entrypoints &&
      Object.keys(entrypoints).every((role) => roles.includes(role) && safePath(entrypoints[role])) &&
      directories &&
      Object.keys(directories).every((id) => id === 'whisper-ort-wasm') &&
      (row.kind === 'runtime'
        ? (entrypoints?.['whisper-renderer-worker'] !== undefined) ===
            (directories['whisper-ort-wasm'] !== undefined) && Object.keys(directories).length <= 1
        : Object.keys(directories).length === 0) &&
      Object.entries(directories).every(([id, raw]) => {
        const directory = record(raw)
        return Boolean(
          id === 'whisper-ort-wasm' &&
            directory &&
            exactKeys(directory, ['root', 'members']) &&
            safePath(directory.root) &&
            Array.isArray(directory.members) &&
            directory.members.length > 0 &&
            directory.members.every((member) => safePath(member) && member.startsWith(`${directory.root}/`))
        )
      }) &&
      modelRowsValid &&
      signer &&
      exactKeys(signer, [
        'issuer',
        'repositoryUri',
        'repositoryId',
        'workflowPath',
        'ref',
        'sourceCommit',
        'workflowCommit',
        'predicateType',
        'runnerEnvironment'
      ]) &&
      signer.issuer === 'https://token.actions.githubusercontent.com' &&
      signer.repositoryUri === SOURCE_REPOSITORY &&
      signer.repositoryId === SOURCE_REPOSITORY_ID &&
      typeof signer.workflowPath === 'string' &&
      /^\.github\/workflows\/[a-z0-9-]+\.yml$/.test(signer.workflowPath) &&
      signer.ref === 'refs/heads/main' &&
      typeof signer.sourceCommit === 'string' &&
      COMMIT.test(signer.sourceCommit) &&
      typeof signer.workflowCommit === 'string' &&
      COMMIT.test(signer.workflowCommit) &&
      signer.predicateType === 'https://slsa.dev/provenance/v1' &&
      signer.runnerEnvironment === 'github-hosted'
  )
}

/** Parse only the closed application-owned catalog shape. Candidate files cannot define trust policy. */
export function parseRuntimeCatalog(bytes: Uint8Array): RuntimeCatalogV1 {
  const parsed = record(boundedUtf8Json(bytes, MAX_INVENTORY_BYTES, 'RUNTIME_CATALOG_INVALID'))
  if (
    !parsed ||
    !exactKeys(parsed, ['schemaVersion', 'protocolVersion', 'catalogId', 'trustRoot', 'targets']) ||
    parsed.schemaVersion !== 1 ||
    parsed.protocolVersion !== 1 ||
    parsed.catalogId !== 'metis-runtime-catalog-v1' ||
    !Array.isArray(parsed.targets) ||
    parsed.targets.length > 64
  ) {
    throw new Error('RUNTIME_CATALOG_INVALID')
  }
  let trustRoot: RuntimeCatalogV1['trustRoot'] = null
  if (parsed.trustRoot !== null) {
    const root = record(parsed.trustRoot)
    const receipt = root && record(root.receipt)
    if (
      !root ||
      !exactKeys(root, ['path', 'bytes', 'sha256', 'source', 'receipt']) ||
      root.path !== 'runtime-trust/sigstore-trusted-root.json' ||
      !Number.isSafeInteger(root.bytes) ||
      (root.bytes as number) < 1 ||
      (root.bytes as number) > MAX_TRUST_ROOT_BYTES ||
      typeof root.sha256 !== 'string' ||
      !SHA256.test(root.sha256) ||
      root.source !== 'https://tuf-repo-cdn.sigstore.dev/targets/trusted_root.json' ||
      !receipt ||
      !exactKeys(receipt, ['path', 'bytes', 'sha256']) ||
      receipt.path !== 'runtime-trust/acquisition-receipt.json' ||
      !Number.isSafeInteger(receipt.bytes) ||
      (receipt.bytes as number) < 1 ||
      (receipt.bytes as number) > 64 * 1024 ||
      typeof receipt.sha256 !== 'string' ||
      !SHA256.test(receipt.sha256)
    ) {
      throw new Error('RUNTIME_TRUST_ROOT_UNAVAILABLE')
    }
    trustRoot = freezeJson(root) as RuntimeCatalogV1['trustRoot']
  }
  const seen = new Set<string>()
  const artifactIds = new Set<string>()
  for (const row of parsed.targets) {
    if (!isCatalogRow(row)) throw new Error('RUNTIME_CATALOG_ROW_INVALID')
    const key = `${row.componentId}:${row.target.platform}:${row.target.arch}`
    if (seen.has(key) || artifactIds.has(row.artifactId)) throw new Error('RUNTIME_CATALOG_DUPLICATE_TARGET')
    seen.add(key)
    artifactIds.add(row.artifactId)
  }
  return Object.freeze({
    schemaVersion: 1,
    protocolVersion: 1,
    catalogId: parsed.catalogId,
    trustRoot,
    targets: Object.freeze((parsed.targets as RuntimeCatalogRow[]).map(freezeJson))
  })
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function derUtf8StringClaim(value: unknown): string | null {
  if (!(value instanceof Uint8Array) || value.byteLength < 2 || value[0] !== 0x0c) return null
  const firstLength = value[1]
  let headerBytes = 2
  let contentBytes = firstLength
  if (firstLength >= 0x80) {
    const lengthBytes = firstLength & 0x7f
    if (lengthBytes === 0 || lengthBytes > 4 || value.byteLength < 2 + lengthBytes || value[2] === 0) return null
    contentBytes = 0
    for (let index = 0; index < lengthBytes; index += 1) {
      contentBytes = contentBytes * 256 + value[2 + index]
    }
    if (contentBytes < 0x80) return null
    headerBytes += lengthBytes
  }
  if (contentBytes < 1 || headerBytes + contentBytes !== value.byteLength) return null
  try {
    // Preserve an encoded BOM as claim data; TextDecoder's default strips it, which would
    // make a non-canonical certificate value compare equal to the app-owned identity pin.
    const result = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value.subarray(headerBytes))
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
  const extensions = identity && record(identity.extensions)
  if (
    !identity ||
    !extensions ||
    extensions.issuer !== row.signer.issuer ||
    identity.subjectAlternativeName !== expectedSignerUri(row) ||
    !Array.isArray(identity.oids)
  ) {
    throw new Error('RUNTIME_CERTIFICATE_IDENTITY_UNSUPPORTED')
  }
  const claims = new Map<string, string>()
  const required = new Set<string>(Object.values(OID))
  for (const raw of identity.oids) {
    const extension = record(raw)
    const oid = extension && record(extension.oid)
    if (
      !extension ||
      !oid ||
      !Array.isArray(oid.id) ||
      !oid.id.every((part) => Number.isInteger(part) && part >= 0 && part <= 4_294_967_295)
    ) {
      throw new Error('RUNTIME_CERTIFICATE_EXTENSION_UNSUPPORTED')
    }
    const id = oid.id.join('.')
    if (!required.has(id)) continue
    const value = derUtf8StringClaim(extension.value)
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
  for (const [oid, value] of expected)
    if (claims.get(oid) !== value) throw new Error('RUNTIME_CERTIFICATE_CLAIM_MISMATCH')
  if (claims.size !== expected.size) throw new Error('RUNTIME_CERTIFICATE_CLAIM_MISMATCH')
}

function assertStatement(statement: unknown, row: RuntimeCatalogRow, archiveHash: string, inventoryHash: string): void {
  const recordValue = record(statement)
  if (
    !recordValue ||
    !exactKeys(recordValue, ['_type', 'subject', 'predicateType', 'predicate']) ||
    recordValue._type !== 'https://in-toto.io/Statement/v1' ||
    recordValue.predicateType !== row.signer.predicateType ||
    !Array.isArray(recordValue.subject) ||
    recordValue.subject.length !== 2 ||
    !record(recordValue.predicate)
  ) {
    throw new Error('RUNTIME_ATTESTATION_FORMAT_UNSUPPORTED')
  }
  const subjects = new Map<string, string>()
  for (const raw of recordValue.subject) {
    const subject = record(raw)
    const digest = subject && record(subject.digest)
    if (
      !subject ||
      !exactKeys(subject, ['name', 'digest']) ||
      typeof subject.name !== 'string' ||
      subject.name.length < 1 ||
      subject.name.length > 512 ||
      !safePath(subject.name) ||
      !digest ||
      !exactKeys(digest, ['sha256']) ||
      typeof digest.sha256 !== 'string' ||
      !SHA256.test(digest.sha256) ||
      subjects.has(subject.name)
    ) {
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
  const { row, trustRootPin, bundleBytes, archivePath, inventoryBytes, trustedRootJson, trustedRootReceiptJson } = input
  if (!isCatalogRow(row)) throw new Error('RUNTIME_CATALOG_ROW_INVALID')
  if (!trustRootPin) throw new Error('RUNTIME_TRUST_ROOT_UNAVAILABLE')
  const trustedRoot = verifyPinnedRuntimeTrust(trustRootPin, trustedRootJson, trustedRootReceiptJson)
  if (
    bundleBytes.byteLength !== row.bundle.bytes ||
    bundleBytes.byteLength > MAX_BUNDLE_BYTES ||
    sha256(bundleBytes) !== row.bundle.sha256
  ) {
    throw new Error('RUNTIME_BUNDLE_PIN_MISMATCH')
  }
  if (
    inventoryBytes.byteLength !== row.inventory.bytes ||
    inventoryBytes.byteLength > MAX_INVENTORY_BYTES ||
    sha256(inventoryBytes) !== row.inventory.sha256
  ) {
    throw new Error('RUNTIME_INVENTORY_PIN_MISMATCH')
  }
  const archiveHash = await hashPinnedArchive(archivePath, row.archive.bytes)
  if (archiveHash !== row.archive.sha256) throw new Error('RUNTIME_ARCHIVE_PIN_MISMATCH')
  const inventoryHash = sha256(inventoryBytes)
  const inventory = parseRuntimeInventory(
    boundedUtf8Json(inventoryBytes, MAX_INVENTORY_BYTES, 'RUNTIME_INVENTORY_INVALID'),
    row
  )
  const bundleJson = boundedUtf8Json(bundleBytes, MAX_BUNDLE_BYTES, 'RUNTIME_BUNDLE_INVALID')
  let bundle: Bundle
  try {
    bundle = bundleFromJSON(bundleJson)
  } catch {
    throw new Error('RUNTIME_BUNDLE_INVALID')
  }
  const content = record(bundle.content)
  const envelope = content?.$case === 'dsseEnvelope' ? record(content.dsseEnvelope) : null
  const payload = envelope?.payload
  if (
    !envelope ||
    !(payload instanceof Uint8Array) ||
    payload.byteLength === 0 ||
    payload.byteLength > MAX_BUNDLE_BYTES
  ) {
    throw new Error('RUNTIME_ATTESTATION_FORMAT_UNSUPPORTED')
  }
  const rootProto = TrustedRoot.fromJSON(trustedRoot)
  const trustMaterial = toTrustMaterial(rootProto)
  // Explicit values preserve the maintained library's production thresholds rather than relaxing them.
  const verifier = new Verifier(trustMaterial, { tlogThreshold: 1, ctlogThreshold: 1, timestampThreshold: 1 })
  let authenticatedSigner: unknown
  try {
    const entity = toSignedEntity(bundle)
    authenticatedSigner = await verifier.verify(entity)
  } catch {
    throw new Error('RUNTIME_SIGNATURE_OR_TRANSPARENCY_INVALID')
  }
  assertAuthenticatedIdentity(authenticatedSigner, row)
  let statement: unknown
  try {
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
