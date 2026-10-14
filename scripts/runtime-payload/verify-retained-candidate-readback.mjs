#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { bundleFromJSON, bundleToJSON } from '@sigstore/bundle'
import { TrustedRoot } from '@sigstore/protobuf-specs'
import { toSignedEntity, toTrustMaterial, Verifier } from '@sigstore/verify'
import {
  MODEL,
  MODEL_FILES,
  MODEL_PAYLOAD_BYTES,
  NATIVE_TARGETS,
  REPOSITORY_ID,
  REPOSITORY_URI,
  RUN_ATTEMPT,
  RUN_ID,
  SOURCE_REF,
  SOURCE_SHA,
  WORKFLOW_PATH,
  parseStrictJsonBytes,
  validBuilder,
  validFileRows,
  validModelInventory,
  validNativeReceipts,
  validRuntimeFacts,
  validSource
} from './retained-candidate-contract.mjs'
import { assertRequiredFulcioClaims, FULCIO_OID } from './sigstore-identity-claims.mjs'

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
    return parseStrictJsonBytes(bytes)
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
    return TrustedRoot.fromJSON(parseStrictJsonBytes(rootBytes))
  } catch {
    fail('RUNTIME_READBACK_TRUST_ROOT_INVALID')
  }
}

function verifySigner(signer, inventory) {
  const identity = record(record(signer)?.identity)
  const extensions = identity && record(identity.extensions)
  const expectedSignerUri = `${REPOSITORY_URI}/${WORKFLOW_PATH}@${SOURCE_REF}`
  if (
    !identity ||
    !extensions ||
    !exactKeys(extensions, ['issuer']) ||
    extensions.issuer !== 'https://token.actions.githubusercontent.com' ||
    identity.subjectAlternativeName !== expectedSignerUri ||
    !Array.isArray(identity.oids)
  )
    fail('RUNTIME_READBACK_CERTIFICATE_IDENTITY_INVALID')
  const expected = new Map([
    [FULCIO_OID.issuer, 'https://token.actions.githubusercontent.com'],
    [FULCIO_OID.signerUri, expectedSignerUri],
    [FULCIO_OID.signerDigest, inventory.source.workflowCommit],
    [FULCIO_OID.runnerEnvironment, 'github-hosted'],
    [FULCIO_OID.repositoryUri, REPOSITORY_URI],
    [FULCIO_OID.sourceDigest, SOURCE_SHA],
    [FULCIO_OID.sourceRef, SOURCE_REF],
    [FULCIO_OID.repositoryId, REPOSITORY_ID]
  ])
  assertRequiredFulcioClaims(identity.oids, expected)
}

function dssePayload(bundle) {
  const content = record(record(bundle)?.content)
  const envelope = content?.$case === 'dsseEnvelope' ? record(content.dsseEnvelope) : null
  if (
    !envelope ||
    !Buffer.isBuffer(envelope.payload) ||
    envelope.payload.length < 1 ||
    envelope.payload.length > 20_000_000
  )
    fail('RUNTIME_READBACK_ATTESTATION_FORMAT_INVALID')
  return envelope.payload
}

