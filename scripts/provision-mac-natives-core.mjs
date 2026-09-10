import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const MAC_ARCHES = ['arm64', 'x64']
const EXACT_VERSION = /^\d+\.\d+\.\d+$/

function packageDir(root, name) {
  return join(root, 'node_modules', name)
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`Could not read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function readPackage(root, name) {
  return readJson(join(packageDir(root, name), 'package.json'), `${name} package metadata`)
}

function exactVersion(value, label) {
  if (typeof value !== 'string' || !EXACT_VERSION.test(value)) {
    throw new Error(`${label} must be pinned to an exact stable version.`)
  }
  return value
}

function inside(parent, child) {
  const rel = relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function exactContainedFile(root, packageName, declaredPath, label) {
  const dir = packageDir(root, packageName)
  if (typeof declaredPath !== 'string' || !declaredPath.startsWith('./')) {
    throw new Error(`${label} is not a package-relative file path.`)
  }
  const file = resolve(dir, declaredPath)
  if (!inside(resolve(dir), file) || !existsSync(file)) return null
  const metadata = lstatSync(file)
  if (!metadata.isFile() || metadata.size <= 0) return null
  const actualDir = realpathSync(dir)
  const actualFile = realpathSync(file)
  return inside(actualDir, actualFile) ? file : null
}

function deriveSharpPairs(root) {
  const sharp = readPackage(root, 'sharp')
  const sharpVersion = exactVersion(sharp.version, 'Installed sharp')
  const lock = readJson(join(root, 'package-lock.json'), 'package-lock.json')
  const sharpLock = lock?.packages?.['node_modules/sharp']
  if (sharpLock?.version !== sharpVersion) {
    throw new Error(`Sharp lock version ${String(sharpLock?.version)} does not match installed version ${sharpVersion}.`)
  }

  const pairs = MAC_ARCHES.map((arch) => {
    const addon = `@img/sharp-darwin-${arch}`
    const libvips = `@img/sharp-libvips-darwin-${arch}`
    const addonVersion = exactVersion(sharp?.optionalDependencies?.[addon], `Sharp optional dependency ${addon}`)
    const libvipsVersion = exactVersion(sharp?.optionalDependencies?.[libvips], `Sharp optional dependency ${libvips}`)
    if (addonVersion !== sharpVersion) {
      throw new Error(`Sharp ${sharpVersion} requires ${addon}@${addonVersion}, not its own exact version.`)
    }

    const addonLock = lock?.packages?.[`node_modules/${addon}`]
    const libvipsLock = lock?.packages?.[`node_modules/${libvips}`]
    if (sharpLock?.optionalDependencies?.[addon] !== addonVersion) {
      throw new Error(
        `Sharp lock requirement ${addon} ${String(sharpLock?.optionalDependencies?.[addon])} ` +
        `does not match installed core requirement ${addonVersion}.`
      )
    }
    if (sharpLock?.optionalDependencies?.[libvips] !== libvipsVersion) {
      throw new Error(
        `Sharp lock requirement ${libvips} ${String(sharpLock?.optionalDependencies?.[libvips])} ` +
        `does not match installed core requirement ${libvipsVersion}.`
      )
    }
    if (addonLock?.version !== addonVersion) {
      throw new Error(`${addon} lock version ${String(addonLock?.version)} does not match Sharp required version ${addonVersion}.`)
    }
    const lockedPair = addonLock?.optionalDependencies?.[libvips]
    if (lockedPair !== libvipsVersion) {
      throw new Error(`${addon} lock pairing ${String(lockedPair)} does not match Sharp required ${libvips} ${libvipsVersion}.`)
    }
    if (libvipsLock?.version !== libvipsVersion) {
      throw new Error(`${libvips} lock version ${String(libvipsLock?.version)} does not match Sharp required version ${libvipsVersion}.`)
    }
    return { arch, addon, addonVersion, libvips, libvipsVersion }
  })

  return { sharpVersion, pairs }
}

function verifyHostPair(root, hostArch, sharpVersion, pairs) {
  const pair = pairs.find((candidate) => candidate.arch === hostArch)
  if (!pair) throw new Error(`Mac native provisioning requires an arm64 or x64 host, got ${hostArch}.`)
  const addon = readPackage(root, pair.addon)
  if (addon.version !== pair.addonVersion) {
    throw new Error(`${pair.addon} installed version ${String(addon.version)} does not match required version ${pair.addonVersion}.`)
  }
  const installedPair = addon?.optionalDependencies?.[pair.libvips]
  if (installedPair !== pair.libvipsVersion) {
    throw new Error(
      `${pair.addon} installed pairing ${String(installedPair)} does not match Sharp ${sharpVersion} required ` +
      `${pair.libvips} ${pair.libvipsVersion}.`
    )
  }
  const libvips = readPackage(root, pair.libvips)
  if (libvips.version !== pair.libvipsVersion) {
    throw new Error(
      `${pair.libvips} installed version ${String(libvips.version)} does not match Sharp ${sharpVersion} ` +
      `required version ${pair.libvipsVersion}.`
    )
  }
}

function verifySharpPair(root, pair) {
  const addon = readPackage(root, pair.addon)
  if (addon.version !== pair.addonVersion) {
    throw new Error(`${pair.addon} installed version ${String(addon.version)} does not match required version ${pair.addonVersion}.`)
  }
  if (addon?.optionalDependencies?.[pair.libvips] !== pair.libvipsVersion) {
    throw new Error(`${pair.addon} installed libvips pairing does not match ${pair.libvips}@${pair.libvipsVersion}.`)
  }
  if (addon?.exports?.['./sharp.node'] !== './index.cjs') {
    throw new Error(`${pair.addon} does not expose ./sharp.node through ./index.cjs.`)
  }

  const loaderPath = join(packageDir(root, pair.addon), 'index.cjs')
  let loader
  try {
    loader = readFileSync(loaderPath, 'utf8')
  } catch (error) {
    throw new Error(`Could not read ${pair.addon} loader: ${error instanceof Error ? error.message : String(error)}`)
  }
  const binaryReference = loader.match(/require\.resolve\((['"])([^'"]+)\1\)/)?.[2]
  if (binaryReference !== `${pair.libvips}/binary`) {
    throw new Error(`${pair.addon} loader does not resolve ${pair.libvips}/binary.`)
  }
  const expectedLoaderTarget = `./lib/sharp-darwin-${pair.arch}-${pair.addonVersion}.node`
  const loaderTarget = loader.match(/module\.exports\s*=\s*require\((['"])([^'"]+)\1\)/)?.[2]
  if (loaderTarget !== expectedLoaderTarget) {
    throw new Error(`${pair.addon} loader target must be ${expectedLoaderTarget}, got ${String(loaderTarget)}.`)
  }
  if (!exactContainedFile(root, pair.addon, expectedLoaderTarget, `${pair.addon} loader target`)) {
    throw new Error(`${pair.addon} missing exact addon ${expectedLoaderTarget}.`)
  }

  const libvips = readPackage(root, pair.libvips)
  if (libvips.version !== pair.libvipsVersion) {
    throw new Error(`${pair.libvips} installed version ${String(libvips.version)} does not match required version ${pair.libvipsVersion}.`)
  }
  const versions = readJson(join(packageDir(root, pair.libvips), 'versions.json'), `${pair.libvips} versions metadata`)
  const vipsVersion = exactVersion(versions?.vips, `${pair.libvips} packaged vips`)
  const expectedDylib = `./lib/libvips-cpp.${vipsVersion}.dylib`
  const dylib = libvips?.exports?.['./binary']
  if (dylib !== expectedDylib) {
    throw new Error(`${pair.libvips} binary export must be ${expectedDylib}, got ${String(dylib)}.`)
  }
  if (!exactContainedFile(root, pair.libvips, dylib, `${pair.libvips} binary export`)) {
    throw new Error(`${pair.libvips} missing declared dylib ${String(dylib)}.`)
  }
}

export function provisionMacNatives(options = {}) {
  const root = resolve(options.root || '.')
  const hostArch = options.hostArch || process.arch
  const platform = options.platform || process.platform
  const run = options.run || execFileSync
  const log = options.log || console.log

  const { sharpVersion, pairs } = deriveSharpPairs(root)
  verifyHostPair(root, hostArch, sharpVersion, pairs)
  const sherpaVersion = exactVersion(readPackage(root, 'sherpa-onnx-node').version, 'Installed sherpa-onnx-node')
  const packages = [
    `sherpa-onnx-darwin-arm64@${sherpaVersion}`,
    `sherpa-onnx-darwin-x64@${sherpaVersion}`,
    ...pairs.map((pair) => `${pair.addon}@${pair.addonVersion}`),
    ...pairs.map((pair) => `${pair.libvips}@${pair.libvipsVersion}`)
  ]

  log('=== provision-mac-natives: both mac arches, one install ===')
  for (const pkg of packages) log(`  · ${pkg}`)
  try {
    run('npm', ['install', '--no-save', '--force', ...packages], {
      cwd: root,
      stdio: 'inherit',
      shell: platform === 'win32'
    })
  } catch (error) {
    throw new Error(`provision-mac-natives npm install failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // A forced no-save install resolves the tree again. Do not validate only the original addon plan
  // if npm selected a different core or lock pairing in the meantime.
  const installedGraph = deriveSharpPairs(root)
  if (JSON.stringify(installedGraph) !== JSON.stringify({ sharpVersion, pairs })) {
    throw new Error('Sharp dependency graph changed during native provisioning.')
  }
  for (const pair of pairs) verifySharpPair(root, pair)
  const missingSherpa = MAC_ARCHES
    .map((arch) => `sherpa-onnx-darwin-${arch}/sherpa-onnx.node`)
    .filter((path) => !existsSync(join(root, 'node_modules', path)))
  if (missingSherpa.length) {
    throw new Error(
      `provision-mac-natives FAILED — missing after install:\n${missingSherpa.map((path) => `  ✗ ${path}`).join('\n')}\n` +
      'A universal package built from here would be broken on one architecture.'
    )
  }
  log('=== provision-mac-natives complete — both arches present ===')
  return { sharpVersion, sherpaVersion, packages }
}
