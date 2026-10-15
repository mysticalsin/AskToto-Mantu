import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readdir, readlink, copyFile, symlink, chmod } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

const HEX = /^[a-f0-9]{64}$/
const APP_COMPONENTS = Object.freeze([
  'electron-shell',
  'app-asar',
  'app-asar-unpacked',
  'managed-node',
  'ffmpeg',
  'vcredist',
  'mac-helper',
  'intelligence',
  'skills',
  'resources-other'
])
const TARGET_MATRIX = Object.freeze({
  'win-x64-solid': Object.freeze({ target: 'win', arch: 'x64', platform: 'win32', runner: 'windows-latest' }),
  'mac-arm64-udbz': Object.freeze({ target: 'mac', arch: 'arm64', platform: 'darwin', runner: 'macos-latest' }),
  'mac-x64-udbz': Object.freeze({ target: 'mac', arch: 'x64', platform: 'darwin', runner: 'macos-latest' })
})

export function validateMatrixBinding(target, arch, variant) {
  const expected = TARGET_MATRIX[variant]
  if (!expected || expected.target !== target || expected.arch !== arch) {
    throw new Error('Target, architecture, and matrix ID do not match the closed attribution matrix')
  }
  return expected
}

function slash(value) {
  return value.split(sep).join('/')
}

