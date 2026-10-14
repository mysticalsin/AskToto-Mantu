#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { bundleFromJSON } from '@sigstore/bundle'
import { TrustedRoot } from '@sigstore/protobuf-specs'
import { toSignedEntity, toTrustMaterial, Verifier } from '@sigstore/verify'

const SOURCE_SHA = 'a78de2590a05c09ecc5198009c3509085a4f5053'
const SOURCE_REF = 'refs/heads/m2/M2-0475-runtime-artifact-publisher'
const WORKFLOW_PATH = '.github/workflows/runtime-llama-candidate.yml'
const RUN_ID = '38594471312'
const RUN_ATTEMPT = 1
const REPOSITORY_URI = 'https://github.com/mysticalsin/AskToto-Mantu'
const REPOSITORY_ID = '1282463398'
const OID = {
  issuer: '1.3.6.1.4.1.57264.1.8',
  signerUri: '1.3.6.1.4.1.57264.1.9',
  signerDigest: '1.3.6.1.4.1.57264.1.10',
  runnerEnvironment: '1.3.6.1.4.1.57264.1.11',
  repositoryUri: '1.3.6.1.4.1.57264.1.12',
  sourceDigest: '1.3.6.1.4.1.57264.1.13',
  sourceRef: '1.3.6.1.4.1.57264.1.14',
  repositoryId: '1.3.6.1.4.1.57264.1.15'
}
const TARGETS = Object.freeze([
  { platform: 'darwin', arch: 'arm64', suffix: 'darwin-arm64' },
  { platform: 'darwin', arch: 'x64', suffix: 'darwin-x64' },
  { platform: 'win32', arch: 'x64', suffix: 'win32-x64' }
])

function fail(code) {
  throw new Error(code)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function parseJson(bytes, code) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    fail(code)
  }
}

async function assertDirectory(path, code) {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) fail(code)
}

async function assertExactEntries(path, expected, directories, code) {
  const entries = await readdir(path, { withFileTypes: true })
  const names = entries.map((entry) => entry.name).sort()
  if (names.join('\0') !== [...expected].sort().join('\0')) fail(code)
  for (const entry of entries) {
    if (directories ? !entry.isDirectory() || entry.isSymbolicLink() : !entry.isFile() || entry.isSymbolicLink())
      fail(code)
  }
}

function exactKeys(value, keys) {
  return Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

function decodeClaim(value) {
  if (!(value instanceof Uint8Array)) return null
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(value)
    return decoded.length > 0 && !/[\u0000-\u001f\u007f]/.test(decoded) ? decoded : null
  } catch {
    return null
  }
}

async function readStable(path, maxBytes, code) {
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maxBytes)) fail(code)
  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await open(path, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.nlink !== 1n
    )
      fail(code)
    const chunks = []
    let total = 0
    let position = 0
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total))
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maxBytes) fail(code)
      chunks.push(chunk.subarray(0, bytesRead))
      position += bytesRead
    }
    const bytes = Buffer.concat(chunks, total)
    const after = await handle.stat({ bigint: true })
    const pathAfter = await lstat(path, { bigint: true })
    if (
      bytes.length !== Number(opened.size) ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino ||
      pathAfter.size !== opened.size ||
      pathAfter.nlink !== 1n
    )
      fail(code)
    return bytes
  } finally {
    await handle.close()
  }
}

async function hashStableFile(path, maxBytes, code) {
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maxBytes)) fail(code)
  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await open(path, constants.O_RDONLY | noFollow | (constants.O_NONBLOCK ?? 0))
  try {
    const opened = await handle.stat({ bigint: true })
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.nlink !== 1n
    )
      fail(code)
    const hash = createHash('sha256')
    let total = 0
    let position = 0
    while (true) {
      const buffer = Buffer.allocUnsafe(1024 * 1024)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      total += bytesRead
      if (total > maxBytes || total > Number(opened.size)) fail(code)
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const pathAfter = await lstat(path, { bigint: true })
    if (
      total !== Number(opened.size) ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino ||
      pathAfter.size !== opened.size ||
      pathAfter.nlink !== 1n
    )
      fail(code)
    return { bytes: total, sha256: hash.digest('hex') }
  } finally {
    await handle.close()
  }
}