function verifyStatement(bundle, archiveName, archiveHash, inventoryName, inventoryHash) {
  let statement
  try {
    statement = record(parseJson(dssePayload(bundle), 'RUNTIME_READBACK_ATTESTATION_FORMAT_INVALID'))
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

async function verifyTarget(root, target, rootProto, lockSha256) {
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
      'directories',
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
    !exactKeys(candidate.target, ['platform', 'arch']) ||
    !exactKeys(candidate.directories, []) ||
    !validRuntimeFacts(candidate.runtime) ||
    !exactKeys(candidate.archive, ['path', 'bytes', 'sha256']) ||
    !Number.isSafeInteger(candidate.archive.bytes) ||
    candidate.archive.bytes < 1 ||
    typeof candidate.archive.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate.archive.sha256) ||
    !exactKeys(candidate.inventory, ['path', 'bytes', 'sha256']) ||
    !Number.isSafeInteger(candidate.inventory.bytes) ||
    candidate.inventory.bytes < 1 ||
    typeof candidate.inventory.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate.inventory.sha256) ||
    !Number.isSafeInteger(candidate.payloadFiles) ||
    candidate.payloadFiles < 1 ||
    !Number.isSafeInteger(candidate.payloadBytes) ||
    candidate.payloadBytes < 1 ||
    candidate.archive?.path !== archiveName ||
    candidate.inventory?.path !== inventoryName ||
    inference.inferencePassed !== true ||
    !exactKeys(inference, [
      'schemaVersion',
      'componentId',
      'target',
      'nativeFilesVerified',
      'modelId',
      'modelSha256',
      'modelIncludedInArchive',
      'licenseCoverageComplete',
      'inferencePassed',
      'cpuOnly',
      'elapsedMs'
    ]) ||
    inference.schemaVersion !== 1 ||
    inference.componentId !== 'runtime.llama-server' ||
    inference.target !== target.suffix ||
    inference.modelId !== 'qwen3.5-0.8b' ||
    inference.modelSha256 !== '3177ebd67afe4438374da19e690bc1b98756f7e0fea9240e1be404336156a7b5' ||
    !Number.isSafeInteger(inference.elapsedMs) ||
    inference.elapsedMs < 1 ||
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
    'directories',
    'models',
    'source',
    'builder',
    'upstream',
    'files',
    'licenses'
  ]
  let inventoryFileBytes = 0
  const validFiles =
    Array.isArray(inventory.files) &&
    inventory.files.every((raw) => {
      const file = record(raw)
      if (
        !file ||
        !exactKeys(file, ['path', 'bytes', 'sha256', 'executable']) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 1 ||
        typeof file.path !== 'string'
      )
        return false
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
    !validSource(source, lockSha256) ||
    !validFiles ||
    inventory.files.length !== candidate.payloadFiles ||
    inventoryFileBytes !== candidate.payloadBytes ||
    !exactKeys(inventory.entrypoints, ['llama-server']) ||
    inventory.entrypoints['llama-server'] !==
      (target.platform === 'win32' ? 'runtime/llama-server.exe' : 'runtime/llama-server') ||
    !Array.isArray(inventory.models) ||
    inventory.models.length !== 0 ||
    !exactKeys(inventory.directories, []) ||
    !exactKeys(inventory.target, ['platform', 'arch']) ||
    !validRuntimeFacts(inventory.runtime) ||
    !validBuilder(inventory.builder) ||
    !validNativeReceipts(inventory, target) ||
    !validFileRows(
      inventory.files,
      inventory.files.map((file) =>
        record(file)?.path === 'licenses/llama.cpp-LICENSE.txt'
          ? {
              path: 'licenses/llama.cpp-LICENSE.txt',
              bytes: 1078,
              sha256: '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d',
              executable: false
            }
          : null
      ),
      true
    ) ||
    JSON.stringify(inventory.runtime) !== JSON.stringify(candidate.runtime) ||
    inventory.files.filter((file) => file.path.startsWith('runtime/')).length < 1
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
    const payload = dssePayload(bundle)
    const roundTrippedBundle = bundleFromJSON(bundleToJSON(bundle))
    if (!payload.equals(dssePayload(roundTrippedBundle))) fail('RUNTIME_READBACK_BUNDLE_LIBRARY_SHAPE_INVALID')
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

async function verifyModel(root, rootProto, lockSha256) {
  const base = resolve(root, `runtime-llama-model-${SOURCE_SHA}-${RUN_ATTEMPT}`)
  await assertDirectory(base, 'RUNTIME_READBACK_MODEL_LAYOUT_INVALID')
  await assertExactEntries(
    base,
    ['candidate.json', MODEL.archive, MODEL.inventory, MODEL.bundle],
    false,
    'RUNTIME_READBACK_MODEL_LAYOUT_INVALID'
  )
  const candidateBytes = await readStable(
    resolve(base, 'candidate.json'),
    2_000_000,
    'RUNTIME_READBACK_MODEL_CANDIDATE_INVALID'
  )
  const inventoryBytes = await readStable(
    resolve(base, MODEL.inventory),
    20_000_000,
    'RUNTIME_READBACK_MODEL_INVENTORY_INVALID'
  )
  const candidate = record(parseJson(candidateBytes, 'RUNTIME_READBACK_MODEL_CANDIDATE_INVALID'))
  const inventory = record(parseJson(inventoryBytes, 'RUNTIME_READBACK_MODEL_INVENTORY_INVALID'))
  if (
    !candidate ||
    !inventory ||
    !exactKeys(candidate, [
      'schemaVersion',
      'kind',
      'componentId',
      'artifactId',
      'target',
      'runtime',
      'directories',
      'archive',
      'inventory',
      'payloadFiles',
      'payloadBytes'
    ]) ||
    candidate.schemaVersion !== 1 ||
    candidate.kind !== 'model' ||
    candidate.componentId !== MODEL.artifactId ||
    candidate.artifactId !== MODEL.artifactId ||
    !exactKeys(candidate.target, ['platform', 'arch']) ||
    candidate.target.platform !== 'any' ||
    candidate.target.arch !== 'any' ||
    candidate.runtime !== null ||
    !exactKeys(candidate.directories, []) ||
    !exactKeys(candidate.archive, ['path', 'bytes', 'sha256']) ||
    candidate.archive.path !== MODEL.archive ||
    !Number.isSafeInteger(candidate.archive.bytes) ||
    candidate.archive.bytes < 1 ||
    candidate.archive.bytes > 1_000_000_000 ||
    typeof candidate.archive.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate.archive.sha256) ||
    !exactKeys(candidate.inventory, ['path', 'bytes', 'sha256']) ||
    candidate.inventory.path !== MODEL.inventory ||
    !Number.isSafeInteger(candidate.inventory.bytes) ||
    candidate.inventory.bytes < 1 ||
    typeof candidate.inventory.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(candidate.inventory.sha256) ||
    candidate.payloadFiles !== MODEL_FILES.length ||
    candidate.payloadBytes !== MODEL_PAYLOAD_BYTES ||
    !validModelInventory(inventory) ||
    !validSource(inventory.source, lockSha256) ||
    candidate.inventory.bytes !== inventoryBytes.length ||
    candidate.inventory.sha256 !== sha256(inventoryBytes)
  )
    fail('RUNTIME_READBACK_MODEL_INVENTORY_INVALID')

  const archiveName = MODEL.archive
  const archive = await hashStableFile(
    resolve(base, archiveName),
    1_000_000_000,
    'RUNTIME_READBACK_MODEL_ARCHIVE_INVALID'
  )
  if (candidate.archive.bytes !== archive.bytes || candidate.archive.sha256 !== archive.sha256)
    fail('RUNTIME_READBACK_MODEL_ARCHIVE_INVALID')
  const bundleBytes = await readStable(resolve(base, MODEL.bundle), 20_000_000, 'RUNTIME_READBACK_MODEL_BUNDLE_INVALID')
  let bundle
  try {
    bundle = bundleFromJSON(parseJson(bundleBytes, 'RUNTIME_READBACK_MODEL_BUNDLE_INVALID'))
    const payload = dssePayload(bundle)
    if (!payload.equals(dssePayload(bundleFromJSON(bundleToJSON(bundle)))))
      fail('RUNTIME_READBACK_MODEL_BUNDLE_INVALID')
    const verifier = new Verifier(toTrustMaterial(rootProto), {
      tlogThreshold: 1,
      ctlogThreshold: 1,
      timestampThreshold: 1
    })
    verifySigner(await verifier.verify(toSignedEntity(bundle)), inventory)
  } catch {
    fail('RUNTIME_READBACK_MODEL_SIGSTORE_INVALID')
  }
  verifyStatement(bundle, MODEL.archive, archive.sha256, MODEL.inventory, sha256(inventoryBytes))
  return {
    target: 'model-any-any',
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
    [
      ...NATIVE_TARGETS.map((target) => `runtime-llama-${target.suffix}-${SOURCE_SHA}-${RUN_ATTEMPT}`),
      `runtime-llama-model-${SOURCE_SHA}-${RUN_ATTEMPT}`
    ],
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
    !exactKeys(catalog, ['schemaVersion', 'protocolVersion', 'catalogId', 'trustRoot', 'targets']) ||
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
  const packageLock = await hashStableFile(resolve('package-lock.json'), 20_000_000, 'RUNTIME_READBACK_LOCK_INVALID')
  const results = []
  for (const target of NATIVE_TARGETS) results.push(await verifyTarget(root, target, rootProto, packageLock.sha256))
  results.push(await verifyModel(root, rootProto, packageLock.sha256))
  const archiveBytes = results.reduce((total, result) => total + result.archiveBytes, 0)
  const inventoryBytes = results.reduce((total, result) => total + result.inventoryBytes, 0)
  const bundleBytes = results.reduce((total, result) => total + result.bundleBytes, 0)
  const subjectSha256 = sha256(
    Buffer.from(results.flatMap((result) => [result.archiveSha256, result.inventorySha256]).join(''))
  )
  process.stdout.write(
    `RUNTIME_ATTESTATION_READBACK_OK verified=true roots=${results.length} subjects=${results.length * 2} archiveBytes=${archiveBytes} inventoryBytes=${inventoryBytes} bundleBytes=${bundleBytes} trustRootSha256=${sha256(trustRootBytes)} subjectSetSha256=${subjectSha256}\n`
  )
}

main().catch((error) => {
  const message = record(error)?.message
  const code = typeof message === 'string' && /^[A-Z0-9_]+$/.test(message) ? message : 'RUNTIME_READBACK_FAILED'
  process.stderr.write(`${code}\n`)
  process.exitCode = 1
})
