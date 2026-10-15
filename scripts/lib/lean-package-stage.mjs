import { constants, readSync } from 'node:fs'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { lstat, mkdir, open, rm } from 'node:fs/promises'
import { lstatSync, realpathSync, unlinkSync } from 'node:fs'
import { join, parse, resolve } from 'node:path'

/** Electron Builder drops these exact tracked zero-byte directory placeholders from extraResources. */
const LEAN_PACKAGE_DIRECTORY_PLACEHOLDERS = Object.freeze([
  'cloudflare-embed',
  'operator',
  'license-lease',
  'managed-node/darwin-arm64',
  'managed-node/darwin-x64',
  'managed-node/win-x64',
  'vcredist'
])

// ExtraResources copies files, so empty provisioned-key directories need an explicit directory step.
// Their nonempty contents remain subject to the complete package inventory and byte checks.
export async function ensureLeanPackageCoreDirectories(resourcesRoot) {
  const root = await lstat(resourcesRoot)
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('Lean package resource root is invalid')
  for (const name of ['operator', 'license-lease', 'cloudflare-embed']) {
    const directory = join(resourcesRoot, name)
    try {
      await mkdir(directory, { mode: 0o755 })
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    const stat = await lstat(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Lean package ${name} directory is invalid`)
    }
  }
}

export async function removeKnownLeanPackagePlaceholders(resourcesRoot) {
  let removed = false
  for (const directory of LEAN_PACKAGE_DIRECTORY_PLACEHOLDERS) {
    const placeholder = join(resourcesRoot, directory, '.gitkeep')
    let stat
    try {
      stat = await lstat(placeholder)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (!stat.isFile() || stat.size !== 0) {
      throw new Error(`Lean package ${directory} placeholder must be a zero-byte regular file`)
    }
    await rm(placeholder)
    removed = true
  }
  return removed
}

function sameVersion(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function samePathIdentity(left, right) {
  if (left.isDirectory()) {
    return (
      right.isDirectory() &&
      !right.isSymbolicLink() &&
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.mode === right.mode
    )
  }
  return sameVersion(left, right)
}

async function heldRegularFile(path) {
  const pathStat = lstatSync(path, { bigint: true })
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 1n) {
    throw new Error('Lean package factory resource must be a singly-linked regular file')
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n || !sameVersion(pathStat, stat)) {
      throw new Error('Lean package factory resource changed before it was opened')
    }
    return { handle, stat }
  } catch (error) {
    await handle.close()
    throw error
  }
}

function pathIdentityChain(path) {
  const absolute = resolve(path)
  const root = parse(absolute).root
  const parts = absolute.slice(root.length).split(/[\\/]/).filter(Boolean)
  const entries = [{ path: root, stat: lstatSync(root, { bigint: true }) }]
  let current = root
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    const stat = lstatSync(current, { bigint: true })
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) {
      throw new Error('Lean package factory resource path contains a link or non-directory')
    }
    entries.push({ path: current, stat })
  }
  return entries
}

function assertPathChainUnchanged(expected) {
  for (const entry of expected) {
    if (!samePathIdentity(entry.stat, lstatSync(entry.path, { bigint: true }))) {
      throw new Error('Lean package factory resource namespace changed')
    }
  }
}

export async function captureElectronFactoryTemplate(path, retainedHandle, trustedSha256) {
  if (!/^[0-9a-f]{64}$/.test(trustedSha256 ?? '')) {
    throw new Error('Electron factory template lacks its verified archive digest')
  }
  const pathChain = pathIdentityChain(path)
  const expected = pathChain.at(-1).stat
  if (!expected.isFile() || expected.nlink !== 1n) {
    throw new Error('Electron factory template must be a singly-linked regular file')
  }
  const ownsHandle = retainedHandle === undefined
  const handle = retainedHandle ?? (await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)))
  try {
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n || !sameVersion(expected, stat)) {
      throw new Error('Electron factory template changed before it was opened')
    }
    const bytes = await readHeldFile(handle, stat.size)
    const afterRead = await handle.stat({ bigint: true })
    assertPathChainUnchanged(pathChain)
    if (
      !sameVersion(stat, afterRead) ||
      !sameVersion(stat, lstatSync(path, { bigint: true })) ||
      createHash('sha256').update(bytes).digest('hex') !== trustedSha256
    ) {
      throw new Error('Electron factory template differs from its verified archive member')
    }
    return { path, pathChain, handle, stat: afterRead, sha256: trustedSha256, ownsHandle }
  } catch (error) {
    if (ownsHandle) await handle.close()
    throw error
  }
}

export function electronFactoryTemplatePath(distRoot, platform) {
  if (!['darwin', 'mas', 'mas-dev', 'win32', 'linux'].includes(platform)) {
    throw new Error('Unsupported Electron factory platform')
  }
  return platform.startsWith('darwin') || platform.startsWith('mas')
    ? join(distRoot, 'Electron.app', 'Contents', 'Resources', 'default_app.asar')
    : join(distRoot, 'resources', 'default_app.asar')
}

export function electronFactoryArchiveMemberPath(platform) {
  return electronFactoryTemplatePath('', platform).replaceAll('\\', '/')
}

export function canonicalPrivateTemporaryRoot(path) {
  return realpathSync(path)
}

export function electronFactoryArchivePath(distRoot, version, platform, arch) {
  if (!['darwin', 'mas', 'mas-dev'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
    throw new Error('Unsupported custom Electron factory archive selection')
  }
  return join(distRoot, `electron-v${version}-${platform}-${arch}.zip`)
}

async function readHeldFile(handle, size) {
  if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Lean package factory resource is too large')
  const output = Buffer.alloc(Number(size))
  let offset = 0
  while (offset < output.length) {
    const { bytesRead } = await handle.read(output, offset, output.length - offset, offset)
    if (bytesRead === 0) throw new Error('Lean package factory resource changed while reading')
    offset += bytesRead
  }
  return output
}

/** Remove only Electron's unchanged, package-owned factory app from lean resources. */
export async function removeElectronDefaultAppTemplate(resourcesRoot, templateOrTicket, verifySource = () => {}) {
  const templateTicket = typeof templateOrTicket === 'string' ? null : templateOrTicket
  const templatePath = templateTicket?.path ?? templateOrTicket
  const packagedPath = join(resourcesRoot, 'default_app.asar')
  const rootChain = pathIdentityChain(resourcesRoot)
  const templateChain = templateTicket?.pathChain ?? pathIdentityChain(templatePath)
  const rootStat = rootChain.at(-1).stat
  if (!rootStat.isDirectory()) throw new Error('Lean package resource root is invalid')

  let packaged
  let template
  let ownsTemplateHandle = false
  try {
    try {
      packaged = await heldRegularFile(packagedPath)
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
    template = templateTicket ?? (await heldRegularFile(templatePath))
    ownsTemplateHandle = !templateTicket
    if (packaged.stat.size !== template.stat.size) {
      throw new Error('Lean package default_app.asar differs from the Electron factory template')
    }
    const [packagedBytes, templateBytes] = await Promise.all([
      readHeldFile(packaged.handle, packaged.stat.size),
      readHeldFile(template.handle, template.stat.size)
    ])
    const trustedTemplateHash = templateTicket?.sha256
    if (
      !packagedBytes.equals(templateBytes) ||
      (trustedTemplateHash &&
        (createHash('sha256').update(templateBytes).digest('hex') !== trustedTemplateHash ||
          createHash('sha256').update(packagedBytes).digest('hex') !== trustedTemplateHash))
    ) {
      throw new Error('Lean package default_app.asar differs from the Electron factory template')
    }
    const [packagedAfter, templateAfter, rootAfter, packagedPathStat, templatePathStat, rootPathStat] =
      await Promise.all([
        packaged.handle.stat({ bigint: true }),
        template.handle.stat({ bigint: true }),
        lstat(resourcesRoot, { bigint: true }),
        lstat(packagedPath, { bigint: true }),
        lstat(templatePath, { bigint: true }),
        lstat(resourcesRoot, { bigint: true })
      ])
    if (
      !sameVersion(packaged.stat, packagedAfter) ||
      !sameVersion(template.stat, templateAfter) ||
      !sameVersion(packaged.stat, packagedPathStat) ||
      !sameVersion(template.stat, templatePathStat) ||
      !samePathIdentity(rootStat, rootAfter) ||
      !samePathIdentity(rootStat, rootPathStat) ||
      packagedPathStat.isSymbolicLink() ||
      templatePathStat.isSymbolicLink()
    ) {
      throw new Error('Lean package factory resource changed before cleanup')
    }
    // Keep the final namespace check and unlink in one synchronous turn after all asynchronous reads.
    verifySource()
    assertPathChainUnchanged(rootChain)
    assertPathChainUnchanged(templateChain)
    const finalRoot = lstatSync(resourcesRoot, { bigint: true })
    const finalPackaged = lstatSync(packagedPath, { bigint: true })
    const finalTemplate = lstatSync(templatePath, { bigint: true })
    if (!samePathIdentity(rootStat, finalRoot) || !sameVersion(packaged.stat, finalPackaged)) {
      throw new Error('Lean package default_app.asar changed before cleanup')
    }
    if (!sameVersion(template.stat, finalTemplate)) throw new Error('Electron factory template changed before cleanup')
    unlinkSync(packagedPath)
    return true
  } finally {
    await Promise.all(
      [packaged?.handle.close(), ownsTemplateHandle ? template?.handle.close() : undefined].filter(Boolean)
    )
  }
}

/** Unzipper may destroy its stream; only the archive owner may close this retained descriptor. */
export function retainedElectronArchiveSource(fd, byteLength) {
  if (!Number.isSafeInteger(fd) || fd < 0 || !Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw new Error('Pinned Electron archive descriptor or byte length is invalid')
  }
  return Object.freeze({
    async size() {
      return byteLength
    },
    stream(offset, length = byteLength - offset) {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > byteLength ||
        !Number.isSafeInteger(length) ||
        length < 0
      )
        throw new Error('Pinned Electron archive reader requested an invalid range')
      // Unzipper requests padding past the member and sometimes past EOF; the retained file is the cap.
      const boundedLength = Math.min(length, byteLength - offset)
      function* chunks() {
        let position = offset
        const end = offset + boundedLength
        while (position < end) {
          const chunk = Buffer.allocUnsafe(Math.min(65_536, end - position))
          const count = readSync(fd, chunk, 0, chunk.length, position)
          if (count === 0) throw new Error('Pinned Electron archive changed during extraction')
          position += count
          yield chunk.subarray(0, count)
        }
      }
      return Readable.from(chunks(), { objectMode: false, highWaterMark: 65_536 })
    }
  })
}
