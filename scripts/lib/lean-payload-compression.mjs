import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  classifyAppPath,
  copyProjection,
  digestPaths,
  expandProjectionPaths,
  managedNodeChildren,
  partitionManifest,
  sha256File,
  validateProbeRecord,
  walkTree
} from './lean-payload-attribution.mjs'

function archivePath(value) {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
  if (!normalized || normalized === '.') return ''
  if (
    normalized.startsWith('/') ||
    /^[a-z]:/i.test(normalized) ||
    normalized.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Unsafe archive member path: ${value}`)
  }
  return normalized
}

export function parse7zListing(text) {
  const boundary = /\r?\n----------\r?\n/.exec(text)
  if (!boundary) return { header: text, records: [] }
  const header = text.slice(0, boundary.index)
  const membersStart = boundary.index + boundary[0].length
  const membersText = text.slice(membersStart)
  const records = []
  for (const section of membersText.split(/\r?\n[ \t]*\r?\n+/)) {
    const record = {}
    for (const line of section.split(/\r?\n/)) {
      const index = line.indexOf(' = ')
      if (index > 0) record[line.slice(0, index)] = line.slice(index + 3)
    }
    if (record.Path) records.push(record)
  }
  return { header, records }
}

function listingProperties(text) {
  const properties = {}
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf(' = ')
    if (index > 0) properties[line.slice(0, index)] = line.slice(index + 3)
  }
  return properties
}

export function archiveMembers(slt) {
  const members = []
  const seen = new Set()
  const folded = new Set()
  for (const row of slt.records) {
    const path = archivePath(row.Path)
    if (!path) continue
    const lower = path.toLowerCase()
    if (seen.has(path) || folded.has(lower)) throw new Error(`Duplicate or case-colliding archive member: ${path}`)
    seen.add(path)
    folded.add(lower)
    const linkText = row['Symbolic Link'] ?? row['Symbolic Link Path'] ?? null
    const type = row.Folder === '+' ? 'directory' : linkText !== null ? 'symlink' : 'file'
    const bytes = type === 'directory' ? 0 : type === 'symlink' ? Buffer.byteLength(linkText) : Number(row.Size)
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`Invalid archive member byte count: ${path}`)
    members.push({ path, bytes, type, ...(type === 'symlink' ? { linkText } : {}) })
  }
  return members.sort((a, b) => a.path.localeCompare(b.path))
}

export function archiveCompression(slt) {
  const archive = listingProperties(slt.header)
  const member = slt.records.find((row) => row.Method || row.Block)
  const method = archive.Method ?? member?.Method ?? null
  const dictionary = method?.match(/(?:LZMA2?|PPMD):([^\s]+)/i)?.[1] ?? null
  const blockCount = Number(archive.Blocks)
  const memberBlock = Number(member?.Block)
  return {
    method,
    dictionary,
    solid: archive.Solid === '+' ? true : archive.Solid === '-' ? false : null,
    blocks: Number.isSafeInteger(blockCount) && blockCount >= 0 ? blockCount : null,
    memberMethod: member?.Method ?? null,
    memberBlock: Number.isSafeInteger(memberBlock) && memberBlock >= 0 ? memberBlock : null,
    memberCompression: slt.records
      .filter((row) => row.Method || row.Block)
      .map((row) => {
        const block = Number(row.Block)
        return {
          path: row.Path,
          method: row.Method ?? null,
          block: Number.isSafeInteger(block) && block >= 0 ? block : null
        }
      })
  }
}

export function sumRaw(entries) {
  return entries.reduce(
    (total, entry) =>
      total + (entry.type === 'file' ? entry.bytes : entry.type === 'symlink' ? entry.linkTextBytes : 0),
    0
  )
}

export function selectedEntries(manifest, paths) {
  const pathSet = new Set(paths)
  return manifest.entries.filter((entry) => pathSet.has(entry.path))
}

export function asarGroup(path) {
  return path.startsWith('out/main/')
    ? 'out/main'
    : path.startsWith('out/renderer/')
      ? 'renderer'
      : path.startsWith('node_modules/')
        ? 'production-packages'
        : 'other'
}

export function assertArchiveMembersMatch(expectedEntries, actualMembers, context) {
  const expected = expectedEntries
    .map((entry) => ({
      path: entry.path,
      type: entry.type,
      bytes: entry.type === 'directory' ? 0 : (entry.bytes ?? entry.linkTextBytes ?? 0),
      linkText: entry.type === 'symlink' ? entry.linkText : null
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const actual = actualMembers
    .map(({ path, type, bytes, linkText = null }) => ({ path, type, bytes, linkText }))
    .sort((a, b) => a.path.localeCompare(b.path))
  if (new Set(actual.map((entry) => entry.path)).size !== actual.length)
    throw new Error(`${context} archive contains duplicate members`)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const expectedPaths = new Set(expected.map((entry) => entry.path))
    const actualPaths = new Set(actual.map((entry) => entry.path))
    const missing = expected.filter((entry) => !actualPaths.has(entry.path)).map((entry) => entry.path)
    const unexpected = actual.filter((entry) => !expectedPaths.has(entry.path)).map((entry) => entry.path)
    const changed = expected.filter(
      (entry) =>
        actualPaths.has(entry.path) &&
        JSON.stringify(entry) !== JSON.stringify(actual.find((candidate) => candidate.path === entry.path))
    )
    throw new Error(
      `${context} archive member identity mismatch missing=${missing.length} unexpected=${unexpected.length} changed=${changed.length}`
    )
  }
  return { count: actual.length, rawBytes: actual.reduce((sum, entry) => sum + entry.bytes, 0) }
}

export function deriveNsisCustomFiles(entries, extensions) {
  if (
    !Array.isArray(extensions) ||
    extensions.some((extension) => typeof extension !== 'string' || !/^\.[a-z0-9]+$/i.test(extension))
  ) {
    throw new Error('Pinned NSIS target did not expose a valid pre-compressed extension list')
  }
  const normalized = extensions.map((extension) => (extension.startsWith('.') ? extension : `.${extension}`))
  const resourcesRootPresent = entries.some((entry) => entry.path === 'resources' && entry.type === 'directory')
  const direct = []
  for (const entry of entries) {
    if (entry.type !== 'file' || !entry.path.startsWith('resources/')) continue
    const parentSegments = entry.path.split('/').slice(0, -1)
    if (parentSegments.slice(1).some((segment) => segment === 'node_modules')) continue
    if (normalized.some((extension) => entry.path.endsWith(extension))) direct.push(entry)
  }
  return {
    extensions: normalized,
    files: direct.sort((a, b) => a.path.localeCompare(b.path)),
    missingResourcesRoot: !resourcesRootPresent
  }
}

export async function find7za() {
  const cacheRoot = process.env.LOCALAPPDATA
  if (!cacheRoot) throw new Error('LOCALAPPDATA is unavailable; cannot locate builder-resolved 7za')
  const base = join(cacheRoot, 'electron-builder', 'Cache', '7zip@1.0.0')
  const candidates = []
  async function visit(path, depth = 0) {
    if (depth > 5) return
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await visit(child, depth + 1)
      else if (entry.isFile() && /^7za\.exe$/i.test(entry.name)) candidates.push(child)
    }
  }
  await visit(base)
  if (candidates.length !== 1) throw new Error(`Expected one electron-builder cached 7za, found ${candidates.length}`)
  return candidates[0]
}

async function runWindowsProbe({
  id,
  sourceRoot,
  sourceManifest,
  entries,
  output,
  scratchRoot,
  sevenZip,
  reports,
  run,
  redact,
  baselineRefs = [],
  verifyExtractedContent = false
}) {
  const started = performance.now()
  const dir = join(scratchRoot, `projection-${id}`)
  const archive = join(scratchRoot, `probe-${id}.7z`)
  const extractionRoot = join(scratchRoot, `probe-extract-${id}`)
  const paths = entries.map((entry) => entry.path).sort()
  const record = {
    id,
    platformMethod: '7z solid LZMA2 actual standalone archive',
    inputManifestSha256: sourceManifest.manifestSha256,
    selectedPathListSha256: digestPaths(paths),
    excludedPathListSha256: digestPaths(
      sourceManifest.entries.filter((entry) => !paths.includes(entry.path)).map((entry) => entry.path)
    ),
    selectedPaths: paths,
    rawMemberBytes: sumRaw(entries),
    baselineRefs,
    command: null,
    outputBytes: null,
    outputSha256: null,
    elapsedMs: null,
    verified: false,
    status: 'running'
  }
  try {
    const projectionPaths = expandProjectionPaths(sourceManifest, paths)
    record.structuralParentPaths = projectionPaths.filter((path) => !paths.includes(path))
    const projection = await copyProjection(sourceRoot, dir, projectionPaths, sourceManifest.manifestSha256, {
      windowsPathRules: true
    })
    const cmd = ['a', '-bd', '-bb', '-mx=9', '-mtc=off', '-mtm=off', '-mta=off', archive, '.']
    const result = await run(sevenZip, cmd, { cwd: dir, timeoutMs: 60 * 60_000 })
    const list = await run(sevenZip, ['l', '-slt', archive], { cwd: scratchRoot, timeoutMs: 10 * 60_000 })
    const slt = parse7zListing(list.stdout)
    const memberList = archiveMembers(slt)
    const membership = assertArchiveMembersMatch(projection.entries, memberList, id)
    const tested = await run(sevenZip, ['t', archive], { cwd: scratchRoot, timeoutMs: 60 * 60_000 })
    if (verifyExtractedContent) {
      const extraction = await run(sevenZip, ['x', '-y', `-o${extractionRoot}`, archive], {
        cwd: scratchRoot,
        timeoutMs: 60 * 60_000
      })
      const extracted = await walkTree(extractionRoot, { windowsPathRules: true })
      const actualIdentity = extracted.entries
        .filter((entry) => entry.type !== 'directory')
        .map((entry) => ({
          path: entry.path,
          type: entry.type,
          bytes: entry.bytes ?? entry.linkTextBytes ?? 0,
          sha256: entry.sha256 ?? entry.linkTextSha256 ?? null
        }))
        .sort((a, b) => a.path.localeCompare(b.path))
      const expectedIdentity = projection.entries
        .filter((entry) => entry.type !== 'directory')
        .map((entry) => ({
          path: entry.path,
          type: entry.type,
          bytes: entry.bytes ?? entry.linkTextBytes ?? 0,
          sha256: entry.sha256 ?? entry.linkTextSha256 ?? null
        }))
        .sort((a, b) => a.path.localeCompare(b.path))
      if (JSON.stringify(actualIdentity) !== JSON.stringify(expectedIdentity))
        throw new Error(`${id} extracted file identities differ from the projected input manifest`)
      record.extractedContentMatchesProjection = true
      record.extractedMemberIdentitySha256 = createHash('sha256')
        .update(JSON.stringify(actualIdentity), 'utf8')
        .digest('hex')
      record.extractionCommand = { args: extraction.args, exitCode: extraction.exitCode }
    }
    const outputIdentity = await sha256File(archive)
    record.command = {
      ...result,
      stdout: '[native compressor stdout retained in workflow log]',
      stderr: redact(result.stderr)
    }
    record.archiveTest = { args: tested.args, exitCode: tested.exitCode }
    record.archiveMemberCount = membership.count
    record.outputBytes = outputIdentity.bytes
    record.outputSha256 = outputIdentity.sha256
    record.compression = archiveCompression(slt)
    record.archiveMembers = memberList
    record.elapsedMs = Math.round(performance.now() - started)
    record.verified = true
    record.status = 'complete'
    validateProbeRecord(record)
    await writeFile(join(output, `probe-${id}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
    reports.push(record)
    return record
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(extractionRoot, { recursive: true, force: true })
    await rm(archive, { force: true })
  }
}

