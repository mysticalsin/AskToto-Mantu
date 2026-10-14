import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { SpeechPackBuildProfile } from './profile'
import { readSpeechPackProfile } from './profile'

export interface PackageInventoryCoreFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

export interface PackageInventoryV1 {
  readonly schema: 1
  readonly profile: 'full' | 'lean'
  readonly platform: 'darwin' | 'win32'
  readonly arch: 'arm64' | 'x64' | 'universal'
  readonly appVersion: string
  readonly electronVersion: string
  readonly sourceCommit: string
  readonly coreFiles: readonly PackageInventoryCoreFile[]
  readonly identity: string
}

export type PackageRuntimeContract =
  | { status: 'verified'; profile: 'full' | 'lean'; inventory: PackageInventoryV1 }
  | { status: 'legacy-full'; profile: 'full'; inventory: null }
  | { status: 'development'; profile: 'development'; inventory: null }
  | {
      status: 'invalid'
      reason: 'profile-invalid' | 'profile-mismatch' | 'inventory-invalid' | 'target-mismatch' | 'inventory-missing'
      profile: null
      inventory: null
    }

export interface PackageRuntimeContractOptions {
  resourcesRoot: string
  compiledProfile: SpeechPackBuildProfile
  appVersion: string
  platform?: NodeJS.Platform
  arch?: string
  electronVersion?: string
}

const PROFILE_FILE = 'speech-pack-profile.json'
const INVENTORY_FILE = 'package-inventory.json'
const MAX_INVENTORY_BYTES = 2 * 1024 * 1024
const MAX_INVENTORY_FILES = 4096
const HASH = /^[0-9a-f]{64}$/
const SOURCE_COMMIT = /^[0-9a-f]{40}$/
const SAFE_RESOURCE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

function invalid(reason: Extract<PackageRuntimeContract, { status: 'invalid' }>['reason']): PackageRuntimeContract {
  return { status: 'invalid', reason, profile: null, inventory: null }
}

async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) return null
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size > maxBytes ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      return null
    const bytes = Buffer.alloc(maxBytes + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maxBytes) return null
    const after = await handle.stat()
    const pathAfter = await lstat(path)
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino ||
      pathAfter.size !== opened.size
    )
      return null
    return bytes.subarray(0, offset)
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).join(',') === expected.join(',')
}

function isInventory(value: unknown): value is PackageInventoryV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (
    !exactKeys(record, [
      'schema',
      'profile',
      'platform',
      'arch',
      'appVersion',
      'electronVersion',
      'sourceCommit',
      'coreFiles',
      'identity'
    ]) ||
    record.schema !== 1 ||
    (record.profile !== 'full' && record.profile !== 'lean') ||
    (record.platform !== 'darwin' && record.platform !== 'win32') ||
    (record.arch !== 'arm64' && record.arch !== 'x64' && record.arch !== 'universal') ||
    typeof record.appVersion !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,79}$/.test(record.appVersion) ||
    typeof record.electronVersion !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(record.electronVersion) ||
    typeof record.sourceCommit !== 'string' ||
    !SOURCE_COMMIT.test(record.sourceCommit) ||
    !Array.isArray(record.coreFiles) ||
    record.coreFiles.length > MAX_INVENTORY_FILES ||
    typeof record.identity !== 'string' ||
    !HASH.test(record.identity)
  )
    return false

  let previousPath: string | null = null
  for (const item of record.coreFiles) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const file = item as Record<string, unknown>
    if (
      !exactKeys(file, ['path', 'bytes', 'sha256']) ||
      typeof file.path !== 'string' ||
      !SAFE_RESOURCE_PATH.test(file.path) ||
      file.path.includes('\\') ||
      file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      !Number.isSafeInteger(file.bytes) ||
      (file.bytes as number) < 0 ||
      typeof file.sha256 !== 'string' ||
      !HASH.test(file.sha256) ||
      (previousPath !== null && file.path <= previousPath)
    )
      return false
    previousPath = file.path
  }
  return record.coreFiles.some((item) => (item as PackageInventoryCoreFile).path === PROFILE_FILE)
}