function verifyRootPin(catalog, rootBytes, receiptBytes) {
  const pin = record(catalog.trustRoot)
  const receiptPin = pin && record(pin.receipt)
  if (
    !pin ||
    !receiptPin ||
    !exactKeys(pin, ['path', 'bytes', 'sha256', 'source', 'receipt']) ||
    !exactKeys(receiptPin, ['path', 'bytes', 'sha256']) ||
    pin.path !== 'runtime-trust/sigstore-trusted-root.json' ||
    pin.source !== 'https://tuf-repo-cdn.sigstore.dev/targets/trusted_root.json' ||
    receiptPin.path !== 'runtime-trust/acquisition-receipt.json' ||
    rootBytes.length !== pin.bytes ||
    sha256(rootBytes) !== pin.sha256 ||
    receiptBytes.length !== receiptPin.bytes ||
    sha256(receiptBytes) !== receiptPin.sha256
  )
    fail('RUNTIME_READBACK_TRUST_PIN_INVALID')
  const receipt = record(parseJson(receiptBytes, 'RUNTIME_READBACK_TRUST_RECEIPT_INVALID'))
  const verifiedBy = receipt && record(receipt.verifiedBy)
  if (
    !receipt ||
    !verifiedBy ||
    receipt.schemaVersion !== 1 ||
    receipt.source !== pin.source ||
    verifiedBy.package !== '@sigstore/tuf' ||
    verifiedBy.version !== '5.0.0' ||
    receipt.rootBytes !== pin.bytes ||
    receipt.rootSha256 !== pin.sha256
  )
    fail('RUNTIME_READBACK_TRUST_RECEIPT_INVALID')
  try {
    return TrustedRoot.fromJSON(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rootBytes)))
  } catch {
    fail('RUNTIME_READBACK_TRUST_ROOT_INVALID')
  }
}

function verifySigner(signer, inventory) {
  const identity = record(record(signer)?.identity)
  const expectedSignerUri = `${REPOSITORY_URI}/${WORKFLOW_PATH}@${SOURCE_REF}`
  if (
    !identity ||
    identity.issuer !== 'https://token.actions.githubusercontent.com' ||
    identity.subjectAlternativeName !== expectedSignerUri ||
    !Array.isArray(identity.oids)
  )
    fail('RUNTIME_READBACK_CERTIFICATE_IDENTITY_INVALID')
  const claims = new Map()
  for (const raw of identity.oids) {
    const extension = record(raw)
    const oid = extension && record(extension.oid)
    if (!extension || !oid || !Array.isArray(oid.id) || !oid.id.every(Number.isInteger))
      fail('RUNTIME_READBACK_CERTIFICATE_CLAIM_INVALID')
    const id = oid.id.join('.')
    const value = decodeClaim(extension.value)
    if (!value || claims.has(id)) fail('RUNTIME_READBACK_CERTIFICATE_CLAIM_INVALID')
    claims.set(id, value)
  }
  const expected = new Map([
    [OID.issuer, 'https://token.actions.githubusercontent.com'],
    [OID.signerUri, expectedSignerUri],
    [OID.signerDigest, inventory.source.workflowCommit],
    [OID.runnerEnvironment, 'github-hosted'],
    [OID.repositoryUri, REPOSITORY_URI],
    [OID.sourceDigest, SOURCE_SHA],
    [OID.sourceRef, SOURCE_REF],
    [OID.repositoryId, REPOSITORY_ID]
  ])
  for (const [oid, value] of expected)
    if (claims.get(oid) !== value) fail('RUNTIME_READBACK_CERTIFICATE_CLAIM_MISMATCH')
}

