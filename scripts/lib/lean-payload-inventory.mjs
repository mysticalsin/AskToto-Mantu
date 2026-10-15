import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstat, mkdir, readFile, readdir, readlink, rm } from 'node:fs/promises'
import { dirname, join, posix, resolve, sep } from 'node:path'
import { asarPhysicalAccounting, partitionManifest, sha256File, walkTree } from './lean-payload-attribution.mjs'
import { asarGroup } from './lean-payload-compression.mjs'

function safeAsarPath(value) {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
  if (!normalized || normalized === '.') return ''
  if (
    normalized.startsWith('/') ||
    /^[a-z]:/i.test(normalized) ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Unsafe ASAR member path: ${value}`)
  return normalized
}

function normalizeAsarListPath(value) {
  return value.replace(/\\/g, '/').replace(/^\/+/, '')
}

export async function asarMemberInventory(payloadRoot, asarPath, unpackedRoot) {
  const require = createRequire(join(payloadRoot, 'package.json'))
  const asar = require('@electron/asar')
  const asarPackage = JSON.parse(await readFile(join(payloadRoot, 'node_modules/@electron/asar/package.json'), 'utf8'))
  if (asarPackage.version !== '3.4.1') throw new Error('ASAR reader differs from the reviewed lockfile pin')
  const headerInfo = asar.getRawHeader(asarPath)
  const membersByPath = new Map()
  function visit(node, prefix = '') {
    if (!node.files || typeof node.files !== 'object') return
    for (const [name, entry] of Object.entries(node.files)) {
      const path = prefix ? `${prefix}/${name}` : name
      if (entry.files && typeof entry.files === 'object') membersByPath.set(path, { type: 'directory', entry })
      else if (typeof entry.link === 'string') membersByPath.set(path, { type: 'symlink', entry })
      else membersByPath.set(path, { type: 'file', entry })
      if (entry.files && typeof entry.files === 'object') visit(entry, path)
    }
  }
  visit(headerInfo.header)
  const rows = asar
    .listPackage(asarPath)
    .map((value) => safeAsarPath(normalizeAsarListPath(value)))
    .sort()
  if (new Set(rows).size !== rows.length) throw new Error('ASAR list contains duplicate normalized paths')
  if (rows.length !== membersByPath.size || rows.some((path) => !membersByPath.has(path)))
    throw new Error('ASAR list and locked reader header path roster differ')
  const members = []
  for (const path of rows) {
    const { type, entry: header } = membersByPath.get(path)
    if (type === 'directory') {
      members.push({ path, type, group: asarGroup(path), packed: null, unpacked: null })
      continue
    }
    if (type === 'symlink') {
      const linkText = header.link
      if (linkText.startsWith('/') || /^[a-z]:/i.test(linkText))
        throw new Error(`ASAR symlink has an absolute target: ${path}`)
      const target = posix.normalize(linkText)
      if (target === '..' || target.startsWith('../') || target.startsWith('/'))
        throw new Error(`ASAR symlink escapes archive root: ${path}`)
      let physicalLinkText = null
      if (header.unpacked) {
        const physicalPath = join(unpackedRoot, ...path.split('/'))
        const physicalStat = await lstat(physicalPath)
        if (!physicalStat.isSymbolicLink()) throw new Error(`ASAR unpacked link is not a symbolic link: ${path}`)
        physicalLinkText = await readlink(physicalPath)
        if (posix.normalize(posix.join(posix.dirname(path), physicalLinkText.replace(/\\/g, '/'))) !== target)
          throw new Error(`ASAR unpacked link target differs from archive header: ${path}`)
      }
      members.push({
        path,
        type,
        group: asarGroup(path),
        linkText,
        linkTextBytes: Buffer.byteLength(linkText),
        linkTextSha256: createHash('sha256').update(linkText).digest('hex'),
        physicalLinkText,
        packed: !header.unpacked,
        unpacked: Boolean(header.unpacked)
      })
      continue
    }
    const identity = header.unpacked
      ? await sha256File(join(unpackedRoot, ...path.split('/')))
      : (() => {
          const bytes = asar.extractFile(asarPath, path.split('/').join(sep))
          return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }
        })()
    if (header.size !== identity.bytes) throw new Error(`ASAR logical size differs from physical member: ${path}`)
    members.push({
      path,
      type,
      bytes: identity.bytes,
      sha256: identity.sha256,
      packed: !header.unpacked,
      unpacked: Boolean(header.unpacked),
      group: asarGroup(path)
    })
  }
  const physical = await sha256File(asarPath)
  const unpackedTree = await walkTree(unpackedRoot)
  const expectedUnpacked = new Map()
  for (const member of members.filter((item) => item.unpacked)) {
    expectedUnpacked.set(member.path, member.type)
    let parent = posix.dirname(member.path)
    while (parent !== '.' && parent !== '/') {
      expectedUnpacked.set(parent, 'directory')
      parent = posix.dirname(parent)
    }
  }
  const actualUnpacked = unpackedTree.entries
    .map(({ path, type }) => [path, type])
    .sort(([a], [b]) => a.localeCompare(b))
  const expectedUnpackedRows = [...expectedUnpacked.entries()].sort(([a], [b]) => a.localeCompare(b))
  if (JSON.stringify(actualUnpacked) !== JSON.stringify(expectedUnpackedRows))
    throw new Error('Physical ASAR unpacked tree path/type roster differs from header unpacked members')
  return {
    reader: { package: '@electron/asar', version: asarPackage.version },
    archive: physical,
    headerSize: headerInfo.headerSize,
    members,
    physicalAccounting: asarPhysicalAccounting(physical, members, unpackedTree),
    unpackedTree: {
      manifestSha256: unpackedTree.manifestSha256,
      totals: unpackedTree.totals,
      entries: unpackedTree.entries.length
    },
    groups: {
      outMain: members.filter((member) => member.group === 'out/main').length,
      renderer: members.filter((member) => member.group === 'renderer').length,
      productionPackages: members.filter((member) => member.group === 'production-packages').length,
      other: members.filter((member) => member.group === 'other').length
    },
    memberRawBytesAreSecondary: true,
    note: 'ASAR directories and symlinks are explicit. Packed members are contained in the one physical app.asar file. Unpacked files and links are separately represented by the physical app.asar.unpacked tree; secondary logical member totals are not added again. ASAR header/padding are included in physical app.asar bytes.'
  }
}

export async function verifyMacInstaller(installer, appRoot, scratchRoot, records, run) {
  records.push(await run('hdiutil', ['verify', installer], { timeoutMs: 5 * 60_000 }))
  const info = await run('hdiutil', ['imageinfo', installer], { timeoutMs: 5 * 60_000 })
  const mount = join(scratchRoot, 'mounted-actual-dmg')
  await mkdir(mount, { recursive: false })
  try {
    const attached = await run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, installer], {
      timeoutMs: 5 * 60_000
    })
    records.push(attached)
    const mountedApps = (await readdir(mount, { withFileTypes: true })).filter(
      (entry) => entry.isDirectory() && entry.name.endsWith('.app')
    )
    if (mountedApps.length !== 1) throw new Error(`DMG must contain exactly one app, found ${mountedApps.length}`)
    const mountedApp = join(mount, mountedApps[0].name)
    const packaged = await walkTree(appRoot, { windowsPathRules: false })
    const installed = await walkTree(mountedApp, { windowsPathRules: false })
    if (packaged.portableManifestSha256 !== installed.portableManifestSha256)
      throw new Error('Mounted DMG portable content/link identity differs from the completed app tree')
    const decorations = []
    for (const entry of await readdir(mount, { withFileTypes: true })) {
      if (entry.name === mountedApps[0].name) continue
      const path = join(mount, entry.name)
      const details = await lstat(path)
      decorations.push(
        entry.isSymbolicLink()
          ? {
              name: entry.name,
              type: 'symlink',
              mode: details.mode & 0o7777,
              linkText: await readlink(path),
              linkTextSha256: createHash('sha256')
                .update(await readlink(path))
                .digest('hex')
            }
          : {
              name: entry.name,
              type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
              mode: details.mode & 0o7777,
              bytes: details.size
            }
      )
    }
    return {
      imageInfo: info.stdout,
      packagedStrictManifestSha256: packaged.manifestSha256,
      mountedStrictManifestSha256: installed.manifestSha256,
      packagedPortableManifestSha256: packaged.portableManifestSha256,
      mountedPortableManifestSha256: installed.portableManifestSha256,
      directoryAllocation: {
        packagedLstatBytes: packaged.totals.directoryLstatBytes,
        mountedLstatBytes: installed.totals.directoryLstatBytes
      },
      decorations
    }
  } finally {
    await run('hdiutil', ['detach', mount], { timeoutMs: 2 * 60_000 }).catch((error) => {
      throw new Error(`DMG detach failed: ${error.message}`)
    })
    await rm(mount, { recursive: true, force: true })
  }
}

export async function fetchedInputInventory(payloadRoot, appResourcesPath, target, arch) {
  const resources = join(payloadRoot, 'resources')
  const runtimeManifest = JSON.parse(await readFile(join(payloadRoot, 'src/shared/managed-node-manifest.json'), 'utf8'))
  const nodeKey = target === 'win' ? 'win32-x64' : `darwin-${arch}`
  const nodeSpec = runtimeManifest.assets[nodeKey]
  const nodeArchive = join(resources, 'managed-node', '.cache', nodeSpec.file)
  const ffmpegManifest = JSON.parse(await readFile(join(resources, 'ffmpeg/manifest.json'), 'utf8'))
  const ffmpegRelative = `${target === 'win' ? 'win32-x64' : `darwin-${arch}`}/${target === 'win' ? 'ffmpeg.exe' : 'ffmpeg'}`
  const ffmpegSource = join(resources, 'ffmpeg', ffmpegRelative)
  const ffmpegExpected =
    ffmpegManifest.binaries?.[
      `${target === 'win' ? 'win32' : 'darwin'}-${arch}/${target === 'win' ? 'ffmpeg.exe' : 'ffmpeg'}`
    ]?.sha256 ?? null
  const electronVersion = JSON.parse(
    await readFile(join(payloadRoot, 'node_modules/electron/package.json'), 'utf8')
  ).version
  const inputFiles = [
    {
      name: `managed-node-archive-${nodeKey}`,
      path: nodeArchive,
      expectedSha256: nodeSpec.sha256,
      verification: 'official Node archive SHA256 from locked manifest'
    },
    {
      name: `ffmpeg-${target}-${arch}`,
      path: ffmpegSource,
      expectedSha256: ffmpegExpected,
      verification: 'expected SHA256 from reviewed FFmpeg manifest'
    },
    {
      name: 'electron-distribution-archive',
      path:
        target === 'mac' ? join(resources, 'electron-dist', `electron-v${electronVersion}-darwin-${arch}.zip`) : null,
      expectedSha256: null,
      verifiedByPreparation: target === 'mac',
      verification:
        target === 'mac'
          ? 'Provisioning matched official SHASUMS256; expected digest was not retained and remains UNKNOWN'
          : 'UNKNOWN: original Electron archive/cache bytes were not retained at a reviewed path'
    }
  ]
  if (target === 'win') {
    inputFiles.push({
      name: 'vcredist-x64',
      path: join(resources, 'vcredist/vc_redist.x64.exe'),
      expectedSha256: null,
      verification: 'UNKNOWN: source fetch uses the Microsoft aka.ms URL without a reviewed expected SHA256'
    })
  } else {
    inputFiles.push({
      name: 'mac-capture-helper',
      path: join(resources, 'mac-helper/metis-mac-helper'),
      expectedSha256: null,
      verifiedByPreparation: true,
      verification: 'Build and package check steps succeeded; locally built helper has no fetched archive digest'
    })
  }
  const records = []
  for (const input of inputFiles) {
    if (!input.path) {
      records.push({
        name: input.name,
        status: 'UNKNOWN-original-fetched-archive-not-retained',
        verification: input.verification
      })
      continue
    }
    try {
      const identity = await sha256File(input.path)
      const matches = input.expectedSha256 ? identity.sha256 === input.expectedSha256 : null
      if (matches === false) throw new Error(`Observed input digest disagrees with reviewed pin: ${input.name}`)
      records.push({
        name: input.name,
        status:
          matches === true
            ? 'verified-pinned-input'
            : input.verifiedByPreparation
              ? 'verified-by-existing-preparation-step-expected-digest-UNKNOWN'
              : 'observed-unpinned-input',
        bytes: identity.bytes,
        sha256: identity.sha256,
        expectedSha256: input.expectedSha256,
        verification: input.verification
      })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      records.push({
        name: input.name,
        status: 'UNKNOWN-input-not-retained-after-preparation',
        expectedSha256: input.expectedSha256,
        verification: input.verification
      })
    }
  }
  const electronTree = await walkTree(join(payloadRoot, 'node_modules/electron/dist'), {
    windowsPathRules: target === 'win'
  })
  records.push({
    name: 'build-checkout-electron-distribution-files-not-assumed-as-packaging-input',
    status: 'observed',
    manifestSha256: electronTree.manifestSha256,
    totals: electronTree.totals
  })
  const packagedNode = await walkTree(join(appResourcesPath, 'managed-node'), { windowsPathRules: target === 'win' })
  records.push({
    name: 'installed-managed-node-tree',
    status: 'observed-packaged-runtime',
    manifestSha256: packagedNode.manifestSha256,
    totals: packagedNode.totals,
    entries: packagedNode.entries.map(({ path: name, type, bytes, sha256, linkTextSha256 }) => ({
      path: name,
      type,
      bytes: bytes ?? null,
      sha256: sha256 ?? null,
      linkTextSha256: linkTextSha256 ?? null
    }))
  })
  return records
}

export async function collectNotices(payloadRoot, resourcesPath, manifest, asar) {
  const pattern = /(^|\/)(license|licenses|notice|notices|copying|third[._-]?party|copyright)([^/]*$|\/)/i
  const noticeFiles = manifest.entries
    .filter((entry) => entry.type === 'file' && pattern.test(entry.path))
    .map(({ path, bytes, sha256 }) => ({
      path,
      bytes,
      sha256,
      scope: path.includes('/managed-node/') ? 'managed-node-including-nested-npm' : 'app-tree'
    }))
  const asarNotices = asar.members
    .filter((member) => member.type === 'file' && pattern.test(member.path))
    .map((member) => ({
      path: `app.asar/${member.path}`,
      bytes: member.bytes,
      sha256: member.sha256,
      scope: 'asar-member'
    }))
  noticeFiles.push(...asarNotices)
  const managedRoot = join(resourcesPath, 'managed-node')
  const nodeEntries = manifest.entries.filter(
    (entry) => entry.type === 'file' && entry.path.includes('/managed-node/') && entry.path.endsWith('/package.json')
  )
  const managedNpmPackages = []
  for (const entry of nodeEntries) {
    const relativeToResources = entry.path.slice(entry.path.indexOf('/managed-node/') + 1)
    const physical = join(managedRoot, ...relativeToResources.split('/').slice(1))
    const packageData = JSON.parse(await readFile(physical, 'utf8'))
    const path = entry.path.slice(entry.path.indexOf('managed-node/') + 'managed-node/'.length)
    if (!path.includes('node_modules/npm/')) continue
    managedNpmPackages.push({
      path,
      name: typeof packageData.name === 'string' ? packageData.name : null,
      version: typeof packageData.version === 'string' ? packageData.version : null,
      license: packageData.license ?? null,
      packageJsonSha256: entry.sha256
    })
  }
  managedNpmPackages.sort((a, b) => (a.name ?? a.path).localeCompare(b.name ?? b.path))
  return {
    schema: 1,
    noticeFiles,
    managedNpmPackages,
    npmPackageSource: 'actual package.json files shipped under the managed official Node npm tree',
    note: 'No notice path or package license was inferred from the build checkout dependency list.'
  }
}

export function duplicateFiles(manifest) {
  const byHash = new Map()
  for (const entry of manifest.entries) {
    if (entry.type !== 'file') continue
    const key = `${entry.bytes}:${entry.sha256}`
    const paths = byHash.get(key) ?? []
    paths.push(entry.path)
    byHash.set(key, paths)
  }
  return [...byHash.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([identity, paths]) => ({ identity, paths: paths.sort(), reviewOnly: true }))
}

export function secondaryPathGroups(manifest, platform) {
  const components = partitionManifest(manifest, platform)
  const shell = { mainExecutables: [], frameworksAndHelpers: [], locales: [], licenses: [], remainingChromium: [] }
  for (const path of components['electron-shell']) {
    const lower = path.toLowerCase()
    const leaf = lower.split('/').at(-1)
    if (/(^|\/)(metis|asktoto)(\.exe)?$/.test(lower)) shell.mainExecutables.push(path)
    else if (lower.includes('/frameworks/') || lower.includes('/helpers/')) shell.frameworksAndHelpers.push(path)
    else if (lower.includes('/locales/') || /(^|\/)locale[s]?\//.test(lower)) shell.locales.push(path)
    else if (/(^|\/)(license|notice|copying|third.party)/.test(leaf)) shell.licenses.push(path)
    else shell.remainingChromium.push(path)
  }
  const resources = { licenses: [], trust: [], configuration: [], fixtures: [], other: [] }
  for (const path of components['resources-other']) {
    const lower = path.toLowerCase()
    if (/(^|\/)(license|licenses|notice|notices|copying|third.party)/.test(lower)) resources.licenses.push(path)
    else if (/(trust|cert|\.pem$|\.crt$|\.cer$)/.test(lower)) resources.trust.push(path)
    else if (/(config|\.json$|\.ya?ml$|\.toml$|\.ini$)/.test(lower)) resources.configuration.push(path)
    else if (/(fixture|fixtures|snapshot|testdata)/.test(lower)) resources.fixtures.push(path)
    else resources.other.push(path)
  }
  return {
    electronShell: shell,
    remainingResources: {
      completePathList: components['resources-other'],
      secondaryGroups: resources,
      note: 'Secondary path classifications only; they are not additional top-level byte partitions.'
    }
  }
}