function inventoryIdentity(inventory: PackageInventoryV1): string {
  const payload = {
    schema: inventory.schema,
    profile: inventory.profile,
    platform: inventory.platform,
    arch: inventory.arch,
    appVersion: inventory.appVersion,
    electronVersion: inventory.electronVersion,
    sourceCommit: inventory.sourceCommit,
    coreFiles: inventory.coreFiles.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
  }
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex')
}

/**
 * Bind runtime admission to the compile-time package choice and the checked package-owned resources.
 * An old full package with neither profile file remains compatible; lean never gets that fallback.
 */
export async function readPackageRuntimeContract(
  options: PackageRuntimeContractOptions
): Promise<PackageRuntimeContract> {
  if (options.compiledProfile === 'development') {
    return { status: 'development', profile: 'development', inventory: null }
  }
  const profilePath = join(options.resourcesRoot, PROFILE_FILE)
  const inventoryPath = join(options.resourcesRoot, INVENTORY_FILE)
  let profileExists = false
  let inventoryExists = false
  try {
    await lstat(profilePath)
    profileExists = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return invalid('profile-invalid')
  }
  try {
    await lstat(inventoryPath)
    inventoryExists = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return invalid('inventory-invalid')
  }

  if (!profileExists && !inventoryExists && options.compiledProfile === 'full') {
    return { status: 'legacy-full', profile: 'full', inventory: null }
  }
  if (!profileExists) return invalid(options.compiledProfile === 'lean' ? 'inventory-missing' : 'profile-invalid')

  const profileRead = await readSpeechPackProfile(options.resourcesRoot, true)
  if (profileRead.profile === null) return invalid('profile-invalid')
  if (profileRead.profile !== options.compiledProfile) return invalid('profile-mismatch')
  if (profileRead.profile !== 'full' && profileRead.profile !== 'lean') return invalid('profile-invalid')
  if (!inventoryExists) {
    // Existing full packages ship the exact profile marker but predate the inventory resource.
    // Preserve that established runtime closure only for a valid compiled-full package.
    return options.compiledProfile === 'full' && profileRead.profile === 'full'
      ? { status: 'legacy-full', profile: 'full', inventory: null }
      : invalid('inventory-missing')
  }

  const bytes = await readBoundedFile(inventoryPath, MAX_INVENTORY_BYTES)
  if (!bytes) return invalid('inventory-invalid')
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return invalid('inventory-invalid')
  }
  if (!isInventory(parsed)) return invalid('inventory-invalid')
  const inventory = parsed
  if (
    inventory.profile !== profileRead.profile ||
    inventory.identity !== inventoryIdentity(inventory) ||
    inventory.appVersion !== options.appVersion ||
    inventory.electronVersion !== (options.electronVersion ?? process.versions.electron)
  )
    return invalid('inventory-invalid')

  // The inventory is only useful when its authoritative profile marker is the exact recorded file.
  // This keeps a forged or replaced marker from turning a valid package inventory into another profile.
  const profileBytes = await readBoundedFile(profilePath, 128)
  const profileEntry = inventory.coreFiles.find((item) => item.path === PROFILE_FILE)
  if (
    !profileBytes ||
    !profileEntry ||
    profileEntry.bytes !== profileBytes.byteLength ||
    profileEntry.sha256 !== createHash('sha256').update(profileBytes).digest('hex')
  ) {
    return invalid('inventory-invalid')
  }

  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  if (inventory.platform !== platform || (inventory.arch !== arch && inventory.arch !== 'universal')) {
    return invalid('target-mismatch')
  }
  if (inventory.arch === 'universal' && inventory.profile !== 'full') return invalid('target-mismatch')
  return { status: 'verified', profile: profileRead.profile, inventory }
}

/**
 * Create an explicit startup-boundary loader. Calling it performs the read once; later status and
 * authorization checks reuse the same immutable package facts without filesystem or network work.
 */
export function createPackageRuntimeContractProvider(
  options: PackageRuntimeContractOptions
): () => Promise<PackageRuntimeContract> {
  let loaded: Promise<PackageRuntimeContract> | null = null
  return () => {
    loaded ??= readPackageRuntimeContract(options).catch(() => invalid('inventory-invalid'))
    return loaded
  }
}