function verifyStatement(bundle, archiveName, archiveHash, inventoryName, inventoryHash) {
  const envelope = record(record(bundle)?.dsseEnvelope)
  if (!envelope || typeof envelope.payload !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload))
    fail('RUNTIME_READBACK_ATTESTATION_FORMAT_INVALID')
  let statement
  try {
    const payload = Buffer.from(envelope.payload, 'base64')
    if (payload.toString('base64') !== envelope.payload || payload.length < 1 || payload.length > 20_000_000)
      fail('RUNTIME_READBACK_ATTESTATION_FORMAT_INVALID')
    statement = record(parseJson(payload, 'RUNTIME_READBACK_ATTESTATION_FORMAT_INVALID'))
  } catch {
    fail('RUNTIME_READBACK_ATTESTATION_FORMAT_INVALID')
  }
  if (
    !statement ||
    !exactKeys(statement, ['_type', 'subject', 'predicateType', 'predicate']) ||
    statement._type !== 'https://in-toto.io/Statement/v1' ||
    statement.predicateType !== 'https://slsa.dev/provenance/v1' ||
    !record(statement.predicate) ||
    !Array.isArray(statement.subject) ||
    statement.subject.length !== 2
  )
    fail('RUNTIME_READBACK_ATTESTATION_FORMAT_INVALID')
  const subjects = new Map()
  for (const raw of statement.subject) {
    const subject = record(raw)
    const digest = subject && record(subject.digest)
    if (
      !subject ||
      !digest ||
      !exactKeys(subject, ['name', 'digest']) ||
      !exactKeys(digest, ['sha256']) ||
      typeof subject.name !== 'string' ||
      !/^[A-Za-z0-9._-]+$/.test(subject.name) ||
      typeof digest.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(digest.sha256) ||
      subjects.has(subject.name)
    )
      fail('RUNTIME_READBACK_ATTESTATION_SUBJECT_INVALID')
    subjects.set(subject.name, digest.sha256)
  }
  if (subjects.size !== 2 || subjects.get(archiveName) !== archiveHash || subjects.get(inventoryName) !== inventoryHash)
    fail('RUNTIME_READBACK_ATTESTATION_SUBJECT_MISMATCH')
}