export async function attachMarginal(record, baseline, reportRoot, baselineId = 'full-control-before') {
  record.marginal = {
    definition: 'C(full control) - C(full with this exact set omitted)',
    baselineProbeId: baselineId,
    baselineBytes: baseline.outputBytes,
    leaveOutBytes: record.outputBytes,
    marginalBytes: baseline.outputBytes - record.outputBytes,
    interpretation:
      'Measured marginal for these two actual outputs only; negative values are retained and no delta is allocated additively.'
  }
  await writeFile(join(reportRoot, `probe-${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`)
}

export async function runWindowsDiagnostics(context, { run, redact }) {
  const { appRoot, appManifest, reportRoot, scratchRoot, installer, payloadRoot, report } = context
  const sevenZip = await find7za()
  const sevenZipIdentity = await sha256File(sevenZip)
  const version = await run(sevenZip, ['i'], { timeoutMs: 60_000 })
  const archivePathname = join(scratchRoot, 'builder-nsis.7z')
  const capture = JSON.parse(await readFile(join(reportRoot, 'windows-archive-capture.json'), 'utf8'))
  const captured = await sha256File(archivePathname)
  if (captured.bytes !== capture.archiveBytes || captured.sha256 !== capture.archiveSha256)
    throw new Error('Captured NSIS archive identity differs from observer record')
  const listing = await run(sevenZip, ['l', '-slt', archivePathname], { cwd: scratchRoot, timeoutMs: 10 * 60_000 })
  const slt = parse7zListing(listing.stdout)
  const members = archiveMembers(slt)
  const appFiles = appManifest.entries.filter((entry) => entry.type === 'file')
  const direct = deriveNsisCustomFiles(appManifest.entries, capture.preCompressedFileExtensions)
  if (direct.missingResourcesRoot) throw new Error('Builder resources root is absent from app manifest')
  const directFiles = direct.files
  const builderArchivePath = join(dirname(appRoot), capture.archiveName)
  const builderArchiveArgs = [
    'a',
    '-bd',
    '-bb',
    '-mx=9',
    '-mtc=off',
    '-mtm=off',
    '-mta=off',
    builderArchivePath,
    '.',
    ...direct.extensions.map((extension) => `-xr!*${extension}`)
  ]
  const memberPaths = new Set(members.map((member) => member.path))
  const directPaths = new Set(directFiles.map((entry) => entry.path))
  const expectedArchiveEntries = appManifest.entries.filter((entry) => !directPaths.has(entry.path))
  const archiveMembership = assertArchiveMembersMatch(expectedArchiveEntries, members, 'builder NSIS 7z')
  const unexpectedExcluded = appFiles
    .filter((entry) => !memberPaths.has(entry.path) && !directPaths.has(entry.path))
    .map((entry) => entry.path)
  const directStillArchived = directFiles.filter((entry) => memberPaths.has(entry.path)).map((entry) => entry.path)
  if (unexpectedExcluded.length || directStillArchived.length)
    throw new Error(
      `Builder archive/direct stream reconciliation failed unexplained=${unexpectedExcluded.length} overlap=${directStillArchived.length}`
    )
  const archiveTest = await run(sevenZip, ['t', archivePathname], { cwd: scratchRoot, timeoutMs: 60 * 60_000 })
  const extractionRoot = join(scratchRoot, 'archive-identity-check')
  const extraction = await run(sevenZip, ['x', '-y', `-o${extractionRoot}`, archivePathname], {
    cwd: scratchRoot,
    timeoutMs: 60 * 60_000
  })
  const extracted = await walkTree(extractionRoot, { windowsPathRules: true })
  const extractedFiles = extracted.entries.filter((entry) => entry.type !== 'directory')
  const expectedIdentity = expectedArchiveEntries
    .filter((entry) => entry.type !== 'directory')
    .map((entry) => ({
      path: entry.path,
      type: entry.type,
      bytes: entry.bytes ?? entry.linkTextBytes ?? 0,
      sha256: entry.sha256 ?? entry.linkTextSha256 ?? null
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const extractedIdentity = extractedFiles
    .map((entry) => ({
      path: entry.path,
      type: entry.type,
      bytes: entry.bytes ?? entry.linkTextBytes ?? 0,
      sha256: entry.sha256 ?? entry.linkTextSha256 ?? null
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
  if (JSON.stringify(extractedIdentity) !== JSON.stringify(expectedIdentity))
    throw new Error('Builder archive extracted file identities do not match the app manifest')
  await rm(extractionRoot, { recursive: true, force: true })
  const components = partitionManifest(appManifest, 'win32')
  const nodeChildren = managedNodeChildren(appManifest, 'win32')
  const probes = []
  const full = members.map((member) => appManifest.entries.find((entry) => entry.path === member.path))
  const fullBefore = await runWindowsProbe({
    id: 'full-control-before',
    sourceRoot: appRoot,
    sourceManifest: appManifest,
    entries: full,
    output: reportRoot,
    scratchRoot,
    sevenZip,
    reports: probes,
    run,
    redact,
    verifyExtractedContent: true
  })
  const groups = Object.entries(components)
    .map(([name, paths]) => [`component-${name}`, paths.filter((path) => memberPaths.has(path))])
    .filter(([, paths]) => paths.length > 0)
  for (const [name, paths] of Object.entries(nodeChildren))
    groups.push([`managed-node-${name}`, paths.filter((path) => memberPaths.has(path))])
  const standaloneProbeCount = groups.filter(([, paths]) => paths.length > 0).length
  if (standaloneProbeCount > 20)
    throw new Error(`Windows standalone probe roster exceeds 20 sets: ${standaloneProbeCount}`)
  for (const [name, paths] of groups) {
    if (!paths.length) continue
    const unique = [...new Set(paths)].sort()
    const id = name.replace(/[^a-z0-9-]/gi, '-')
    await runWindowsProbe({
      id,
      sourceRoot: appRoot,
      sourceManifest: appManifest,
      entries: selectedEntries(appManifest, unique),
      output: reportRoot,
      scratchRoot,
      sevenZip,
      reports: probes,
      run,
      redact,
      baselineRefs: ['full-control-before']
    })
  }
  const nodePaths = appManifest.entries
    .filter((entry) => classifyAppPath(entry.path, 'win32') === 'managed-node' && memberPaths.has(entry.path))
    .map((entry) => entry.path)
  const docPaths = nodeChildren.docs.filter((path) => memberPaths.has(path))
  const notApplicable = []
  for (const [id, omit] of [
    ['full-minus-managed-node', nodePaths],
    ['full-minus-node-docs', docPaths]
  ]) {
    if (!omit.length) {
      notApplicable.push({
        id,
        status: 'not-applicable',
        reason: 'The exact selected member set is empty for this platform/tree.'
      })
      continue
    }
    const omitted = new Set(omit)
    const included = full.filter((entry) => !omitted.has(entry.path))
    const leaveOut = await runWindowsProbe({
      id,
      sourceRoot: appRoot,
      sourceManifest: appManifest,
      entries: included,
      output: reportRoot,
      scratchRoot,
      sevenZip,
      reports: probes,
      run,
      redact,
      baselineRefs: ['full-control-before']
    })
    await attachMarginal(leaveOut, fullBefore, reportRoot)
  }
  const fullAfter = await runWindowsProbe({
    id: 'full-control-after',
    sourceRoot: appRoot,
    sourceManifest: appManifest,
    entries: full,
    output: reportRoot,
    scratchRoot,
    sevenZip,
    reports: probes,
    run,
    redact,
    baselineRefs: ['full-control-before']
  })
  const controlRepeat =
    fullBefore.outputBytes !== fullAfter.outputBytes
      ? await runWindowsProbe({
          id: 'full-control-repeat',
          sourceRoot: appRoot,
          sourceManifest: appManifest,
          entries: full,
          output: reportRoot,
          scratchRoot,
          sevenZip,
          reports: probes,
          run,
          redact,
          baselineRefs: ['full-control-before', 'full-control-after']
        })
      : null
  const installerBytes = (await sha256File(installer)).bytes
  const nsisTargetSource = join(payloadRoot, 'node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js')
  const archiveBuilderSource = join(payloadRoot, 'node_modules/app-builder-lib/out/targets/archive.js')
  report.windows = {
    sevenZip: {
      path: relative(payloadRoot, sevenZip).split(sep).join('/'),
      ...sevenZipIdentity,
      versionOutput: redact(version.stdout)
    },
    builderArchiveInvocation: {
      executable: sevenZip,
      args: builderArchiveArgs,
      cwd: appRoot,
      source:
        'Pinned app-builder-lib out/targets/archive.js command construction plus captured resolved NSIS target options; archive bytes and member roster below are the actual completed builder output.',
      archiveBuilderSource: {
        path: relative(payloadRoot, archiveBuilderSource).split(sep).join('/'),
        ...(await sha256File(archiveBuilderSource))
      }
    },
    actualBuilderArchive: {
      ...captured,
      archiveRawMemberBytes: archiveMembership.rawBytes,
      compression: archiveCompression(slt),
      memberCount: members.length,
      members,
      archiveTest: { args: archiveTest.args, exitCode: archiveTest.exitCode },
      extractedContentMatchesManifest: true
    },
    sameMembershipControl: {
      builderArchiveSha256: captured.sha256,
      controlSha256: fullBefore.outputSha256,
      builderBytes: captured.bytes,
      controlBytes: fullBefore.outputBytes,
      matchedBytes: captured.sha256 === fullBefore.outputSha256,
      note: 'The exact observed builder member list was rebuilt with the same 7za method/flags; byte differences remain representativeness uncertainty.'
    },
    directNsisStream: {
      source:
        'Derived from context.target.options.preCompressedFileExtensions and the pinned 26.15.3 generateForPreCompressed resources walk; its exact member set reconciles to the complement of actual archive members.',
      appBuilderLibNsisTarget: {
        path: relative(payloadRoot, nsisTargetSource).split(sep).join('/'),
        ...(await sha256File(nsisTargetSource))
      },
      effectivePreCompressedFileExtensions: direct.extensions,
      exclusionArguments: direct.extensions.map((extension) => `-xr!*${extension}`),
      files: directFiles.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
      rawBytes: sumRaw(directFiles),
      membershipReconciled: true
    },
    accounting: {
      installerBytes,
      archiveBytes: captured.bytes,
      archiveRawMemberBytes: archiveMembership.rawBytes,
      directNsisRawBytes: sumRaw(directFiles),
      installerMinusArchiveBytes: installerBytes - captured.bytes,
      installerMinusArchiveAndDirectRawBytes: installerBytes - captured.bytes - sumRaw(directFiles),
      unexplainedRemainder:
        'Derived remainder only; NSIS generated script/log/data/header contributions were not isolated; installer-minus-archive is not stub overhead.'
    },
    treeRawBytes: sumRaw(appManifest.entries),
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
    controlExtractionCommand: {
      ...extraction,
      stdout: '[archive identity extraction output omitted]',
      stderr: redact(extraction.stderr)
    },
    mandatoryNoDoubleCountNote:
      'Standalone sizes and marginal values do not add to installer size; direct NSIS media remains unchanged across archive probes.'
  }
  if (standaloneProbeCount === 0) throw new Error('Windows standalone probe roster is empty')
}

export async function runMacProbe({
  id,
  sourceRoot,
  sourceManifest,
  entries,
  scratchRoot,
  output,
  reports,
  baselineRefs = [],
  run,
  redact
}) {
  const started = performance.now()
  const projectionRoot = join(scratchRoot, `projection-${id}`)
  const appName = basename(sourceRoot)
  const appProjection = join(projectionRoot, appName)
  const rawImage = join(scratchRoot, `raw-${id}.dmg`)
  const image = join(scratchRoot, `probe-${id}.dmg`)
  const paths = entries.map((entry) => entry.path).sort()
  const record = {
    id,
    platformMethod: 'hdiutil HFS+ UDBZ diagnostic container',
    inputManifestSha256: sourceManifest.manifestSha256,
    selectedPathListSha256: digestPaths(paths),
    excludedPathListSha256: digestPaths(
      sourceManifest.entries.filter((entry) => !paths.includes(entry.path)).map((entry) => entry.path)
    ),
    selectedPaths: paths,
    rawMemberBytes: sumRaw(entries),
    baselineRefs,
    commands: [],
    outputBytes: null,
    outputSha256: null,
    outputAllocatedBytes: null,
    elapsedMs: null,
    verified: false,
    status: 'running'
  }
  try {
    await mkdir(projectionRoot, { recursive: false })
    const projectionPaths = expandProjectionPaths(sourceManifest, paths)
    record.structuralParentPaths = projectionPaths.filter((path) => !paths.includes(path))
    if (paths.length) await copyProjection(sourceRoot, appProjection, projectionPaths, sourceManifest.manifestSha256)
    const create = await run(
      'hdiutil',
      [
        'create',
        '-ov',
        '-fs',
        'HFS+',
        '-volname',
        'METIS_ATTRIBUTION_NONPROMOTABLE',
        '-srcfolder',
        projectionRoot,
        '-format',
        'UDRW',
        rawImage
      ],
      { timeoutMs: 60 * 60_000 }
    )
    const rawIdentity = await sha256File(rawImage)
    const rawStat = await stat(rawImage, { bigint: true })
    const convert = await run('hdiutil', ['convert', rawImage, '-format', 'UDBZ', '-o', image], {
      timeoutMs: 60 * 60_000
    })
    const rawAfterConvert = await sha256File(rawImage)
    if (rawIdentity.bytes !== rawAfterConvert.bytes || rawIdentity.sha256 !== rawAfterConvert.sha256)
      throw new Error(`UDRW source changed during conversion: ${id}`)
    const verify = await run('hdiutil', ['verify', image], { timeoutMs: 10 * 60_000 })
    record.commands = [create, convert, verify].map((item) => ({
      ...item,
      stdout: redact(item.stdout),
      stderr: redact(item.stderr)
    }))
    record.rawImage = {
      ...rawIdentity,
      allocatedBytes: Number(rawStat.blocks * 512n),
      digestUnchangedThroughConversion: true
    }
    const identity = await sha256File(image)
    const imageStat = await stat(image, { bigint: true })
    record.outputBytes = identity.bytes
    record.outputSha256 = identity.sha256
    record.outputAllocatedBytes = Number(imageStat.blocks * 512n)
    record.elapsedMs = Math.round(performance.now() - started)
    record.verified = true
    record.status = 'complete'
    validateProbeRecord(record)
    await writeFile(join(output, `probe-${id}.json`), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
    reports.push(record)
    return record
  } finally {
    await rm(projectionRoot, { recursive: true, force: true })
    await rm(rawImage, { force: true })
    await rm(image, { force: true })
  }
}

export async function nativeSmoke(target, payloadRoot, scratchRoot, reportRoot, run, redact) {
  const root = join(scratchRoot, 'native-smoke')
  await mkdir(root, { recursive: false })
  const repeated = 'shared-compressible-attribution-fixture\n'.repeat(8192)
  await writeFile(join(root, 'left.txt'), repeated)
  await writeFile(join(root, 'right.txt'), repeated)
  const records = []
  if (target === 'win') {
    const sevenZip = await find7za()
    const identity = await sha256File(sevenZip)
    const versions = await run(sevenZip, ['i'], { timeoutMs: 60_000 })
    for (const [name, members] of [
      ['shared', ['left.txt', 'right.txt']],
      ['left', ['left.txt']],
      ['right', ['right.txt']]
    ]) {
      const archive = join(root, `${name}.7z`)
      const created = await run(
        sevenZip,
        ['a', '-bd', '-bb', '-mx=9', '-mtc=off', '-mtm=off', '-mta=off', archive, ...members],
        { cwd: root, timeoutMs: 5 * 60_000 }
      )
      const tested = await run(sevenZip, ['t', archive], { cwd: root, timeoutMs: 5 * 60_000 })
      const output = await sha256File(archive)
      records.push({
        name,
        bytes: output.bytes,
        sha256: output.sha256,
        create: { args: created.args, elapsedMs: created.elapsedMs },
        verify: { args: tested.args, exitCode: tested.exitCode }
      })
      await rm(archive, { force: true })
    }
    await writeFile(
      join(reportRoot, 'native-smoke.json'),
      `${JSON.stringify({ schema: 1, platform: target, tool: { path: relative(payloadRoot, sevenZip).split(sep).join('/'), ...identity }, version: redact(versions.stdout), cases: records, note: 'Shared compressible fixture bytes are intentionally repeated. Actual standalone and joint compressor outputs are evidence of shared coding behavior; their sizes are not per-file additive contributions.' }, null, 2)}\n`,
      { flag: 'wx' }
    )
  } else {
    for (const [name, members] of [
      ['shared', ['left.txt', 'right.txt']],
      ['left', ['left.txt']],
      ['right', ['right.txt']]
    ]) {
      const projection = join(root, `${name}-src`)
      const input = join(root, `${name}-raw.dmg`)
      const image = join(root, `${name}.dmg`)
      await mkdir(projection, { recursive: false })
      for (const member of members) await writeFile(join(projection, member), await readFile(join(root, member)))
      const create = await run(
        'hdiutil',
        [
          'create',
          '-ov',
          '-fs',
          'HFS+',
          '-volname',
          'METIS_ATTRIBUTION_SMOKE',
          '-srcfolder',
          projection,
          '-format',
          'UDRW',
          input
        ],
        { timeoutMs: 5 * 60_000 }
      )
      const convert = await run('hdiutil', ['convert', input, '-format', 'UDBZ', '-o', image], {
        timeoutMs: 5 * 60_000
      })
      const verify = await run('hdiutil', ['verify', image], { timeoutMs: 5 * 60_000 })
      const output = await sha256File(image)
      records.push({
        name,
        bytes: output.bytes,
        sha256: output.sha256,
        createArgs: create.args,
        convertArgs: convert.args,
        verified: verify.exitCode === 0
      })
      await rm(projection, { recursive: true, force: true })
      await rm(input, { force: true })
      await rm(image, { force: true })
    }
    const toolVersion = await run('hdiutil', ['-version'], { timeoutMs: 30_000 })
    await writeFile(
      join(reportRoot, 'native-smoke.json'),
      `${JSON.stringify({ schema: 1, platform: target, toolVersion: toolVersion.stdout.trim(), cases: records, note: 'Shared compressible fixture bytes are intentionally repeated. Actual standalone and joint container outputs are evidence of shared coding behavior; their sizes are not per-file additive contributions.' }, null, 2)}\n`,
      { flag: 'wx' }
    )
  }
  await rm(root, { recursive: true, force: true })
}
