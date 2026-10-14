import type { RuntimeCatalogRow, RuntimeInventoryV1 } from './runtime-provenance'

const MAX_INVENTORY_FILES = 100_000
const MAX_INVENTORY_LICENSES = 10_000
const MAX_TOTAL_PAYLOAD_BYTES = 10_000_000_000
const SHA256 = /^[0-9a-f]{64}$/
const SOURCE_REPOSITORY = 'https://github.com/mysticalsin/AskToto-Mantu'

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const object = record(value)
  if (object)
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeJson(child)
    Object.freeze(value)
  }
  return value
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

export function parseRuntimeInventory(value: unknown, row: RuntimeCatalogRow): RuntimeInventoryV1 {
  const inventory = record(value)
  if (
    !inventory ||
    !exactKeys(inventory, [
      'schemaVersion',
      'kind',
      'componentId',
      'artifactId',
      'target',
      'runtime',
      'source',
      'builder',
      'upstream',
      'files',
      'licenses',
      'entrypoints',
      'models',
      'directories'
    ])
  ) {
    throw new Error('RUNTIME_INVENTORY_INVALID')
  }
  const source = record(inventory.source)
  if (
    !source ||
    !exactKeys(source, [
      'repositoryUri',
      'commit',
      'ref',
      'workflowPath',
      'workflowCommit',
      'runId',
      'attempt',
      'lockSha256',
      'runnerEnvironment'
    ])
  ) {
    throw new Error('RUNTIME_INVENTORY_INVALID')
  }
  const builder = record(inventory.builder)
  const target = record(inventory.target)
  const runtime = record(inventory.runtime)
  const entrypoints = record(inventory.entrypoints)
  const sameClosedJson = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right)
  if (
    inventory.schemaVersion !== 1 ||
    inventory.kind !== row.kind ||
    inventory.componentId !== row.componentId ||
    inventory.artifactId !== row.artifactId ||
    !target ||
    !exactKeys(target, ['platform', 'arch']) ||
    target.platform !== row.target.platform ||
    target.arch !== row.target.arch ||
    !sameClosedJson(inventory.entrypoints, row.entrypoints) ||
    !sameClosedJson(inventory.models, row.models) ||
    !sameClosedJson(inventory.directories, row.directories) ||
    (row.kind === 'runtime' &&
      (!runtime ||
        !row.runtime ||
        !exactKeys(runtime, ['electronVersion', 'nodeAbi', 'napi', 'chromiumVersion', 'hostProtocol']) ||
        runtime.electronVersion !== row.runtime.electronVersion ||
        runtime.nodeAbi !== row.runtime.nodeAbi ||
        runtime.napi !== row.runtime.napi ||
        runtime.chromiumVersion !== row.runtime.chromiumVersion ||
        runtime.hostProtocol !== row.runtime.hostProtocol)) ||
    (row.kind === 'model' && (inventory.runtime !== null || row.runtime !== null)) ||
    source.repositoryUri !== SOURCE_REPOSITORY ||
    source.commit !== row.signer.sourceCommit ||
    source.ref !== row.signer.ref ||
    source.workflowPath !== row.signer.workflowPath ||
    source.workflowCommit !== row.signer.workflowCommit ||
    source.runnerEnvironment !== row.signer.runnerEnvironment ||
    typeof source.runId !== 'string' ||
    !/^\d{1,20}$/.test(source.runId) ||
    !Number.isSafeInteger(source.attempt) ||
    (source.attempt as number) < 1 ||
    typeof source.lockSha256 !== 'string' ||
    !SHA256.test(source.lockSha256) ||
    !builder ||
    !exactKeys(builder, ['nodeVersion', 'npmVersion', 'zlibVersion', 'packages']) ||
    typeof builder.nodeVersion !== 'string' ||
    !/^v\d+\.\d+\.\d+$/.test(builder.nodeVersion) ||
    typeof builder.npmVersion !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(builder.npmVersion) ||
    typeof builder.zlibVersion !== 'string' ||
    builder.zlibVersion.length < 1 ||
    builder.zlibVersion.length > 64 ||
    !Array.isArray(builder.packages) ||
    builder.packages.length < 1 ||
    builder.packages.length > 128 ||
    !Array.isArray(inventory.upstream) ||
    inventory.upstream.length < 1 ||
    inventory.upstream.length > 256 ||
    !Array.isArray(inventory.files) ||
    inventory.files.length < 1 ||
    inventory.files.length > MAX_INVENTORY_FILES ||
    !Array.isArray(inventory.licenses) ||
    inventory.licenses.length < 1 ||
    inventory.licenses.length > MAX_INVENTORY_LICENSES ||
    !entrypoints ||
    !Array.isArray(inventory.models) ||
    (row.kind === 'runtime' && (Object.keys(entrypoints).length === 0 || inventory.models.length !== 0)) ||
    (row.kind === 'model' && (Object.keys(entrypoints).length !== 0 || inventory.models.length === 0))
  )
    throw new Error('RUNTIME_INVENTORY_IDENTITY_MISMATCH')

  let previousPackage = ''
  for (const raw of builder.packages) {
    const item = record(raw)
    if (
      !item ||
      !exactKeys(item, ['name', 'version']) ||
      typeof item.name !== 'string' ||
      item.name.length < 1 ||
      item.name.length > 256 ||
      typeof item.version !== 'string' ||
      item.version.length < 1 ||
      item.version.length > 128 ||
      item.name <= previousPackage
    ) {
      throw new Error('RUNTIME_BUILDER_INVENTORY_INVALID')
    }
    previousPackage = item.name
  }
  for (const raw of inventory.upstream) {
    const item = record(raw)
    const digest = item && record(item.digest)
    if (
      !item ||
      !exactKeys(item, ['name', 'version', 'sourceUri', 'revision', 'digest']) ||
      typeof item.name !== 'string' ||
      item.name.length < 1 ||
      item.name.length > 256 ||
      typeof item.version !== 'string' ||
      item.version.length < 1 ||
      item.version.length > 128 ||
      !httpsImmutableUrl(item.sourceUri) ||
      typeof item.revision !== 'string' ||
      item.revision.length < 1 ||
      item.revision.length > 256 ||
      !digest ||
      !exactKeys(digest, ['algorithm', 'value']) ||
      (digest.algorithm !== 'sha256' && digest.algorithm !== 'sha512') ||
      typeof digest.value !== 'string' ||
      (digest.algorithm === 'sha256' ? !SHA256.test(digest.value) : !/^[0-9a-f]{128}$/.test(digest.value))
    ) {
      throw new Error('RUNTIME_UPSTREAM_INVENTORY_INVALID')
    }
  }

  let totalBytes = 0
  let previousPath = ''
  const exact = new Map<string, { bytes: number; sha256: string }>()
  const folded = new Set<string>()
  for (const raw of inventory.files) {
    const file = record(raw)
    if (
      !file ||
      !exactKeys(file, ['path', 'bytes', 'sha256', 'executable']) ||
      !safePath(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      (file.bytes as number) < 0 ||
      typeof file.sha256 !== 'string' ||
      !SHA256.test(file.sha256) ||
      typeof file.executable !== 'boolean' ||
      file.path <= previousPath
    )
      throw new Error('RUNTIME_INVENTORY_INVALID')
    const key = file.path.toLowerCase()
    if (exact.has(file.path) || folded.has(key)) throw new Error('RUNTIME_INVENTORY_PATH_COLLISION')
    exact.set(file.path, { bytes: file.bytes as number, sha256: file.sha256 })
    folded.add(key)
    previousPath = file.path
    totalBytes += file.bytes as number
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_PAYLOAD_BYTES)
      throw new Error('RUNTIME_INVENTORY_TOO_LARGE')
  }
  if (totalBytes !== row.payloadBytes) throw new Error('RUNTIME_CATALOG_PAYLOAD_SIZE_MISMATCH')
  const roles = new Set([
    'parakeet-host',
    'whisper-import-host',
    'whisper-renderer-worker',
    'speaker-embedding-host',
    'llama-server'
  ])
  for (const [role, path] of Object.entries(entrypoints)) {
    if (!roles.has(role) || !safePath(path) || !exact.has(path))
      throw new Error('RUNTIME_ENTRYPOINT_INVENTORY_MISMATCH')
  }
  const modelIds = new Set<string>()
  const modelMembers = new Set<string>()
  for (const raw of inventory.models) {
    const model = record(raw)
    if (
      !model ||
      !exactKeys(model, ['id', 'root', 'members']) ||
      typeof model.id !== 'string' ||
      ![
        'asr.parakeet-tdt-0.6b-v3-int8',
        'asr.whisper-base-q8',
        'speaker.embedding',
        'qwen3.5-0.8b',
        'qwen3.5-4b'
      ].includes(model.id) ||
      modelIds.has(model.id) ||
      !safePath(model.root) ||
      !Array.isArray(model.members) ||
      model.members.length === 0
    ) {
      throw new Error('RUNTIME_MODEL_INVENTORY_INVALID')
    }
    modelIds.add(model.id)
    const localMembers = new Set<string>()
    for (const member of model.members) {
      const foldedMember = typeof member === 'string' ? member.toLowerCase() : ''
      if (
        !safePath(member) ||
        !member.startsWith(`${model.root}/`) ||
        localMembers.has(foldedMember) ||
        modelMembers.has(foldedMember) ||
        !exact.has(member)
      ) {
        throw new Error('RUNTIME_MODEL_INVENTORY_INVALID')
      }
      localMembers.add(foldedMember)
      modelMembers.add(foldedMember)
    }
    const closure = [...exact.keys()].filter((path) => path.startsWith(`${model.root}/`))
    if (closure.length !== localMembers.size || closure.some((path) => !localMembers.has(path.toLowerCase()))) {
      throw new Error('RUNTIME_MODEL_INVENTORY_INVALID')
    }
  }
  const directories = record(inventory.directories)
  if (!directories || Object.keys(directories).some((id) => id !== 'whisper-ort-wasm')) {
    throw new Error('RUNTIME_DIRECTORY_INVENTORY_INVALID')
  }
  for (const raw of Object.values(directories)) {
    const directory = record(raw)
    if (
      !directory ||
      !exactKeys(directory, ['root', 'members']) ||
      !safePath(directory.root) ||
      !Array.isArray(directory.members) ||
      directory.members.length === 0
    ) {
      throw new Error('RUNTIME_DIRECTORY_INVENTORY_INVALID')
    }
    const members = new Set<string>()
    for (const member of directory.members) {
      if (
        !safePath(member) ||
        !member.startsWith(`${directory.root}/`) ||
        members.has(member.toLowerCase()) ||
        !exact.has(member)
      ) {
        throw new Error('RUNTIME_DIRECTORY_INVENTORY_INVALID')
      }
      members.add(member.toLowerCase())
    }
    const closure = [...exact.keys()].filter((path) => path.startsWith(`${directory.root}/`))
    if (closure.length !== members.size || closure.some((path) => !members.has(path.toLowerCase()))) {
      throw new Error('RUNTIME_DIRECTORY_INVENTORY_INVALID')
    }
  }
  for (const raw of inventory.licenses) {
    const license = record(raw)
    if (
      !license ||
      !exactKeys(license, [
        'package',
        'version',
        'spdx',
        'sourceUri',
        'noticePath',
        'noticeBytes',
        'noticeSha256',
        'sourceReceiptUri'
      ])
    ) {
      throw new Error('RUNTIME_LICENSE_RECEIPT_INVALID')
    }
    if (
      typeof license.package !== 'string' ||
      !/^[A-Za-z0-9@/._+-]{1,200}$/.test(license.package) ||
      typeof license.version !== 'string' ||
      !/^[A-Za-z0-9._+-]{1,80}$/.test(license.version) ||
      typeof license.spdx !== 'string' ||
      !/^[A-Za-z0-9.+() -]{1,128}$/.test(license.spdx) ||
      !httpsImmutableUrl(license.sourceUri) ||
      !safePath(license.noticePath) ||
      !Number.isSafeInteger(license.noticeBytes) ||
      (license.noticeBytes as number) < 1 ||
      typeof license.noticeSha256 !== 'string' ||
      !SHA256.test(license.noticeSha256) ||
      !httpsImmutableUrl(license.sourceReceiptUri)
    )
      throw new Error('RUNTIME_LICENSE_RECEIPT_INVALID')
    const notice = exact.get(license.noticePath)
    if (!notice || notice.bytes !== license.noticeBytes || notice.sha256 !== license.noticeSha256) {
      throw new Error('RUNTIME_LICENSE_NOTICE_MISSING')
    }
  }
  return freezeJson(inventory) as unknown as RuntimeInventoryV1
}
