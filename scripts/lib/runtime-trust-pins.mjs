import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT_PIN = Object.freeze({
  path: 'runtime-trust/sigstore-trusted-root.json',
  bytes: 6787,
  sha256: '6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66',
  source: 'https://tuf-repo-cdn.sigstore.dev/targets/trusted_root.json'
})
const RECEIPT_PIN = Object.freeze({
  path: 'runtime-trust/acquisition-receipt.json',
  bytes: 663,
  sha256: '1ad8c2f7d308b9c2a76cbbc48c8880c338a8f89f44f9ce7427ecf99acc6ec456'
})
const ROOT_LIMIT = ROOT_PIN.bytes
const RECEIPT_LIMIT = RECEIPT_PIN.bytes
const CATALOG_LIMIT = 16 * 1024

/** @param {string} code @returns {never} */
function fail(code) {
  throw new Error(code)
}

/** @param {string} root @param {string} relativePath @param {number} maxBytes @param {string} code @returns {Promise<Buffer>} */
async function readPinnedRegularFile(root, relativePath, maxBytes, code) {
  const path = join(root, ...relativePath.split('/'))
  let before
  try {
    const rootStat = await lstat(root, { bigint: true })
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(code)
    const parent = relativePath.split('/').slice(0, -1).join('/')
    if (parent) {
      const parentStat = await lstat(join(root, ...parent.split('/')), { bigint: true })
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail(code)
    }
    before = await lstat(path, { bigint: true })
  } catch {
    fail(code)
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)) fail(code)

  const noFollow = fsConstants.O_NOFOLLOW ?? 0
  const nonBlock = fsConstants.O_NONBLOCK ?? 0
  let handle
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollow | nonBlock)
    const opened = await handle.stat({ bigint: true })
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.nlink !== before.nlink
    ) {
      fail(code)
    }
    const buffer = Buffer.alloc(maxBytes + 1)
    let bytesRead = 0
    while (bytesRead < buffer.byteLength) {
      const result = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, null)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    const after = await handle.stat({ bigint: true })
    if (
      bytesRead > maxBytes ||
      bytesRead !== Number(before.size) ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.nlink !== opened.nlink
    ) {
      fail(code)
    }
    return buffer.subarray(0, bytesRead)
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error
    fail(code)
  } finally {
    await handle?.close()
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  )
}

function parseJson(bytes, code) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    fail(code)
  }
}

/** Enforce the reviewed app-owned trust snapshot and receipt in either packaging profile. */
/** @returns {Promise<{ catalog: { schemaVersion: number, protocolVersion: number, catalogId: string, trustRoot: Record<string, unknown>, targets: unknown[] }, rootBytes: Buffer, receiptBytes: Buffer }>} */
export async function assertRuntimeTrustPins(resourcesRoot) {
  const catalogBytes = await readPinnedRegularFile(
    resourcesRoot,
    'runtime-catalog.json',
    CATALOG_LIMIT,
    'RUNTIME_CATALOG_INVALID'
  )
  const catalog = parseJson(catalogBytes, 'RUNTIME_CATALOG_INVALID')
  if (
    !exactKeys(catalog, ['schemaVersion', 'protocolVersion', 'catalogId', 'trustRoot', 'targets']) ||
    catalog.schemaVersion !== 1 ||
    catalog.protocolVersion !== 1 ||
    catalog.catalogId !== 'metis-runtime-catalog-v1' ||
    !Array.isArray(catalog.targets) ||
    catalog.targets.length !== 0 ||
    !exactKeys(catalog.trustRoot, ['path', 'bytes', 'sha256', 'source', 'receipt']) ||
    catalog.trustRoot.path !== ROOT_PIN.path ||
    catalog.trustRoot.bytes !== ROOT_PIN.bytes ||
    catalog.trustRoot.sha256 !== ROOT_PIN.sha256 ||
    catalog.trustRoot.source !== ROOT_PIN.source ||
    !exactKeys(catalog.trustRoot.receipt, ['path', 'bytes', 'sha256']) ||
    catalog.trustRoot.receipt.path !== RECEIPT_PIN.path ||
    catalog.trustRoot.receipt.bytes !== RECEIPT_PIN.bytes ||
    catalog.trustRoot.receipt.sha256 !== RECEIPT_PIN.sha256
  ) {
    fail('RUNTIME_CATALOG_INVALID')
  }

  const rootBytes = await readPinnedRegularFile(
    resourcesRoot,
    ROOT_PIN.path,
    ROOT_LIMIT,
    'RUNTIME_TRUST_ROOT_PIN_MISMATCH'
  )
  if (rootBytes.byteLength !== ROOT_PIN.bytes || sha256(rootBytes) !== ROOT_PIN.sha256) {
    fail('RUNTIME_TRUST_ROOT_PIN_MISMATCH')
  }
  const receiptBytes = await readPinnedRegularFile(
    resourcesRoot,
    RECEIPT_PIN.path,
    RECEIPT_LIMIT,
    'RUNTIME_TRUST_RECEIPT_PIN_MISMATCH'
  )
  if (receiptBytes.byteLength !== RECEIPT_PIN.bytes || sha256(receiptBytes) !== RECEIPT_PIN.sha256) {
    fail('RUNTIME_TRUST_RECEIPT_PIN_MISMATCH')
  }
  return Object.freeze({
    catalog: /** @type {typeof catalog & { targets: unknown[] }} */ (catalog),
    rootBytes,
    receiptBytes
  })
}