function assertRelativePath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Invalid normalized relative path: ${String(value)}`)
  }
  return value
}

function metadataSignature(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
}

export function portableTreeManifestSha256(entries) {
  const portable = entries
    .map((entry) => {
      if (entry.type === 'directory') return { path: entry.path, type: entry.type }
      if (entry.type === 'symlink') {
        return {
          path: entry.path,
          type: entry.type,
          mode: entry.mode,
          linkText: entry.linkText,
          linkTextBytes: entry.linkTextBytes,
          linkTextSha256: entry.linkTextSha256
        }
      }
      return { path: entry.path, type: entry.type, mode: entry.mode, bytes: entry.bytes, sha256: entry.sha256 }
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return createHash('sha256').update(JSON.stringify(portable), 'utf8').digest('hex')
}

function assertLinkContained(root, linkPath, target) {
  const resolved = target.startsWith('/') ? resolve(target) : resolve(dirname(linkPath), target)
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`Symbolic link escapes app root: ${slash(relative(root, linkPath))} -> ${target}`)
  }
}

export async function sha256File(path) {
  const before = await lstat(path)
  if (!before.isFile()) throw new Error(`Expected regular file: ${path}`)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  const after = await lstat(path)
  if (metadataSignature(before) !== metadataSignature(after)) throw new Error(`File changed while hashing: ${path}`)
  return { bytes: before.size, sha256: hash.digest('hex') }
}

export async function walkTree(root, { windowsPathRules = false } = {}) {
  const absoluteRoot = resolve(root)
  const rootStat = await lstat(absoluteRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error(`Tree root must be a real directory: ${root}`)
  const entries = []
  const hardlinks = new Map()
  const foldedPaths = new Set()

  async function visit(directory, prefix = '') {
    const children = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, 'en')
    )
    for (const child of children) {
      const relativePath = assertRelativePath(prefix ? `${prefix}/${child.name}` : child.name)
      if (windowsPathRules) {
        const folded = relativePath.toLocaleLowerCase('en-US')
        if (foldedPaths.has(folded)) throw new Error(`Windows case collision: ${relativePath}`)
        foldedPaths.add(folded)
      }
      const fullPath = join(directory, child.name)
      const before = await lstat(fullPath)
      if (before.isSymbolicLink()) {
        const text = await readlink(fullPath)
        assertLinkContained(absoluteRoot, fullPath, text)
        const after = await lstat(fullPath)
        if (metadataSignature(before) !== metadataSignature(after))
          throw new Error(`Link changed during inventory: ${relativePath}`)
        const textBytes = Buffer.byteLength(text)
        entries.push({
          path: relativePath,
          type: 'symlink',
          mode: before.mode & 0o7777,
          linkText: text,
          linkTextBytes: textBytes,
          linkTextSha256: createHash('sha256').update(text).digest('hex'),
          lstatBytes: before.size
        })
      } else if (before.isDirectory()) {
        entries.push({ path: relativePath, type: 'directory', mode: before.mode & 0o7777, lstatBytes: before.size })
        await visit(fullPath, relativePath)
      } else if (before.isFile()) {
        const digest = await sha256File(fullPath)
        const after = await lstat(fullPath)
        if (metadataSignature(before) !== metadataSignature(after))
          throw new Error(`File changed during inventory: ${relativePath}`)
        const identity = `${before.dev}:${before.ino}`
        hardlinks.set(identity, (hardlinks.get(identity) ?? 0) + 1)
        entries.push({
          path: relativePath,
          type: 'file',
          mode: before.mode & 0o7777,
          bytes: digest.bytes,
          sha256: digest.sha256,
          lstatBytes: before.size,
          hardlinkIdentity: identity
        })
      } else {
        throw new Error(`Unsupported special file: ${relativePath}`)
      }
    }
  }

  await visit(absoluteRoot)
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const hardlinkGroups = [...hardlinks.entries()]
    .filter(([, count]) => count > 1)
    .map(([identity, count]) => ({ identity, count }))
    .sort((a, b) => a.identity.localeCompare(b.identity))
  const canonical = entries.map(({ hardlinkIdentity, ...entry }) => entry)
  const manifestSha256 = createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex')
  const portableManifestSha256 = portableTreeManifestSha256(canonical)
  const totals = entries.reduce(
    (sum, entry) => {
      if (entry.type === 'file') sum.regularFileBytes += entry.bytes
      if (entry.type === 'symlink') sum.linkTextBytes += entry.linkTextBytes
      if (entry.type === 'directory') sum.directoryLstatBytes += entry.lstatBytes
      else sum.lstatBytes += entry.lstatBytes
      return sum
    },
    { regularFileBytes: 0, linkTextBytes: 0, lstatBytes: 0, directoryLstatBytes: 0 }
  )
  return {
    root: absoluteRoot,
    entries,
    canonicalEntries: canonical,
    manifestSha256,
    portableManifestSha256,
    totals,
    hardlinkGroups
  }
}

export function classifyAppPath(path, platform) {
  const p = assertRelativePath(path)
  const resourcesPrefix = platform === 'darwin' ? 'Contents/Resources/' : 'resources/'
  if (!p.startsWith(resourcesPrefix)) return 'electron-shell'
  const resourcePath = p.slice(resourcesPrefix.length)
  if (resourcePath === 'app.asar' || resourcePath.startsWith('app.asar/')) return 'app-asar'
  if (resourcePath === 'app.asar.unpacked' || resourcePath.startsWith('app.asar.unpacked/')) return 'app-asar-unpacked'
  if (resourcePath === 'managed-node' || resourcePath.startsWith('managed-node/')) return 'managed-node'
  if (resourcePath === 'ffmpeg' || resourcePath.startsWith('ffmpeg/')) return 'ffmpeg'
  if (resourcePath === 'vcredist' || resourcePath.startsWith('vcredist/')) return 'vcredist'
  if (resourcePath === 'mac-helper' || resourcePath.startsWith('mac-helper/')) return 'mac-helper'
  if (resourcePath === 'intelligence' || resourcePath.startsWith('intelligence/')) return 'intelligence'
  if (resourcePath === 'skills' || resourcePath.startsWith('skills/')) return 'skills'
  return 'resources-other'
}

export function partitionManifest(manifest, platform) {
  const components = Object.fromEntries(APP_COMPONENTS.map((name) => [name, []]))
  for (const entry of manifest.entries) components[classifyAppPath(entry.path, platform)].push(entry.path)
  const duplicate = new Set()
  for (const paths of Object.values(components)) {
    for (const path of paths) {
      if (duplicate.has(path)) throw new Error(`App path assigned more than once: ${path}`)
      duplicate.add(path)
    }
  }
  if (duplicate.size !== manifest.entries.length) throw new Error('App partition omitted one or more manifest entries')
  return components
}

export function accountPathGroups(manifest, pathGroups) {
  const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]))
  return Object.fromEntries(
    Object.entries(pathGroups).map(([name, paths]) => {
      const entries = paths.map((path) => {
        const entry = byPath.get(path)
        if (!entry) throw new Error(`Path group references a missing manifest entry: ${path}`)
        return entry
      })
      return [
        name,
        {
          paths: [...paths],
          entries: entries.length,
          regularFileBytes: entries.reduce((sum, entry) => sum + (entry.type === 'file' ? entry.bytes : 0), 0),
          linkTextBytes: entries.reduce((sum, entry) => sum + (entry.type === 'symlink' ? entry.linkTextBytes : 0), 0),
          measureCompatibleLstatBytes: entries.reduce(
            (sum, entry) => sum + (entry.type === 'directory' ? 0 : entry.lstatBytes),
            0
          ),
          directoryLstatBytes: entries.reduce(
            (sum, entry) => sum + (entry.type === 'directory' ? entry.lstatBytes : 0),
            0
          )
        }
      ]
    })
  )
}

export function managedNodeChildren(manifest, platform) {
  const nodeEntries = manifest.entries.filter((entry) => classifyAppPath(entry.path, platform) === 'managed-node')
  const children = { executable: [], headers: [], npm: [], docs: [], tooling: [], licenses: [] }
  for (const entry of nodeEntries) {
    const path = entry.path.slice(entry.path.indexOf('managed-node/') + 'managed-node/'.length)
    const base = path.split('/').at(-1).toLowerCase()
    const runtimePath = path.replace(/^(?:win-x64|darwin-arm64|darwin-x64)\//, '')
    if (
      /^(license|notice|copying|third.party)/.test(base) ||
      /(^|\/)(license|licenses|notice|notices|share\/licenses?)(\/|$)/.test(path.toLowerCase())
    ) {
      children.licenses.push(entry.path)
    } else if (runtimePath === 'node.exe' || runtimePath === 'bin/node') {
      children.executable.push(entry.path)
    } else if (runtimePath.startsWith('include/node/')) {
      children.headers.push(entry.path)
    } else if (/\.(md|html?|txt|1|5)$/.test(base) || /(^|\/)(share\/doc|share\/man|man)(\/|$)/.test(runtimePath)) {
      children.docs.push(entry.path)
    } else if (
      runtimePath.includes('/node_modules/npm/') ||
      runtimePath.startsWith('node_modules/npm/') ||
      /(^|\/)npm-cli\.js$/.test(runtimePath)
    ) {
      children.npm.push(entry.path)
    } else if (
      runtimePath.startsWith('bin/') ||
      runtimePath.startsWith('lib/node_modules/corepack/') ||
      runtimePath.startsWith('node_modules/corepack/')
    ) {
      children.tooling.push(entry.path)
    } else {
      children.tooling.push(entry.path)
    }
  }
  for (const list of Object.values(children)) list.sort()
  return children
}

export function validateInventoryMembers(packageInventory, manifest, platform) {
  const byPath = new Map(
    manifest.entries
      .filter((entry) => entry.type === 'file')
      .map((entry) => [entry.path.replace(platform === 'darwin' ? 'Contents/Resources/' : 'resources/', ''), entry])
  )
  const failures = []
  for (const item of packageInventory.coreFiles) {
    const actual = byPath.get(item.path)
    if (!actual) failures.push({ path: item.path, reason: 'missing' })
    else if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256)
      failures.push({ path: item.path, reason: 'identity-mismatch' })
  }
  return { checked: packageInventory.coreFiles.length, failures }
}

/** @param {{ totals: { lstatBytes: number, regularFileBytes: number, linkTextBytes: number } } | null} [unpackedTree] */
export function asarPhysicalAccounting(archive, members, unpackedTree = null) {
  const packedMemberBytes = members
    .filter((member) => member.type === 'file' && member.packed)
    .reduce((sum, member) => sum + member.bytes, 0)
  const unpackedMemberBytes = members
    .filter((member) => member.type === 'file' && member.unpacked)
    .reduce((sum, member) => sum + member.bytes, 0)
  const packedLinkTextBytes = members
    .filter((member) => member.type === 'symlink' && member.packed)
    .reduce((sum, member) => sum + member.linkTextBytes, 0)
  const unpackedLinkTextBytes = members
    .filter((member) => member.type === 'symlink' && member.unpacked)
    .reduce((sum, member) => sum + member.linkTextBytes, 0)
  return {
    appAsarPhysicalBytes: archive.bytes,
    appAsarUnpackedPhysicalBytes: unpackedTree?.totals.lstatBytes ?? null,
    appAsarUnpackedRegularFileBytes: unpackedTree?.totals.regularFileBytes ?? null,
    appAsarUnpackedLinkTextBytes: unpackedTree?.totals.linkTextBytes ?? null,
    packedMemberRawBytes: packedMemberBytes,
    unpackedMemberRawBytesSecondary: unpackedMemberBytes,
    packedMemberLinkTextBytesSecondary: packedLinkTextBytes,
    unpackedMemberLinkTextBytesSecondary: unpackedLinkTextBytes,
    note: 'Physical app.asar bytes already contain packed members and header/padding. app.asar.unpacked bytes are separately present in the complete tree. Secondary ASAR logical member totals are not added to physical totals.'
  }
}

export function digestPaths(paths) {
  const normalized = [...paths].map(assertRelativePath).sort()
  if (new Set(normalized).size !== normalized.length) throw new Error('Path list contains duplicates')
  return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex')
}

export function expandProjectionPaths(manifest, selectedPaths) {
  const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]))
  const included = new Set(selectedPaths.map(assertRelativePath))
  if (included.size !== selectedPaths.length) throw new Error('Projection contains duplicate paths')
  for (const path of included) {
    if (!byPath.has(path)) throw new Error(`Projection path is absent from source manifest: ${path}`)
    let parent = dirname(path).split(sep).join('/')
    while (parent && parent !== '.') {
      const entry = byPath.get(parent)
      if (!entry || entry.type !== 'directory')
        throw new Error(`Projection parent is missing or not a directory: ${parent}`)
      included.add(parent)
      parent = dirname(parent).split(sep).join('/')
    }
  }
  return [...included].sort()
}

export function assertOwnedDisjoint(outputPath, ...inputPaths) {
  if (!outputPath || !String(outputPath).trim()) throw new Error('Owned output path is required')
  if (String(outputPath).split(/[\\/]/).includes('..'))
    throw new Error('Owned output path cannot traverse a parent directory')
  const output = resolve(outputPath)
  if (output === parseRoot(output)) throw new Error('Owned output path cannot be a filesystem root')
  for (const inputPath of inputPaths) {
    const input = resolve(inputPath)
    if (output === input || output.startsWith(`${input}${sep}`) || input.startsWith(`${output}${sep}`)) {
      throw new Error(`Output and input paths overlap: ${output} / ${input}`)
    }
  }
  return output
}

function parseRoot(path) {
  const absolute = resolve(path)
  return absolute.slice(0, absolute.indexOf(sep, 1) + 1) || sep
}

export async function initializeReportDirectory(path, inputs = []) {
  const output = assertOwnedDisjoint(path, ...inputs)
  await mkdir(dirname(output), { recursive: true })
  await mkdir(output, { recursive: false })
  return output
}

export async function copyProjection(sourceRoot, destinationRoot, selectedPaths, expectedManifestSha256, options = {}) {
  const source = resolve(sourceRoot)
  const destination = resolve(destinationRoot)
  if (
    destination === source ||
    destination.startsWith(`${source}${sep}`) ||
    source.startsWith(`${destination}${sep}`)
  ) {
    throw new Error('Projection destination must be disjoint from its immutable input')
  }
  const paths = [...selectedPaths].map(assertRelativePath).sort()
  if (new Set(paths).size !== paths.length) throw new Error('Projection contains duplicate paths')
  const before = await walkTree(source, options)
  if (before.manifestSha256 !== expectedManifestSha256) throw new Error('Projection source digest is stale')
  const beforeMap = new Map(before.entries.map((entry) => [entry.path, entry]))
  await mkdir(destination, { recursive: false })
  const requiredParents = new Set()
  for (const path of paths) {
    const entry = beforeMap.get(path)
    if (!entry) throw new Error(`Projection path is absent from source manifest: ${path}`)
    let parent = dirname(path).split(sep).join('/')
    while (parent && parent !== '.') {
      requiredParents.add(parent)
      parent = dirname(parent).split(sep).join('/')
    }
  }
  for (const parent of [...requiredParents].sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)
  )) {
    const parentPath = join(destination, ...parent.split('/'))
    await mkdir(parentPath, { recursive: true })
  }
  for (const path of paths) {
    const entry = beforeMap.get(path)
    const from = join(source, ...path.split('/'))
    const to = join(destination, ...path.split('/'))
    if (entry.type === 'directory') {
      await mkdir(to, { recursive: true })
    } else if (entry.type === 'symlink') {
      await symlink(entry.linkText, to)
    } else {
      await mkdir(dirname(to), { recursive: true })
      await copyFile(from, to)
      await chmod(to, entry.mode)
    }
  }
  const projectionPaths = new Set([...paths, ...requiredParents])
  for (const entry of before.entries
    .filter((item) => projectionPaths.has(item.path) && item.type === 'directory')
    .sort((a, b) => b.path.split('/').length - a.path.split('/').length)) {
    await chmod(join(destination, ...entry.path.split('/')), entry.mode)
  }
  const after = await walkTree(source, options)
  if (after.manifestSha256 !== expectedManifestSha256) throw new Error('Immutable input changed during projection copy')
  const projection = await walkTree(destination, options)
  const expected = before.entries.filter((entry) => projectionPaths.has(entry.path))
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]))
  if (projection.entries.length !== expected.length)
    throw new Error('Projection manifest has an unexpected entry count')
  for (const actual of projection.entries) {
    const sourceEntry = expectedByPath.get(actual.path)
    if (!sourceEntry || sourceEntry.type !== actual.type || sourceEntry.mode !== actual.mode) {
      throw new Error(`Projection entry type or mode differs from source: ${actual.path}`)
    }
    if (actual.type === 'file' && (sourceEntry.bytes !== actual.bytes || sourceEntry.sha256 !== actual.sha256)) {
      throw new Error(`Projection file identity differs from source: ${actual.path}`)
    }
    if (
      actual.type === 'symlink' &&
      (sourceEntry.linkText !== actual.linkText || sourceEntry.linkTextSha256 !== actual.linkTextSha256)
    ) {
      throw new Error(`Projection link identity differs from source: ${actual.path}`)
    }
  }
  return projection
}

export function validateProbeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Probe record must be an object')
  if (
    !HEX.test(record.inputManifestSha256) ||
    !HEX.test(record.selectedPathListSha256) ||
    !HEX.test(record.excludedPathListSha256)
  ) {
    throw new Error('Probe record is missing manifest or path-list bindings')
  }
  if (!Number.isSafeInteger(record.rawMemberBytes) || record.rawMemberBytes < 0)
    throw new Error('Probe raw bytes are invalid')
  if (
    record.status === 'complete' &&
    (!Number.isSafeInteger(record.outputBytes) || !HEX.test(record.outputSha256) || record.verified !== true)
  ) {
    throw new Error('Probe cannot be complete without verified output bytes and digest')
  }
  if (record.status === 'failed' && record.verified === true) throw new Error('Failed probe cannot be verified')
  return record
}

export function validateReportArtifactRoster(paths) {
  const allowed =
    /^(report\.json|run-paths\.json|capture-hook-identity\.json|windows-archive-capture\.json|app-manifest\.json|asar-members\.json|package-notices\.json|native-smoke\.json|strict-size-measurement\.json|probe-(?:[a-z0-9-]+|\*)\.json|source-inputs\.sha256)$/
  const normalized = paths.map(assertRelativePath)
  if (new Set(normalized).size !== normalized.length) throw new Error('Report artifact roster contains duplicate paths')
  for (const path of normalized) {
    if (!allowed.test(path)) throw new Error(`Non-report artifact path rejected: ${path}`)
  }
  return normalized.sort()
}

export async function copyStableFile(source, destination) {
  const sourceDigest = await sha256File(source)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
  const copiedDigest = await sha256File(destination)
  const after = await sha256File(source)
  if (
    JSON.stringify(sourceDigest) !== JSON.stringify(copiedDigest) ||
    JSON.stringify(sourceDigest) !== JSON.stringify(after)
  ) {
    throw new Error('Source changed or copied bytes did not verify')
  }
  return copiedDigest
}
