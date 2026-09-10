/**
 * Sharp's reviewed platform payload, checked without loading any native code.
 * The enclosing runtime gate supplies its existing inventory/hash/architecture primitives. Its
 * later full macOS codesign verification remains mandatory after signing; Windows DLLs/addons are
 * never exempt from byte comparison. Changing these reviewed package/layout pins requires review.
 */
import { getRawHeader } from '@electron/asar'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

const SHARP_VERSION = '0.35.4'
const LIBVIPS_VERSION = '1.3.3'
const VIPS_VERSION = '8.18.6'
const HEIF_VERSION = '1.23.2'

export async function verifyPackagedSharp(
  { repoRoot, resourcesRoot, target, arches, postSign = false },
  checks
) {
  const {
    requireDirectory, requireRegularFile, inventoryTree, inventoryFromFiles, requireExactInventory,
    requireSameFile, assertEqual, electronBuilderPackageJson, verifyMachOArches, verifyPeX64
  } = checks
  if (!['mac', 'win'].includes(target) || !Array.isArray(arches) || !arches.length ||
      arches.some((arch) => !['arm64', 'x64'].includes(arch)) || new Set(arches).size !== arches.length) {
    throw new Error('Sharp gate requires a supported target and distinct arm64/x64 architectures')
  }
  const sourceRoot = join(repoRoot, 'node_modules')
  const archive = join(resourcesRoot, 'app.asar')
  const unpacked = join(resourcesRoot, 'app.asar.unpacked')
  const packagedRoot = join(unpacked, 'node_modules')
  // Checking package roots alone would follow a junction/symlink in one of these ancestors.
  for (const path of [sourceRoot, join(sourceRoot, '@img'), resourcesRoot, unpacked, packagedRoot, join(packagedRoot, '@img')]) {
    requireDirectory(path)
  }
  requireRegularFile(archive)
  const lockPath = join(repoRoot, 'package-lock.json')
  requireRegularFile(lockPath)
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const platformArches = target === 'win' ? ['x64'] : arches
  const expected = new Map([['sharp', SHARP_VERSION]])
  for (const arch of platformArches) {
    expected.set(`@img/sharp-${target === 'win' ? 'win32' : 'darwin'}-${arch}`, SHARP_VERSION)
    if (target === 'mac') expected.set(`@img/sharp-libvips-darwin-${arch}`, LIBVIPS_VERSION)
  }

  // Reject both stale physical packages and foreign/duplicate packages visible only inside ASAR.
  for (const name of readdirSync(join(packagedRoot, '@img'))) {
    if (name.startsWith('sharp-') && !expected.has(`@img/${name}`)) {
      throw new Error(`Sharp unexpected platform package: @img/${name}`)
    }
  }
  const archiveEntries = new Map()
  function visit(node, parts = []) {
    for (const [name, entry] of Object.entries(node.files || {})) {
      const path = [...parts, name]
      const key = path.join('/')
      const sharpRoot = (name === 'sharp' && parts.at(-1) === 'node_modules') ||
        (name.startsWith('sharp-') && parts.at(-1) === '@img' && parts.at(-2) === 'node_modules')
      if (sharpRoot && !expected.has(key.replace(/^node_modules\//, ''))) {
        throw new Error(`Sharp unexpected or nested ASAR package: ${key}`)
      }
      archiveEntries.set(key, entry)
      if (entry.files) visit(entry, path)
    }
  }
  visit(getRawHeader(archive).header)
  for (const name of expected.keys()) {
    const parts = ['node_modules', ...name.split('/')]
    for (let count = 1; count <= parts.length; count++) {
      const path = parts.slice(0, count).join('/')
      const entry = archiveEntries.get(path)
      if (!entry?.files || entry.link !== undefined) {
        throw new Error(`Sharp ASAR directory is missing or links elsewhere: ${path}`)
      }
    }
    const prefix = `node_modules/${name}/`
    for (const [path, entry] of archiveEntries) {
      if (path.startsWith(prefix) && entry.files && entry.link !== undefined) {
        throw new Error(`Sharp ASAR directory must not link elsewhere: ${path}`)
      }
    }
  }

  function readJson(path) {
    requireRegularFile(path)
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  const manifests = new Map()
  for (const [name, version] of expected) {
    if (lock.packages?.[`node_modules/${name}`]?.version !== version) {
      throw new Error(`Sharp lock must contain reviewed ${name}@${version}`)
    }
    const root = join(sourceRoot, name)
    requireDirectory(root)
    const manifest = readJson(join(root, 'package.json'))
    if (manifest.name !== name || manifest.version !== version) {
      throw new Error(`Sharp source ${name} version must match reviewed ${version}`)
    }
    manifests.set(name, manifest)
  }
  const core = manifests.get('sharp')
  if (core.main !== './dist/index.cjs' || core.module !== './dist/index.mjs' ||
      core.exports?.['.']?.require?.default !== './dist/index.cjs' ||
      core.exports?.['.']?.import?.default !== './dist/index.mjs') {
    throw new Error('Sharp core loader exports differ from the reviewed CJS/ESM entrypoints')
  }
  for (const [name, version] of expected) {
    if (name !== 'sharp' && core.optionalDependencies?.[name] !== version) {
      throw new Error(`Sharp core dependency pairing differs for ${name}`)
    }
  }

  function sourceInventory(name, source) {
    if (name !== 'sharp') return inventoryTree(source)
    // npm may nest semver (including .bin symlinks) here. Those are dependency-manager
    // entries, not Sharp-owned files; electron-builder collects dependencies separately.
    // Exclude this one boundary before descent, never arbitrary nested node_modules trees.
    const inventory = []
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const path = join(source, entry.name)
      if (entry.isDirectory()) {
        inventory.push(`${entry.name}/`, ...inventoryTree(path).map((file) => `${entry.name}/${file}`))
      } else {
        requireRegularFile(path)
        inventory.push(entry.name)
      }
    }
    return inventory.sort()
  }

  async function verifyTree(name, reviewedFiles, nativeFiles = [], arch) {
    const source = join(sourceRoot, name)
    const packaged = join(packagedRoot, name)
    const sourceFiles = sourceInventory(name, source).filter((file) =>
      !file.endsWith('/') && basename(file).toLowerCase() !== 'readme.md' &&
      // Pinned electron-builder excludes these core-only source files, but retains .h/.d.cts/.d.mts.
      !(name === 'sharp' && (file.endsWith('.cc') || file.endsWith('.d.ts') || basename(file) === 'binding.gyp'))
    )
    if (name === 'sharp' && sourceFiles.some((file) => /\.(?:node|dll|dylib|exe)$/i.test(file))) {
      throw new Error('Sharp core has unexpected native files; only reviewed platform packages may carry native code')
    }
    if (reviewedFiles) assertEqual(sourceFiles, [...reviewedFiles].sort(), `Sharp ${name} source inventory is not reviewed`)
    requireExactInventory(packaged, inventoryFromFiles(sourceFiles), `Sharp ${name}`)
    const prefix = `node_modules/${name}/`
    const visibleFiles = [...archiveEntries].filter(([path, entry]) => path.startsWith(prefix) && !entry.files).map(([path]) => path.slice(prefix.length)).sort()
    assertEqual(visibleFiles, sourceFiles, `Sharp ${name} ASAR inventory mismatch`)
    for (const file of sourceFiles) {
      const from = join(source, file)
      const to = join(packaged, file)
      const entry = archiveEntries.get(`${prefix}${file}`)
      if (entry?.unpacked !== true || entry.link !== undefined || entry.files) {
        throw new Error(`Sharp ASAR file must be a regular unpacked reference: ${prefix}${file}`)
      }
      const signedNative = postSign && target === 'mac' && nativeFiles.includes(file)
      const stat = requireRegularFile(to)
      if (!signedNative && entry.size !== stat.size) {
        throw new Error(`Sharp ASAR size differs from unpacked backing: ${prefix}${file}`)
      }
      if (file === 'package.json') {
        const expectedManifest = electronBuilderPackageJson(readJson(from))
        // Verified against the actual pinned builder output: core contributor metadata is
        // removed by cleanupPackageJson. All retained fields still require exact equality.
        if (name === 'sharp') delete expectedManifest.contributors
        assertEqual(readJson(to), expectedManifest, `Sharp ${name} package.json differs from electron-builder's reviewed projection`)
      } else {
        await requireSameFile(from, to, { verifyHash: !signedNative })
      }
    }
    for (const file of nativeFiles) {
      if (target === 'win') verifyPeX64(join(packaged, file))
      else verifyMachOArches(join(packaged, file), [arch])
    }
  }
  await verifyTree('sharp')
  // Both entrypoints must exist even if a damaged installed source and package agree on an omission.
  for (const file of ['dist/index.cjs', 'dist/index.mjs']) requireRegularFile(join(packagedRoot, 'sharp', file))

  for (const arch of platformArches) {
    const platform = target === 'win' ? 'win32' : 'darwin'
    const name = `@img/sharp-${platform}-${arch}`
    const manifest = manifests.get(name)
    const nodeFile = `lib/sharp-${platform}-${arch}-${SHARP_VERSION}.node`
    if (manifest.exports?.['./sharp.node'] !== './index.cjs' || manifest.exports?.['./package'] !== './package.json') {
      throw new Error(`Sharp ${name} loader exports differ from the reviewed targets`)
    }
    assertEqual(manifest.os, [platform], `Sharp ${name} platform metadata mismatch`)
    assertEqual(manifest.cpu, [arch], `Sharp ${name} architecture metadata mismatch`)
    const vipsName = `@img/sharp-libvips-darwin-${arch}`
    const loader = (target === 'mac' ? `try { require.resolve('${vipsName}/binary'); } catch {}\n` : '') +
      `module.exports = require('./${nodeFile}');`
    requireRegularFile(join(sourceRoot, name, 'index.cjs'))
    if (readFileSync(join(sourceRoot, name, 'index.cjs'), 'utf8').trim() !== loader) {
      throw new Error(`Sharp ${name} loader differs from the reviewed target`)
    }
    const addonFiles = ['LICENSE', 'package.json', 'index.cjs', nodeFile]
    let versionsName = name
    if (target === 'win') {
      const nativeFiles = [nodeFile, 'lib/libvips-42.dll', `lib/libvips-cpp-${VIPS_VERSION}.dll`]
      await verifyTree(name, [...addonFiles, 'versions.json', ...nativeFiles.slice(1)], nativeFiles)
    } else {
      if (manifest.optionalDependencies?.[vipsName] !== LIBVIPS_VERSION) {
        throw new Error(`Sharp ${name} libvips dependency pairing differs from the reviewed version`)
      }
      await verifyTree(name, addonFiles, [nodeFile], arch)
      const vipsManifest = manifests.get(vipsName)
      const dylib = `lib/libvips-cpp.${VIPS_VERSION}.dylib`
      assertEqual(vipsManifest.exports, {
        './lib': './lib/index.js', './package': './package.json', './versions': './versions.json', './binary': `./${dylib}`
      }, `Sharp ${vipsName} exports differ from the reviewed targets`)
      assertEqual(vipsManifest.os, ['darwin'], `Sharp ${vipsName} platform metadata mismatch`)
      assertEqual(vipsManifest.cpu, [arch], `Sharp ${vipsName} architecture metadata mismatch`)
      await verifyTree(vipsName, ['package.json', 'versions.json', 'lib/index.js', 'lib/glib-2.0/include/glibconfig.h', dylib], [dylib], arch)
      versionsName = vipsName
    }
    const versions = readJson(join(packagedRoot, versionsName, 'versions.json'))
    if (versions.heif !== HEIF_VERSION || versions.vips !== VIPS_VERSION) {
      throw new Error(`Sharp ${versionsName} codec versions must be heif ${HEIF_VERSION}, vips ${VIPS_VERSION}`)
    }
  }
}