async function verifyTarget(root, target, rootProto) {
  const directory = `runtime-llama-${target.suffix}-${SOURCE_SHA}-${RUN_ATTEMPT}`
  const base = resolve(root, directory)
  await assertDirectory(root, 'RUNTIME_READBACK_ARTIFACT_LAYOUT_INVALID')
  await assertDirectory(base, 'RUNTIME_READBACK_ARTIFACT_LAYOUT_INVALID')
  const archiveName = `runtime.llama-server-${target.suffix}.tar.gz`
  const inventoryName = `runtime.llama-server-${target.suffix}.inventory.json`
  const bundleName = `runtime.llama-server-${target.suffix}.sigstore.bundle.json`
  await assertExactEntries(
    base,
    ['candidate.json', 'runtime-inference.json', archiveName, inventoryName, bundleName],
    false,
    'RUNTIME_READBACK_ARTIFACT_LAYOUT_INVALID'
  )
  const candidateBytes = await readStable(
    resolve(base, 'candidate.json'),
    2_000_000,
    'RUNTIME_READBACK_CANDIDATE_INVALID'
  )
  const inferenceBytes = await readStable(
    resolve(base, 'runtime-inference.json'),
    2_000_000,
    'RUNTIME_READBACK_INFERENCE_INVALID'
  )
  const candidate = record(parseJson(candidateBytes, 'RUNTIME_READBACK_CANDIDATE_INVALID'))
  const inventoryBytes = await readStable(
    resolve(base, inventoryName),
    20_000_000,
    'RUNTIME_READBACK_INVENTORY_INVALID'
  )
  const inventory = record(parseJson(inventoryBytes, 'RUNTIME_READBACK_INVENTORY_INVALID'))
  const inference = record(parseJson(inferenceBytes, 'RUNTIME_READBACK_INFERENCE_INVALID'))
  if (
    !candidate ||
    !inventory ||
    !inference ||
    !exactKeys(candidate, [
      'schemaVersion',
      'kind',
      'componentId',
      'artifactId',
      'target',
      'runtime',
      'archive',
      'inventory',
      'payloadFiles',
      'payloadBytes'
    ]) ||
    candidate.schemaVersion !== 1 ||
    candidate.kind !== 'runtime' ||
    candidate.componentId !== 'runtime.llama-server' ||
    candidate.artifactId !== `runtime.llama-server-${target.suffix}` ||
    candidate.target?.platform !== target.platform ||
    candidate.target?.arch !== target.arch ||
    candidate.archive?.path !== archiveName ||
    candidate.inventory?.path !== inventoryName ||
    inference.inferencePassed !== true ||
    inference.cpuOnly !== true ||
    inference.modelIncludedInArchive !== false ||
    inference.licenseCoverageComplete !== false ||
    !Number.isSafeInteger(inference.nativeFilesVerified) ||
    inference.nativeFilesVerified < 1
  )
    fail('RUNTIME_READBACK_CANDIDATE_SHAPE_INVALID')
  const source = record(inventory.source)
  const inventoryTarget = record(inventory.target)
  const expectedInventoryKeys = [
    'schemaVersion',
    'kind',
    'componentId',
    'artifactId',
    'target',
    'runtime',
    'entrypoints',
    'models',
    'source',
    'builder',
    'upstream',
    'files',
    'licenses'
  ]
  const filePaths = new Set()
  const foldedFilePaths = new Set()
  let inventoryFileBytes = 0
  let priorPath = ''
  const validFiles =
    Array.isArray(inventory.files) &&
    inventory.files.every((raw) => {
      const file = record(raw)
      if (
        !file ||
        !exactKeys(file, ['path', 'bytes', 'sha256', 'executable']) ||
        typeof file.path !== 'string' ||
        !/^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/.test(file.path) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 1 ||
        typeof file.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        typeof file.executable !== 'boolean' ||
        file.path <= priorPath ||
        filePaths.has(file.path) ||
        foldedFilePaths.has(file.path.toLowerCase())
      )
        return false
      priorPath = file.path
      filePaths.add(file.path)
      foldedFilePaths.add(file.path.toLowerCase())
      inventoryFileBytes += file.bytes
      return Number.isSafeInteger(inventoryFileBytes)
    })
  if (
    !exactKeys(inventory, expectedInventoryKeys) ||
    inventory.schemaVersion !== 1 ||
    inventory.kind !== 'runtime' ||
    inventory.componentId !== candidate.componentId ||
    inventory.artifactId !== candidate.artifactId ||
    inventoryTarget?.platform !== target.platform ||
    inventoryTarget?.arch !== target.arch ||
    !source ||
    source.repositoryUri !== REPOSITORY_URI ||
    source.commit !== SOURCE_SHA ||
    source.ref !== SOURCE_REF ||
    source.workflowPath !== WORKFLOW_PATH ||
    source.workflowCommit !== SOURCE_SHA ||
    source.runId !== RUN_ID ||
    source.attempt !== RUN_ATTEMPT ||
    source.runnerEnvironment !== 'github-hosted' ||
    !validFiles ||
    inventory.files.length !== candidate.payloadFiles ||
    inventoryFileBytes !== candidate.payloadBytes ||
    !exactKeys(inventory.entrypoints, ['llama-server']) ||
    inventory.entrypoints['llama-server'] !==
      (target.platform === 'win32' ? 'runtime/llama-server.exe' : 'runtime/llama-server') ||
    !Array.isArray(inventory.models) ||
    inventory.models.length !== 0 ||
    JSON.stringify(inventory.runtime) !== JSON.stringify(candidate.runtime) ||
    !exactKeys(source, [
      'repositoryUri',
      'commit',
      'workflowPath',
      'workflowCommit',
      'runId',
      'attempt',
      'lockSha256',
      'ref',
      'runnerEnvironment'
    ])
  )
    fail('RUNTIME_READBACK_INVENTORY_IDENTITY_INVALID')
  const archive = await hashStableFile(resolve(base, archiveName), 10_000_000_000, 'RUNTIME_READBACK_ARCHIVE_INVALID')
  if (
    archive.bytes !== candidate.archive.bytes ||
    archive.sha256 !== candidate.archive.sha256 ||
    inventoryBytes.length !== candidate.inventory.bytes ||
    sha256(inventoryBytes) !== candidate.inventory.sha256
  )
    fail('RUNTIME_READBACK_SUBJECT_BYTES_MISMATCH')
  const bundleBytes = await readStable(resolve(base, bundleName), 20_000_000, 'RUNTIME_READBACK_BUNDLE_INVALID')
  const bundleJson = parseJson(bundleBytes, 'RUNTIME_READBACK_BUNDLE_INVALID')
  let bundle
  try {
    bundle = bundleFromJSON(bundleJson)
    const verifier = new Verifier(toTrustMaterial(rootProto), {
      tlogThreshold: 1,
      ctlogThreshold: 1,
      timestampThreshold: 1
    })
    const signer = await verifier.verify(toSignedEntity(bundle))
    verifySigner(signer, inventory)
  } catch {
    fail('RUNTIME_READBACK_SIGSTORE_VERIFICATION_FAILED')
  }
  verifyStatement(bundle, archiveName, archive.sha256, inventoryName, sha256(inventoryBytes))
  return {
    target: target.suffix,
    archiveBytes: archive.bytes,
    archiveSha256: archive.sha256,
    inventoryBytes: inventoryBytes.length,
    inventorySha256: sha256(inventoryBytes),
    bundleBytes: bundleBytes.length,
    bundleSha256: sha256(bundleBytes)
  }
}

