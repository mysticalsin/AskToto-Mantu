#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { lstat, mkdir, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import os from 'node:os'
import { runDiagnosticChild } from '../lib/lean-diagnostic-child.mjs'
import {
  assertOwnedDisjoint,
  accountPathGroups,
  classifyAppPath,
  copyProjection,
  copyStableFile,
  digestPaths,
  expandProjectionPaths,
  initializeReportDirectory,
  managedNodeChildren,
  partitionManifest,
  sha256File,
  validateInventoryMembers,
  validateMatrixBinding,
  validateProbeRecord,
  validateReportArtifactRoster,
  walkTree
} from '../lib/lean-payload-attribution.mjs'
import {
  attachMarginal,
  find7za,
  hdiutilReadOnlyEvidence,
  nativeSmoke,
  runMacProbe,
  runWindowsDiagnostics,
  selectedEntries,
  sumRaw
} from '../lib/lean-payload-compression.mjs'
import {
  asarMemberInventory,
  collectNotices,
  duplicateFiles,
  fetchedInputInventory,
  secondaryPathGroups,
  verifyMacInstaller
} from '../lib/lean-payload-inventory.mjs'
const PAYLOAD_SHA = 'd6003b038ffd3bbf94a3aa7b44aa6645f4e4f180'
const NONPROMOTABLE = 'NONPROMOTABLE-lean-attribution'
function required(value, name) {
  if (!value) throw new Error(`Missing required ${name}`)
  return value
}
function redact(text) {
  return String(text)
    .replace(/(https?:\/\/)[^\s"']+/gi, '$1[REDACTED_URL]')
    .replace(/([A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|KEY)[A-Z0-9_]*=)[^\s]+/gi, '$1[REDACTED]')
}
function boundedNativeSmokeFailure(error, redact) {
  const result = error?.result
  const boundedText = (value, maxLength) => redact(String(value ?? '')).slice(0, maxLength)
  const failure = { message: boundedText(error?.message ?? error, 4000), result: null }
  if (result && typeof result === 'object') {
    failure.result = {
      command: boundedText(result.command, 4096),
      args: Array.isArray(result.args) ? result.args.slice(0, 128).map((arg) => boundedText(arg, 4096)) : [],
      exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
      signal: result.signal === null || typeof result.signal === 'string' ? result.signal : null,
      stdout: boundedText(result.stdout, 2_000_000),
      stderr: boundedText(result.stderr, 2_000_000),
      timedOut: result.timedOut === true,
      outputLimitExceeded: result.outputLimitExceeded === true,
      ...(typeof result.spawnError === 'string' ? { spawnError: boundedText(result.spawnError, 4000) } : {})
    }
  }
  return failure
}
async function run(command, args, { cwd, timeoutMs = 30 * 60_000, maxOutputBytes = 2_000_000 } = {}) {
  return runDiagnosticChild(command, args, { cwd, timeoutMs, maxOutputBytes, redact })
}
async function locateNpmCli(payloadRoot) {
  const candidates = [
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    join(dirname(dirname(process.execPath)), 'lib/node_modules/npm/bin/npm-cli.js'),
    join(payloadRoot, 'node_modules/npm/bin/npm-cli.js')
  ]
  for (const path of candidates) {
    try {
      if ((await lstat(path)).isFile()) return path
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return null
}
async function initialize(options) {
  const variant = validateMatrixBinding(options.target, options.arch, options.variant)
  if (process.env.GITHUB_SHA !== options.diagnosticSha)
    throw new Error('Diagnostic SHA does not match the workflow commit')
  const payloadRoot = resolve(options.payloadRoot)
  const diagnosticRoot = resolve(options.diagnosticRoot)
  const expectedReportRoot = resolve(
    diagnosticRoot,
    'build',
    'lean-attribution-reports',
    `${options.variant}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
  )
  const requestedReportRoot = resolve(options.reportRoot)
  if (requestedReportRoot !== expectedReportRoot)
    throw new Error('Report path does not match the owned closed-matrix report directory')
  const reportRoot = await initializeReportDirectory(requestedReportRoot, [payloadRoot])
  const scratchRoot = assertOwnedDisjoint(resolve(options.scratchRoot), payloadRoot, diagnosticRoot, reportRoot)
  const runnerTemp = resolve(process.env.RUNNER_TEMP ?? os.tmpdir())
  if (!scratchRoot.startsWith(`${runnerTemp}${sep}`))
    throw new Error('Scratch path is outside runner temporary storage')
  await mkdir(scratchRoot, { recursive: false })
  const payloadHead = (await run('git', ['-C', payloadRoot, 'rev-parse', 'HEAD'], { timeoutMs: 30_000 })).stdout.trim()
  const payloadStatus = await run('git', ['-C', payloadRoot, 'status', '--porcelain'], { timeoutMs: 30_000 })
  if (payloadHead !== PAYLOAD_SHA || payloadStatus.stdout.trim())
    throw new Error('Payload source checkout is not the exact clean d600 source')
  const report = {
    schema: 1,
    reportKind: NONPROMOTABLE,
    status: 'initialized',
    attributionComplete: false,
    workflow: {
      sha: options.diagnosticSha,
      ref: process.env.GITHUB_REF ?? null,
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      job: process.env.GITHUB_JOB ?? null,
      matrixId: options.variant
    },
    payloadSource: { expectedSha: PAYLOAD_SHA, observedSha: payloadHead, clean: true },
    host: { os: process.platform, arch: process.arch, version: process.version },
    target: { id: options.variant, platform: variant.platform, arch: variant.arch },
    timestamps: { startedAt: new Date().toISOString(), endedAt: null },
    failures: [],
    limitations: [
      'Compressed component standalone sizes and leave-one-out marginal deltas are observations, not additive allocations.',
      'Only a complete final installer rebuild can establish a proposed shipping change actual savings.',
      'This report does not qualify an installer for release or the 150000000-byte gate.'
    ]
  }
  await writeFile(join(reportRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  await writeFile(join(reportRoot, 'run-paths.json'), `${JSON.stringify({ reportRoot, scratchRoot }, null, 2)}\n`, {
    flag: 'wx'
  })
  return { reportRoot, scratchRoot, payloadRoot, diagnosticRoot, report }
}
async function prepareCapture(payloadRoot, diagnosticRoot, reportRoot) {
  const captureSource = join(diagnosticRoot, 'scripts', 'diagnostics', 'capture-lean-nsis-payload.mjs')
  const captureHash = await sha256File(captureSource)
  const payloadCapture = join(payloadRoot, 'build', 'lean-measurements', 'capture-lean-nsis-payload.mjs')
  await mkdir(dirname(payloadCapture), { recursive: true })
  await copyStableFile(captureSource, payloadCapture)
  const record = {
    sourceName: 'capture-lean-nsis-payload.mjs',
    sourceSha256: captureHash.sha256,
    installedPath: 'build/lean-measurements/capture-lean-nsis-payload.mjs'
  }
  await writeFile(join(reportRoot, 'capture-hook-identity.json'), `${JSON.stringify(record, null, 2)}\n`, {
    flag: 'wx'
  })
  return record
}
async function findApp(outputRoot, target) {
  const candidates = []
  async function walk(path) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const full = join(path, item.name)
      if (item.isDirectory()) {
        if (target === 'win' && item.name === 'win-unpacked') candidates.push(full)
        else if (target === 'mac' && item.name.endsWith('.app')) candidates.push(full)
        else await walk(full)
      }
    }
  }
  await walk(outputRoot)
  if (candidates.length !== 1) throw new Error(`Expected exactly one packaged app tree, found ${candidates.length}`)
  return candidates[0]
}
async function findInstaller(outputRoot, extension) {
  const found = []
  async function walk(path) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      const full = join(path, item.name)
      if (item.isDirectory()) await walk(full)
      else if (
        item.isFile() &&
        extname(item.name).toLowerCase() === `.${extension}` &&
        !full.includes(`${sep}win-unpacked${sep}`)
      )
        found.push(full)
    }
  }
  await walk(outputRoot)
  if (found.length !== 1) throw new Error(`Expected exactly one installer output, found ${found.length}`)
  return found[0]
}
async function runMacDiagnostics(context) {
  const { appRoot, appManifest, reportRoot, scratchRoot, installer, payloadRoot, report } = context
  const runProbe = (options) => runMacProbe({ ...options, payloadRoot })
  const nativeRecords = []
  report.macDmg = await verifyMacInstaller(installer, appRoot, scratchRoot, nativeRecords, run)
  const components = partitionManifest(appManifest, 'darwin')
  const nodeChildren = managedNodeChildren(appManifest, 'darwin')
  const children = Object.entries(nodeChildren).filter(([, paths]) => paths.length)
  const standaloneProbeCount = Object.values(components).filter((paths) => paths.length > 0).length + children.length
  if (standaloneProbeCount > 20) throw new Error(`Mac standalone probe roster exceeds 20 sets: ${standaloneProbeCount}`)
  const probes = []
  const fullEntries = appManifest.entries
  const fullBefore = await runProbe({
    id: 'full-control-before',
    sourceRoot: appRoot,
    sourceManifest: appManifest,
    entries: fullEntries,
    scratchRoot,
    output: reportRoot,
    reports: probes,
    run,
    redact
  })
  await runProbe({
    id: 'empty-control',
    sourceRoot: appRoot,
    sourceManifest: appManifest,
    entries: [],
    scratchRoot,
    output: reportRoot,
    reports: probes,
    run,
    redact,
    baselineRefs: ['full-control-before']
  })
  for (const [name, paths] of Object.entries(components)) {
    if (!paths.length) continue
    const set = selectedEntries(appManifest, paths)
    await runProbe({
      id: `component-${name}`,
      sourceRoot: appRoot,
      sourceManifest: appManifest,
      entries: set,
      scratchRoot,
      output: reportRoot,
      reports: probes,
      run,
      redact,
      baselineRefs: ['full-control-before']
    })
  }
  for (const [name, paths] of children) {
    await runProbe({
      id: `managed-node-${name}`,
      sourceRoot: appRoot,
      sourceManifest: appManifest,
      entries: selectedEntries(appManifest, paths),
      scratchRoot,
      output: reportRoot,
      reports: probes,
      run,
      redact,
      baselineRefs: ['full-control-before']
    })
  }
  const omittedSets = [
    ['full-minus-managed-node', components['managed-node']],
    ['full-minus-node-headers', nodeChildren.headers],
    ['full-minus-node-docs', nodeChildren.docs],
    ['full-minus-node-headers-and-docs', [...nodeChildren.headers, ...nodeChildren.docs]]
  ]
  const notApplicable = []
  for (const [id, omittedPaths] of omittedSets) {
    if (!omittedPaths.length) {
      notApplicable.push({
        id,
        status: 'not-applicable',
        reason: 'The exact selected member set is empty for this platform/tree.'
      })
      continue
    }
    const omitted = new Set(omittedPaths)
    const included = fullEntries.filter((entry) => !omitted.has(entry.path))
    const leaveOut = await runProbe({
      id,
      sourceRoot: appRoot,
      sourceManifest: appManifest,
      entries: included,
      scratchRoot,
      output: reportRoot,
      reports: probes,
      run,
      redact,
      baselineRefs: ['full-control-before']
    })
    await attachMarginal(leaveOut, fullBefore, reportRoot)
  }
  const fullAfter = await runProbe({
    id: 'full-control-after',
    sourceRoot: appRoot,
    sourceManifest: appManifest,
    entries: fullEntries,
    scratchRoot,
    output: reportRoot,
    reports: probes,
    run,
    redact,
    baselineRefs: ['full-control-before']
  })
  const controlRepeat =
    fullBefore.outputBytes !== fullAfter.outputBytes
      ? await runProbe({
          id: 'full-control-repeat',
          sourceRoot: appRoot,
          sourceManifest: appManifest,
          entries: fullEntries,
          scratchRoot,
          output: reportRoot,
          reports: probes,
          run,
          redact,
          baselineRefs: ['full-control-before', 'full-control-after']
        })
      : null
  report.mac = {
    container: {
      type: 'diagnostic HFS+ UDBZ image',
      volumeNamePolicy:
        'METIS_A_ plus 24 random lowercase hexadecimal characters; fixed 32 ASCII bytes; each probe records its own name.',
      note: 'Builder layout/decorations/filesystem sizing may differ; these probes do not predict final DMG delta.'
    },
    componentPaths: components,
    managedNodeChildren: nodeChildren,
    probeControls: {
      fullBefore: fullBefore.outputBytes,
      fullAfter: fullAfter.outputBytes,
      repeat: controlRepeat?.outputBytes ?? null,
      rangeBytes: controlRepeat
        ? [
            Math.min(fullBefore.outputBytes, fullAfter.outputBytes, controlRepeat.outputBytes),
            Math.max(fullBefore.outputBytes, fullAfter.outputBytes, controlRepeat.outputBytes)
          ]
        : [
            Math.min(fullBefore.outputBytes, fullAfter.outputBytes),
            Math.max(fullBefore.outputBytes, fullAfter.outputBytes)
          ]
    },
    probeCount: probes.length,
    standaloneProbeCount,
    probeRosterLimit: 20,
    notApplicable,
    probes: probes.map(({ selectedPaths, ...probe }) => probe),
    commands: nativeRecords.map(({ stdout, stderr, ...record }) => ({
      ...record,
      stdout: redact(stdout),
      stderr: redact(stderr)
    })),
    mandatoryNoDoubleCountNote:
      'Standalone sizes and leave-one-out marginal values do not add to installer size. Only a complete final installer rebuild can establish any proposed shipping change actual savings.'
  }
}
async function collect(options) {
  const reportRoot = resolve(options.reportRoot)
  const scratchRoot = resolve(options.scratchRoot)
  const payloadRoot = resolve(options.payloadRoot)
  validateMatrixBinding(options.target, options.arch, options.variant)
  if (
    process.env.GITHUB_SHA !== options.diagnosticSha ||
    resolve(options.outputRoot) !== resolve(payloadRoot, 'release', `lean-attribution-${options.variant}`)
  )
    throw new Error('Diagnostic commit or output directory is not bound to this closed run')
  const report = JSON.parse(await readFile(join(reportRoot, 'report.json'), 'utf8'))
  report.status = 'running'
  const appRoot = await findApp(resolve(options.outputRoot), options.target)
  const appManifest = await walkTree(appRoot, { windowsPathRules: options.target === 'win' })
  const platform = options.target === 'win' ? 'win32' : 'darwin'
  const resourcesPath = join(
    appRoot,
    platform === 'darwin' ? 'Contents' : '',
    platform === 'darwin' ? 'Resources' : 'resources'
  )
  const inventoryPath = join(resourcesPath, 'package-inventory.json')
  const inventoryBytes = await sha256File(inventoryPath)
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'))
  const inventoryPayload = {
    schema: 1,
    profile: inventory.profile,
    platform: inventory.platform,
    arch: inventory.arch,
    appVersion: inventory.appVersion,
    electronVersion: inventory.electronVersion,
    sourceCommit: inventory.sourceCommit,
    coreFiles: inventory.coreFiles.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
  }
  const computedInventoryIdentity = createHash('sha256').update(JSON.stringify(inventoryPayload), 'utf8').digest('hex')
  if (
    inventory.identity !== computedInventoryIdentity ||
    inventory.profile !== 'lean' ||
    inventory.platform !== platform ||
    inventory.arch !== options.arch
  )
    throw new Error('Packaged inventory identity or target binding is invalid')
  const inventoryCheck = validateInventoryMembers(inventory, appManifest, platform)
  if (inventoryCheck.failures.length)
    throw new Error(`Packaged inventory reconciliation failed: ${inventoryCheck.failures.length} mismatches`)
  const asarPath = join(resourcesPath, 'app.asar')
  const asar = await asarMemberInventory(payloadRoot, asarPath, join(resourcesPath, 'app.asar.unpacked'))
  const installer = await findInstaller(resolve(options.outputRoot), options.target === 'win' ? 'exe' : 'dmg')
  const installerIdentity = await sha256File(installer)
  const appTreeAfter = await walkTree(appRoot, { windowsPathRules: options.target === 'win' })
  if (appTreeAfter.manifestSha256 !== appManifest.manifestSha256)
    throw new Error('App tree changed between inventory and diagnostics')
  const payloadHead = (await run('git', ['-C', payloadRoot, 'rev-parse', 'HEAD'], { timeoutMs: 30_000 })).stdout.trim()
  const payloadStatus = await run('git', ['-C', payloadRoot, 'status', '--porcelain'], { timeoutMs: 30_000 })
  if (payloadHead !== PAYLOAD_SHA || payloadStatus.stdout.trim())
    throw new Error('Payload source checkout changed during preparation')
  report.payloadSource = { expectedSha: PAYLOAD_SHA, observedSha: payloadHead, clean: true }
  const packageJson = JSON.parse(await readFile(join(payloadRoot, 'package.json'), 'utf8'))
  const lockIdentity = await sha256File(join(payloadRoot, 'package-lock.json'))
  const builderPackage = JSON.parse(
    await readFile(join(payloadRoot, 'node_modules/electron-builder/package.json'), 'utf8')
  )
  const appBuilderPackage = JSON.parse(
    await readFile(join(payloadRoot, 'node_modules/app-builder-lib/package.json'), 'utf8')
  )
  if (builderPackage.version !== '26.15.3' || appBuilderPackage.version !== '26.15.3')
    throw new Error('Installed electron-builder/app-builder-lib versions differ from the reviewed pin')
  const electronPackage = JSON.parse(await readFile(join(payloadRoot, 'node_modules/electron/package.json'), 'utf8'))
  if (
    inventory.sourceCommit !== PAYLOAD_SHA ||
    inventory.appVersion !== packageJson.version ||
    inventory.electronVersion !== electronPackage.version
  )
    throw new Error('Packaged inventory source/version identity does not match rebuilt payload inputs')
  const npmCliPath = await locateNpmCli(payloadRoot)
  const npmVersion = npmCliPath
    ? await run(process.execPath, [npmCliPath, '--version'], { cwd: payloadRoot, timeoutMs: 60_000 }).catch(() => null)
    : process.platform === 'win32'
      ? await run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm --version'], {
          cwd: payloadRoot,
          timeoutMs: 60_000
        }).catch(() => null)
      : await run('npm', ['--version'], { cwd: payloadRoot, timeoutMs: 60_000 }).catch(() => null)
  const require = createRequire(join(payloadRoot, 'package.json'))
  const sevenZipPath = options.target === 'win' ? await find7za() : null
  let tools
  if (options.target === 'mac') {
    const hdiutilIdentity = { path: '/usr/bin/hdiutil', ...(await sha256File('/usr/bin/hdiutil')) }
    try {
      tools = { hdiutil: await hdiutilReadOnlyEvidence(run, redact, hdiutilIdentity) }
    } catch (error) {
      const result = error.result
      error.hdiutilMetadataProbe = result
        ? {
            command: result.command,
            args: result.args,
            exitCode: result.exitCode,
            signal: result.signal,
            stdout: redact(result.stdout ?? '').slice(0, 4000),
            stderr: redact(result.stderr ?? '').slice(0, 4000),
            timedOut: result.timedOut,
            outputLimitExceeded: result.outputLimitExceeded
          }
        : { command: '/usr/bin/hdiutil', args: ['info', '-plist'], failure: redact(error.message).slice(0, 4000) }
      throw error
    }
  } else tools = { sevenZipPath, sevenZipVersion: await run(sevenZipPath, ['i'], { timeoutMs: 30_000 }) }
  const managedNodeManifest = JSON.parse(
    await readFile(join(payloadRoot, 'src/shared/managed-node-manifest.json'), 'utf8')
  )
  const scriptFiles = [
    'scripts/fetch-managed-node.mjs',
    'scripts/check-ffmpeg-sidecar.mjs',
    'scripts/check-lean-package.mjs',
    'scripts/after-pack.mjs',
    'scripts/provision-electron-dist.mjs',
    'scripts/build-mac-helper.mjs',
    'scripts/check-mac-helper.mjs',
    'scripts/lib/package-inventory.mjs',
    'src/shared/managed-node-manifest.json',
    'resources/ffmpeg/manifest.json',
    'electron-builder.yml',
    'electron-builder.win.yml'
  ]
  const scriptDigests = {}
  for (const path of scriptFiles) {
    try {
      scriptDigests[path] = await sha256File(join(payloadRoot, path))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      scriptDigests[path] = { status: 'UNKNOWN-absent-for-target' }
    }
  }
  const toolBinaries = {
    buildNode: { path: process.execPath, ...(await sha256File(process.execPath)) },
    ...(npmCliPath
      ? { npmCli: { path: basename(npmCliPath), ...(await sha256File(npmCliPath)) } }
      : { npmCli: { status: 'UNKNOWN-cli-path-not-located' } }),
    electronBuilderEntry: {
      path: relative(payloadRoot, require.resolve('electron-builder')).split(sep).join('/'),
      ...(await sha256File(require.resolve('electron-builder')))
    },
    lockedAsarEntry: {
      path: relative(payloadRoot, require.resolve('@electron/asar')).split(sep).join('/'),
      ...(await sha256File(require.resolve('@electron/asar')))
    },
    ...(options.target === 'mac'
      ? { hdiutil: { path: '/usr/bin/hdiutil', ...(await sha256File('/usr/bin/hdiutil')) } }
      : {
          sevenZip: {
            path: relative(payloadRoot, sevenZipPath).split(sep).join('/'),
            ...(await sha256File(sevenZipPath))
          }
        })
  }
  report.sourceAndToolchain = {
    diagnosticCommit: options.diagnosticSha,
    payloadCommit: payloadHead,
    sourceDigests: {
      packageLock: lockIdentity,
      packageJson: await sha256File(join(payloadRoot, 'package.json')),
      builderConfig: await sha256File(
        join(payloadRoot, options.target === 'win' ? 'electron-builder.win.yml' : 'electron-builder.yml')
      ),
      measurementScript: await sha256File(join(payloadRoot, 'scripts/measure-lean-candidate.mjs')),
      packageInventory: inventoryBytes,
      scripts: scriptDigests
    },
    versions: {
      app: packageJson.version,
      electron: electronPackage.version,
      managedNode: managedNodeManifest.version,
      npm: npmVersion?.stdout.trim() ?? 'UNKNOWN',
      electronBuilder: builderPackage.version,
      appBuilderLib: appBuilderPackage.version,
      diagnosticNode: process.version,
      host: process.platform,
      hostArch: process.arch
    },
    tools,
    toolBinaries,
    host: { os: process.platform, osVersion: os.release(), architecture: os.arch() },
    packageInventory: {
      identity: inventory.identity,
      fileSha256: inventoryBytes.sha256,
      sourceCommit: inventory.sourceCommit,
      platform: inventory.platform,
      arch: inventory.arch,
      declaredCoreFiles: inventory.coreFiles.length,
      checkedCoreFiles: inventoryCheck.checked,
      limitedScope:
        'core package inventory excludes app.asar, Electron/app tree and named executables checked elsewhere; it is not the complete payload digest'
    },
    fetchedInputs: await fetchedInputInventory(payloadRoot, resourcesPath, options.target, options.arch)
  }
  report.app = {
    rootName: basename(appRoot),
    manifestSha256: appManifest.manifestSha256,
    portableManifestSha256: appManifest.portableManifestSha256,
    entries: appManifest.entries.length,
    totals: appManifest.totals,
    hardlinkGroups: appManifest.hardlinkGroups,
    packageInventoryReconciliation: inventoryCheck,
    partitions: accountPathGroups(appManifest, partitionManifest(appManifest, platform)),
    secondaryPathGroups: secondaryPathGroups(appManifest, platform),
    managedNodeChildren: accountPathGroups(appManifest, managedNodeChildren(appManifest, platform)),
    asar,
    duplicateFileIdentities: duplicateFiles(appManifest),
    manifestFile: 'app-manifest.json'
  }
  const notices = await collectNotices(payloadRoot, resourcesPath, appManifest, asar)
  report.shippedNoticesAndNpm = {
    noticesFile: 'package-notices.json',
    noticeFiles: notices.noticeFiles.length,
    managedNpmPackages: notices.managedNpmPackages.length,
    sbomNote: 'Observed package/license paths are not a complete legal SBOM; existing release/SBOM obligations remain.'
  }
  await writeFile(
    join(reportRoot, 'app-manifest.json'),
    `${JSON.stringify({ schema: 1, manifestSha256: appManifest.manifestSha256, portableManifestSha256: appManifest.portableManifestSha256, entries: appManifest.entries, totals: appManifest.totals, hardlinkGroups: appManifest.hardlinkGroups }, null, 2)}\n`,
    { flag: 'wx' }
  )
  await writeFile(join(reportRoot, 'asar-members.json'), `${JSON.stringify(asar, null, 2)}\n`, { flag: 'wx' })
  await writeFile(join(reportRoot, 'package-notices.json'), `${JSON.stringify(notices, null, 2)}\n`, { flag: 'wx' })
  report.finalInstaller = {
    name: relative(options.outputRoot, installer).split(sep).join('/'),
    ...installerIdentity,
    gate: { requiredBelowBytes: 150_000_000, verdict: installerIdentity.bytes < 150_000_000 ? 'PASS' : 'FAIL' }
  }
  report.builderCommands =
    options.target === 'win'
      ? {
          executable: 'npx',
          args: [
            'electron-builder',
            '--config',
            'electron-builder.win.yml',
            '--win',
            'nsis',
            '--x64',
            '-c.compression=maximum',
            '-c.nsis.differentialPackage=false',
            '-c.npmRebuild=false',
            '--publish',
            'never',
            `-c.directories.output=release/lean-attribution-${options.variant}`,
            '-c.artifactBuildCompleted=./build/lean-measurements/capture-lean-nsis-payload.mjs'
          ]
        }
      : {
          executable: 'npx',
          args: [
            'electron-builder',
            '--mac',
            'dmg',
            `--${options.arch}`,
            '-c.compression=maximum',
            '-c.dmg.format=UDBZ',
            '-c.npmRebuild=false',
            '-c.electronDist=resources/electron-dist',
            '--publish',
            'never',
            '-c.mac.identity=null',
            `-c.directories.output=release/lean-attribution-${options.variant}`
          ]
        }
  await writeFile(join(reportRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  const preProbe = await walkTree(appRoot, { windowsPathRules: options.target === 'win' })
  if (preProbe.manifestSha256 !== appManifest.manifestSha256) throw new Error('App tree changed before probes began')
  const context = { appRoot, appManifest, reportRoot, scratchRoot, installer, payloadRoot, report }
  if (options.target === 'win') await runWindowsDiagnostics(context, { run, redact })
  else await runMacDiagnostics(context)
  const postProbe = await walkTree(appRoot, { windowsPathRules: options.target === 'win' })
  if (postProbe.manifestSha256 !== appManifest.manifestSha256) throw new Error('App tree changed during probes')
  report.appTreeBeforeAfterProbe = {
    before: appManifest.manifestSha256,
    after: postProbe.manifestSha256,
    unchanged: true
  }
  report.attributionComplete = true
  report.status = 'complete'
  report.timestamps.endedAt = new Date().toISOString()
  await writeFile(join(reportRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  const manifestFile = await sha256File(join(reportRoot, 'app-manifest.json'))
  await writeFile(
    join(reportRoot, 'source-inputs.sha256'),
    `${manifestFile.sha256}  app-manifest.json\n${report.finalInstaller.sha256}  ${report.finalInstaller.name}\n${inventoryBytes.sha256}  package-inventory.json\n`
  )
  report.reportArtifactRoster = validateReportArtifactRoster(
    (await readdir(reportRoot, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name)
  )
  await writeFile(join(reportRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
}
function parseArgs(argv) {
  const [action, ...rest] = argv
  const values = {}
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    if (!key?.startsWith('--') || !rest[index + 1]) throw new Error('Arguments must be --name value pairs')
    values[key.slice(2)] = rest[index + 1]
  }
  return { action, values }
}
async function main() {
  const { action, values: v } = parseArgs(process.argv.slice(2))
  if (action === 'init') {
    await initialize({
      target: required(v.target, 'target'),
      arch: required(v.arch, 'arch'),
      variant: required(v.variant, 'matrix ID'),
      diagnosticSha: required(v['diagnostic-sha'], 'diagnostic SHA'),
      diagnosticRoot: required(v['diagnostic-root'], 'diagnostic root'),
      payloadRoot: required(v['payload-root'], 'payload root'),
      reportRoot: required(v['report-root'], 'report root'),
      scratchRoot: required(v['scratch-root'], 'scratch root')
    })
  } else if (action === 'prepare-capture') {
    await prepareCapture(
      resolve(required(v['payload-root'], 'payload root')),
      resolve(required(v['diagnostic-root'], 'diagnostic root')),
      resolve(required(v['report-root'], 'report root'))
    )
  } else if (action === 'collect') {
    const options = {
      target: required(v.target, 'target'),
      arch: required(v.arch, 'arch'),
      variant: required(v.variant, 'matrix ID'),
      diagnosticSha: required(v['diagnostic-sha'], 'diagnostic SHA'),
      diagnosticRoot: resolve(required(v['diagnostic-root'], 'diagnostic root')),
      payloadRoot: resolve(required(v['payload-root'], 'payload root')),
      reportRoot: resolve(required(v['report-root'], 'report root')),
      scratchRoot: resolve(required(v['scratch-root'], 'scratch root')),
      outputRoot: resolve(required(v['output-root'], 'output root'))
    }
    try {
      await collect(options)
    } catch (error) {
      const reportPath = join(options.reportRoot, 'report.json')
      let report = {}
      try {
        report = JSON.parse(await readFile(reportPath, 'utf8'))
      } catch {}
      report.status = 'incomplete'
      report.attributionComplete = false
      report.failures = [
        ...(report.failures ?? []),
        {
          message: redact(error.message),
          child: error.result
            ? {
                command: error.result.command,
                args: error.result.args,
                exitCode: error.result.exitCode,
                elapsedMs: error.result.elapsedMs,
                timedOut: error.result.timedOut
              }
            : null,
          ...(error.hdiutilMetadataProbe ? { hdiutilMetadataProbe: error.hdiutilMetadataProbe } : {})
        }
      ]
      report.timestamps ??= { startedAt: null }
      report.timestamps.endedAt = new Date().toISOString()
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
      throw error
    }
  } else if (action === 'native-smoke') {
    const target = required(v.target, 'target')
    if (!['mac', 'win'].includes(target)) throw new Error('Native smoke target is invalid')
    const reportRoot = resolve(required(v['report-root'], 'report root'))
    try {
      await nativeSmoke(
        target,
        resolve(required(v['payload-root'], 'payload root')),
        resolve(required(v['scratch-root'], 'scratch root')),
        reportRoot,
        run,
        redact
      )
    } catch (error) {
      const reportPath = join(reportRoot, 'native-smoke.json')
      let report = { schema: 1, platform: target }
      try {
        report = JSON.parse(await readFile(reportPath, 'utf8'))
      } catch {}
      const failure = boundedNativeSmokeFailure(error, redact)
      report.status = 'failed'
      const activeCase = report.cases?.find((item) => item.status === 'failed') ?? error.nativeSmokeEvidence ?? null
      report.failure = { ...failure, activeCase }
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
      const loggedFailure = {
        ...failure,
        result: failure.result
          ? {
              ...failure.result,
              stdout: failure.result.stdout.slice(0, 4000),
              stderr: failure.result.stderr.slice(0, 4000)
            }
          : null
      }
      process.stderr.write(`[${NONPROMOTABLE}] native-smoke failed: ${JSON.stringify(loggedFailure)}\n`)
      throw error
    }
  } else if (action === 'mark-incomplete') {
    const reportPath = join(resolve(required(v['report-root'], 'report root')), 'report.json')
    const report = JSON.parse(await readFile(reportPath, 'utf8'))
    if (report.attributionComplete !== true && report.status !== 'incomplete') {
      report.status = 'incomplete'
      report.failures = [...(report.failures ?? []), { message: redact(required(v.reason, 'failure reason')) }]
      report.timestamps.endedAt = new Date().toISOString()
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    }
  } else {
    throw new Error('Usage: lean-payload-attribution.mjs <init|prepare-capture|collect> --name value')
  }
}
main().catch((error) => {
  process.stderr.write(`[${NONPROMOTABLE}] ${redact(error.stack ?? error.message)}\n`)
  process.exitCode = 1
})