async function main() {
  const readbackPath = process.env.RUNTIME_CANDIDATE_READBACK
  const runnerTemp = process.env.RUNNER_TEMP
  if (!readbackPath || !runnerTemp || !isAbsolute(readbackPath) || !isAbsolute(runnerTemp))
    fail('RUNTIME_READBACK_INPUT_PATH_INVALID')
  const root = resolve(readbackPath)
  const relativeRoot = relative(resolve(runnerTemp), root)
  if (!relativeRoot || relativeRoot === '..' || relativeRoot.startsWith(`..${sep}`) || isAbsolute(relativeRoot))
    fail('RUNTIME_READBACK_INPUT_PATH_INVALID')
  await assertDirectory(root, 'RUNTIME_READBACK_ARTIFACT_LAYOUT_INVALID')
  await assertExactEntries(
    root,
    TARGETS.map((target) => `runtime-llama-${target.suffix}-${SOURCE_SHA}-${RUN_ATTEMPT}`),
    true,
    'RUNTIME_READBACK_ARTIFACT_LAYOUT_INVALID'
  )
  const catalogBytes = await readStable(
    resolve('resources/runtime-catalog.json'),
    2_000_000,
    'RUNTIME_READBACK_CATALOG_INVALID'
  )
  const catalog = record(parseJson(catalogBytes, 'RUNTIME_READBACK_CATALOG_INVALID'))
  if (
    !catalog ||
    catalog.schemaVersion !== 1 ||
    catalog.protocolVersion !== 1 ||
    catalog.catalogId !== 'metis-runtime-catalog-v1' ||
    !Array.isArray(catalog.targets) ||
    catalog.targets.length !== 0
  )
    fail('RUNTIME_READBACK_CATALOG_NOT_EMPTY')
  const trustRootBytes = await readStable(
    resolve('resources/runtime-trust/sigstore-trusted-root.json'),
    2_000_000,
    'RUNTIME_READBACK_TRUST_ROOT_INVALID'
  )
  const receiptBytes = await readStable(
    resolve('resources/runtime-trust/acquisition-receipt.json'),
    64_000,
    'RUNTIME_READBACK_TRUST_RECEIPT_INVALID'
  )
  const rootProto = verifyRootPin(catalog, trustRootBytes, receiptBytes)
  const results = []
  for (const target of TARGETS) results.push(await verifyTarget(root, target, rootProto))
  const archiveBytes = results.reduce((total, result) => total + result.archiveBytes, 0)
  const inventoryBytes = results.reduce((total, result) => total + result.inventoryBytes, 0)
  const bundleBytes = results.reduce((total, result) => total + result.bundleBytes, 0)
  const subjectSha256 = sha256(
    Buffer.from(results.flatMap((result) => [result.archiveSha256, result.inventorySha256]).join(''))
  )
  process.stdout.write(
    `RUNTIME_ATTESTATION_READBACK_OK verified=true targets=${results.length} subjects=${results.length * 2} archiveBytes=${archiveBytes} inventoryBytes=${inventoryBytes} bundleBytes=${bundleBytes} trustRootSha256=${sha256(trustRootBytes)} subjectSetSha256=${subjectSha256}\n`
  )
}

main().catch((error) => {
  const message = record(error)?.message
  const code = typeof message === 'string' && /^[A-Z0-9_]+$/.test(message) ? message : 'RUNTIME_READBACK_FAILED'
  process.stderr.write(`${code}\n`)
  process.exitCode = 1
})
