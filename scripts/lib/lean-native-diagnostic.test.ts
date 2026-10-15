import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runDiagnosticChild } from './lean-diagnostic-child.mjs'
import { withOwnedMacImage } from './lean-mac-image.mjs'
import { asarMemberInventory } from './lean-payload-inventory.mjs'
import {
  hdiutilReadOnlyEvidence,
  nativeSmoke,
  runMacProbe,
  runWindowsDiagnostics
} from './lean-payload-compression.mjs'
import { sha256File, validateReportArtifactRoster, walkTree } from './lean-payload-attribution.mjs'

const roots: string[] = []
const require = createRequire(import.meta.url)
const plist = require('plist')

async function temporaryRoot() {
  const path = await mkdtemp(join(tmpdir(), 'lean-native-diagnostic-'))
  roots.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function info(images: unknown[] = []) {
  return plist.build({ images })
}

function result(command: string, args: string[], stdout = '') {
  return {
    command,
    args,
    cwd: undefined,
    exitCode: 0,
    signal: null,
    elapsedMs: 1,
    stdout,
    stderr: '',
    timedOut: false,
    outputLimitExceeded: false
  }
}

function imageRunner({
  onInfo = () => info(),
  onConvert
}: {
  onInfo?: (args: string[]) => string
  onConvert?: (raw: string, output: string) => Promise<void>
} = {}) {
  const commands: Array<{ command: string; args: string[] }> = []
  const run = async (command: string, args: string[], _options?: unknown) => {
    commands.push({ command, args: [...args] })
    if (args[0] === 'info') return result(command, args, onInfo(args))
    if (args[0] === 'create') {
      await writeFile(args.at(-1)!, 'raw image identity')
      return result(command, args)
    }
    if (args[0] === 'convert') {
      const raw = args[1]
      const output = args[args.indexOf('-o') + 1]
      if (onConvert) await onConvert(raw, output)
      else await copyFile(raw, output)
      return result(command, args)
    }
    if (args[0] === 'verify') return result(command, args)
    throw new Error(`Unexpected command ${args.join(' ')}`)
  }
  return { commands, run }
}

describe('lean native diagnostic contracts', () => {
  it('reads a real locked-ASAR scoped license with canonical nested packed and unpacked inventory', async () => {
    const root = await temporaryRoot()
    const source = join(root, 'source')
    const archive = join(root, 'fixture.asar')
    const license = Buffer.from('Scoped package license\nCopyright 2026\n')
    await mkdir(join(source, 'node_modules', '@scope', 'pkg', 'dist'), { recursive: true })
    await writeFile(join(source, 'node_modules', '@scope', 'pkg', 'LICENSE'), license)
    await writeFile(join(source, 'node_modules', '@scope', 'pkg', 'dist', 'index.js'), 'packed nested file')
    await writeFile(join(source, 'node_modules', '@scope', 'pkg', 'native.bin'), Buffer.from([0, 1, 2, 3, 255]))
    const asar = require('@electron/asar')
    const asarPackage = JSON.parse(
      await readFile(join(process.cwd(), 'node_modules/@electron/asar/package.json'), 'utf8')
    )
    expect(asarPackage.version).toBe('3.4.1')
    await asar.createPackageWithOptions(source, archive, { unpack: '**/native.bin' })
    const inventory = await asarMemberInventory(process.cwd(), archive, `${archive}.unpacked`)
    expect(asar.extractFile(archive, join('node_modules', '@scope', 'pkg', 'LICENSE'))).toEqual(license)
    const members = inventory.members
    const licenseMember = members.find((member: { path: string }) => member.path === 'node_modules/@scope/pkg/LICENSE')
    expect(licenseMember).toMatchObject({
      bytes: license.length,
      sha256: createHash('sha256').update(license).digest('hex'),
      packed: true,
      unpacked: false
    })
    expect(members.map((member: { path: string }) => member.path)).toEqual([
      'node_modules',
      'node_modules/@scope',
      'node_modules/@scope/pkg',
      'node_modules/@scope/pkg/LICENSE',
      'node_modules/@scope/pkg/dist',
      'node_modules/@scope/pkg/dist/index.js',
      'node_modules/@scope/pkg/native.bin'
    ])
    expect(members.find((member: { path: string }) => member.path.endsWith('/native.bin'))).toMatchObject({
      bytes: 5,
      sha256: createHash('sha256')
        .update(Buffer.from([0, 1, 2, 3, 255]))
        .digest('hex'),
      packed: false,
      unpacked: true
    })
    expect(inventory.unpackedTree.totals.regularFileBytes).toBe(5)
    const unpackedTree = await walkTree(`${archive}.unpacked`)
    expect(inventory.unpackedTree.manifestSha256).toBe(unpackedTree.manifestSha256)
  })

  it('uses distinct owned names and directories and preserves HFS+ UDRW UDBZ identity evidence', async () => {
    const root = await temporaryRoot()
    const payloadRoot = join(root, 'payload')
    const scratch = join(root, 'scratch')
    await mkdir(payloadRoot)
    await writeFile(join(payloadRoot, 'package.json'), '{}')
    await mkdir(scratch)
    let randomValue = 1
    const { commands, run } = imageRunner()
    const make = (caseId: string) =>
      withOwnedMacImage({
        payloadRoot: process.cwd(),
        scratchRoot: scratch,
        caseId,
        randomBytesImpl: (size: number) => Buffer.alloc(size, randomValue++),
        prepareProjection: async (projection: string) => writeFile(join(projection, 'fixture.txt'), caseId),
        run
      })
    const first = await make('first')
    const second = await make('second')
    expect(first.raw).toBeDefined()
    expect(first.output).toBeDefined()
    if (!first.raw || !first.output) throw new Error('Expected raw and converted image identity evidence')
    expect(first.volumeName).not.toBe(second.volumeName)
    expect(first.volumeName).toMatch(/^METIS_A_[0-9a-f]{24}$/)
    expect(second.volumeName).toMatch(/^METIS_A_[0-9a-f]{24}$/)
    expect(first.ownedDirectory).not.toBe(second.ownedDirectory)
    expect(first.raw).toMatchObject({ bytes: 'raw image identity'.length, unchangedThroughConversion: true })
    expect(first.output.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(first.cleanup).toMatchObject({ status: 'complete', directoryRemoved: true })
    const creates = commands.filter((command) => command.args[0] === 'create')
    expect(creates[0].args).toEqual([
      'create',
      '-ov',
      '-fs',
      'HFS+',
      '-volname',
      first.volumeName,
      '-srcfolder',
      first.projectionPath,
      '-format',
      'UDRW',
      first.rawImagePath
    ])
    expect(creates[1].args).toEqual([
      'create',
      '-ov',
      '-fs',
      'HFS+',
      '-volname',
      second.volumeName,
      '-srcfolder',
      second.projectionPath,
      '-format',
      'UDRW',
      second.rawImagePath
    ])
    expect(commands.find((command) => command.args[0] === 'convert')?.args).toEqual([
      'convert',
      first.rawImagePath,
      '-format',
      'UDBZ',
      '-o',
      first.outputImagePath
    ])
    expect(commands.findIndex((command) => command.args[0] === 'verify')).toBeGreaterThan(
      commands.findIndex((command) => command.args[0] === 'convert')
    )
  })

  it('waits for its exact attachment and ignores an unrelated same-label image without detaching', async () => {
    const root = await temporaryRoot()
    const payloadRoot = join(root, 'payload')
    const scratch = join(root, 'scratch')
    await mkdir(payloadRoot)
    await writeFile(join(payloadRoot, 'package.json'), '{}')
    await mkdir(scratch)
    let snapshots = 0
    let ownerRaw = ''
    const { commands, run: baseRun } = imageRunner({
      onInfo: () => {
        snapshots += 1
        return info(
          snapshots === 1
            ? [
                { 'image-path': ownerRaw, 'system-entities': [{ 'volume-name': 'METIS_A_same' }] },
                { 'image-path': '/tmp/unrelated-image.dmg', 'system-entities': [{ 'volume-name': 'METIS_A_same' }] }
              ]
            : [{ 'image-path': '/tmp/unrelated-image.dmg', 'system-entities': [{ 'volume-name': 'METIS_A_same' }] }]
        )
      }
    })
    const run = async (command: string, args: string[], options: unknown) => {
      if (args[0] === 'create') ownerRaw = args.at(-1)!
      return baseRun(command, args, options)
    }
    let advancedToConvert = false
    const evidence = await withOwnedMacImage({
      payloadRoot: process.cwd(),
      scratchRoot: scratch,
      caseId: 'settles',
      prepareProjection: async (projection: string) => writeFile(join(projection, 'fixture'), 'bytes'),
      run: async (command: string, args: string[], options: unknown) => {
        if (args[0] === 'convert') advancedToConvert = snapshots >= 3
        return run(command, args, options)
      }
    })
    expect(snapshots).toBeGreaterThanOrEqual(3)
    expect(advancedToConvert).toBe(true)
    expect(evidence.cleanup.status).toBe('complete')
    expect(commands.every((command) => command.args[0] !== 'detach' && command.args[0] !== 'unmount')).toBe(true)
  })

  it('retains pending ownership on a persistent attachment and malformed info without retrying create', async () => {
    const runScenario = async (caseId: string, malformed: boolean) => {
      const root = await temporaryRoot()
      const payloadRoot = join(root, 'payload')
      const scratch = join(root, 'scratch')
      await mkdir(payloadRoot)
      await writeFile(join(payloadRoot, 'package.json'), '{}')
      await mkdir(scratch)
      let rawPath = ''
      let tick = 0
      const { commands, run: baseRun } = imageRunner({
        onInfo: () => (malformed ? '<broken plist' : info([{ 'image-path': rawPath, 'system-entities': [] }]))
      })
      const run = async (command: string, args: string[], options: unknown) => {
        if (args[0] === 'create') rawPath = args.at(-1)!
        return baseRun(command, args, options)
      }
      let captured: any
      let nextCaseStarted = false
      try {
        await withOwnedMacImage({
          payloadRoot: process.cwd(),
          scratchRoot: scratch,
          caseId,
          prepareProjection: async () => {},
          run,
          now: () => tick,
          delay: async (milliseconds: number) => {
            tick += milliseconds
          }
        })
        nextCaseStarted = true
        await withOwnedMacImage({
          payloadRoot: process.cwd(),
          scratchRoot: scratch,
          caseId: `${caseId}-next`,
          prepareProjection: async () => {},
          run
        })
      } catch (error) {
        captured = error
      }
      expect(nextCaseStarted).toBe(false)
      expect(captured.evidence.cleanup.status).toBe('pending')
      expect(captured.evidence.cleanup.directoryRetained).toBe(true)
      expect(commands.filter((command) => command.args[0] === 'create')).toHaveLength(1)
      expect(commands.some((command) => command.args[0] === 'convert' || command.args[0] === 'detach')).toBe(false)
      expect(tick).toBeGreaterThanOrEqual(malformed ? 0 : 20_000)
    }
    await runScenario('persistent', false)
    await runScenario('malformed', true)
  })

  it('retains two completed smoke cases and the exact third Resource busy create failure', async () => {
    const root = await temporaryRoot()
    const payloadRoot = join(root, 'payload')
    const scratch = join(root, 'scratch')
    const reports = join(root, 'reports')
    await mkdir(payloadRoot)
    await writeFile(join(payloadRoot, 'package.json'), '{}')
    await mkdir(scratch)
    await mkdir(reports)
    const hdiutilPath = join(root, 'hdiutil-fixture')
    await writeFile(hdiutilPath, 'fixture hdiutil executable')
    let creates = 0
    const { commands, run: baseRun } = imageRunner()
    const run = async (command: string, args: string[], options: unknown) => {
      if (args[0] === 'create' && ++creates === 3) {
        const failure = result(command, args, '')
        Object.assign(failure, { exitCode: 1, stderr: 'hdiutil: create failed - Resource busy' })
        throw Object.assign(new Error('Command failed: hdiutil (1)'), { result: failure })
      }
      return baseRun(command, args, options)
    }
    let failure: any
    try {
      await nativeSmoke('mac', process.cwd(), scratch, reports, run, String, hdiutilPath)
    } catch (error) {
      failure = error
    }
    const report = JSON.parse(await readFile(join(reports, 'native-smoke.json'), 'utf8'))
    expect(report.status).toBe('failed')
    expect(report.cases.map((item: { name: string; status: string }) => [item.name, item.status])).toEqual([
      ['shared', 'complete'],
      ['left', 'complete'],
      ['right', 'failed']
    ])
    expect(report.failure.commands.find((item: { args: string[] }) => item.args[0] === 'create').stderr).toContain(
      'Resource busy'
    )
    expect(report.cases[2].commands.find((item: { args: string[] }) => item.args[0] === 'create').exitCode).toBe(1)
    expect(report.cases[2].cleanup.status).toBe('complete')
    expect(creates).toBe(3)
    expect(commands.some((command) => command.args[0] === '-version')).toBe(false)
    expect(failure.result.exitCode).toBe(1)
  })

  it('records supported read-only hdiutil evidence and rejects a failed metadata command', async () => {
    const root = await temporaryRoot()
    const hdiutilPath = join(root, 'hdiutil-fixture')
    await writeFile(hdiutilPath, 'fixture hdiutil executable')
    const { run } = imageRunner()
    const toolIdentity = { path: hdiutilPath, ...(await sha256File(hdiutilPath)) }
    const evidence = await hdiutilReadOnlyEvidence(run, String, toolIdentity)
    expect(evidence.tool).toMatchObject(toolIdentity)
    expect(evidence.readOnlyProbe).toMatchObject({
      command: hdiutilPath,
      args: ['info', '-plist'],
      exitCode: 0,
      timedOut: false,
      outputLimitExceeded: false
    })

    const failedProbe = result(hdiutilPath, ['info', '-plist'])
    Object.assign(failedProbe, { exitCode: 1, stderr: 'hdiutil info failed' })
    await expect(hdiutilReadOnlyEvidence(async () => failedProbe, String, toolIdentity)).rejects.toMatchObject({
      result: failedProbe
    })
  })

  it('retains bounded Windows SLT evidence and mismatch details before strict archive identity rejection', async () => {
    const root = await temporaryRoot()
    const payloadRoot = join(root, 'payload')
    const scratch = join(root, 'scratch')
    const reports = join(root, 'reports')
    await mkdir(payloadRoot)
    await writeFile(join(payloadRoot, 'package.json'), '{}')
    await mkdir(scratch)
    await mkdir(reports)
    const hdiutilPath = join(root, 'hdiutil-fixture')
    await writeFile(hdiutilPath, 'fixture hdiutil executable')
    const { commands, run } = imageRunner()
    await nativeSmoke('mac', process.cwd(), scratch, reports, run, String, hdiutilPath)
    const report = JSON.parse(await readFile(join(reports, 'native-smoke.json'), 'utf8'))
    expect(report.status).toBe('complete')
    expect(report.cases.map((item: { name: string; status: string }) => [item.name, item.status])).toEqual([
      ['shared', 'complete'],
      ['left', 'complete'],
      ['right', 'complete']
    ])
    expect(report.toolEvidence.readOnlyProbe).toMatchObject({
      command: hdiutilPath,
      args: ['info', '-plist'],
      exitCode: 0
    })
    expect(report.toolEvidence.tool).toMatchObject({ path: hdiutilPath, ...(await sha256File(hdiutilPath)) })
    expect(commands.some((command) => command.args[0] === '-version')).toBe(false)

    const appRoot = join(root, 'app')
    const windowsReportRoot = join(root, 'windows-reports')
    const windowsScratchRoot = join(root, 'windows-scratch')
    const sevenZipPath = join(root, '7za.exe')
    await mkdir(join(appRoot, 'resources'), { recursive: true })
    await mkdir(windowsReportRoot)
    await mkdir(windowsScratchRoot)
    await writeFile(sevenZipPath, 'controlled 7za fixture')
    const appManifest = await walkTree(appRoot, { windowsPathRules: true })
    const archivePath = join(windowsScratchRoot, 'builder-nsis.7z')
    const archiveBytes = Buffer.from('captured archive bytes')
    await writeFile(archivePath, archiveBytes)
    await writeFile(
      join(windowsReportRoot, 'windows-archive-capture.json'),
      JSON.stringify({
        archiveBytes: archiveBytes.length,
        archiveSha256: createHash('sha256').update(archiveBytes).digest('hex'),
        archiveName: 'builder-nsis.7z',
        preCompressedFileExtensions: []
      })
    )
    const windowsCommands: string[][] = []
    const windowsRun = async (command: string, args: string[]) => {
      windowsCommands.push(args)
      if (args[0] === 'i')
        return {
          command,
          stdout: 'controlled 7za version',
          args,
          exitCode: 0,
          signal: null,
          timedOut: false,
          outputLimitExceeded: false
        }
      if (args[0] === 'l')
        return {
          command,
          stdout: 'Path = builder-nsis.7z\nType = 7z\n\n----------\nPath = resources\nFolder = -\nSize = 0\n',
          args,
          exitCode: 0,
          signal: null,
          timedOut: false,
          outputLimitExceeded: false
        }
      if (args[0] === 't') throw new Error('controlled stop after archive inventory')
      throw new Error(`Unexpected controlled 7za command: ${args.join(' ')}`)
    }
    await expect(
      runWindowsDiagnostics(
        {
          appRoot,
          appManifest,
          reportRoot: windowsReportRoot,
          scratchRoot: windowsScratchRoot,
          installer: '',
          payloadRoot,
          report: {}
        },
        { run: windowsRun, redact: String, sevenZipPath }
      )
    ).rejects.toThrow('builder NSIS 7z archive member identity mismatch missing=0 unexpected=0 changed=1')
    expect(windowsCommands.map((args) => args[0])).toEqual(['i', 'l'])
    const listingText = 'Path = builder-nsis.7z\nType = 7z\n\n----------\nPath = resources\nFolder = -\nSize = 0\n'
    const listingPath = join(windowsReportRoot, 'windows-archive-listing.slt')
    const diagnosticPath = join(windowsReportRoot, 'windows-archive-membership-diagnostic.json')
    expect(await readFile(listingPath, 'utf8')).toBe(listingText)
    const diagnostic = JSON.parse(await readFile(diagnosticPath, 'utf8'))
    expect(diagnostic).toMatchObject({
      schema: 'lean-windows-archive-membership-diagnostic/v1',
      status: 'identity-mismatch',
      archive: { bytes: archiveBytes.length, sha256: createHash('sha256').update(archiveBytes).digest('hex') },
      tool: await sha256File(sevenZipPath),
      mismatchClasses: {
        missingPaths: 0,
        unexpectedPaths: 0,
        changedPaths: 1,
        typeDifferences: 1,
        byteCountDifferences: 0,
        linkTargetDifferences: 0
      },
      crossTab: [{ expectedType: 'directory', actualType: 'file', byteCounts: 'equal', count: 1 }],
      sample: [
        { path: 'resources', classification: 'changed', nativeRow: { Path: 'resources', Folder: '-', Size: '0' } }
      ]
    })
    expect(diagnostic.listing).toMatchObject({
      file: 'windows-archive-listing.slt',
      retained: true,
      complete: true,
      bytes: Buffer.byteLength(listingText),
      sha256: createHash('sha256').update(listingText).digest('hex'),
      command: sevenZipPath,
      args: ['l', '-slt', archivePath],
      exitCode: 0,
      signal: null,
      timedOut: false,
      outputLimitExceeded: false
    })
    expect(diagnostic.diagnosticSourceSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(
      validateReportArtifactRoster(['windows-archive-listing.slt', 'windows-archive-membership-diagnostic.json'])
    ).toEqual(['windows-archive-listing.slt', 'windows-archive-membership-diagnostic.json'])
    expect(() => validateReportArtifactRoster(['windows-archive-listing-private.slt'])).toThrow(/Non-report artifact/)

    const failedReportRoot = join(root, 'windows-limited-reports')
    const failedScratchRoot = join(root, 'windows-limited-scratch')
    await mkdir(failedReportRoot)
    await mkdir(failedScratchRoot)
    const failedArchivePath = join(failedScratchRoot, 'builder-nsis.7z')
    await writeFile(failedArchivePath, archiveBytes)
    await writeFile(
      join(failedReportRoot, 'windows-archive-capture.json'),
      JSON.stringify({
        archiveBytes: archiveBytes.length,
        archiveSha256: createHash('sha256').update(archiveBytes).digest('hex'),
        archiveName: 'builder-nsis.7z',
        preCompressedFileExtensions: []
      })
    )
    const limitedRun = async (command: string, args: string[]) => {
      if (args[0] === 'i')
        return {
          command,
          stdout: 'controlled 7za version',
          args,
          exitCode: 0,
          signal: null,
          timedOut: false,
          outputLimitExceeded: false
        }
      if (args[0] === 'l')
        return {
          command,
          stdout: 'partial listing prefix',
          stderr: '',
          args,
          exitCode: null,
          signal: 'SIGTERM',
          timedOut: true,
          outputLimitExceeded: true
        }
      throw new Error(`Unexpected limited runner command: ${args.join(' ')}`)
    }
    await expect(
      runWindowsDiagnostics(
        {
          appRoot,
          appManifest,
          reportRoot: failedReportRoot,
          scratchRoot: failedScratchRoot,
          installer: '',
          payloadRoot,
          report: {}
        },
        { run: limitedRun, redact: String, sevenZipPath }
      )
    ).rejects.toThrow('Windows 7za -slt listing did not complete within its bounded identity')
    expect(await readFile(join(failedReportRoot, 'windows-archive-listing.slt'))).toHaveLength(0)
    const failedDiagnostic = JSON.parse(
      await readFile(join(failedReportRoot, 'windows-archive-membership-diagnostic.json'), 'utf8')
    )
    expect(failedDiagnostic).toMatchObject({
      status: 'listing-failed',
      failureCode: 'listing-output-limit-exceeded',
      listing: { retained: false, complete: false, outputLimitExceeded: true, timedOut: true }
    })
  })

  it('accepts native D inventory through archive test and extracted identity before a controlled probe stop', async () => {
    const root = await temporaryRoot()
    const appRoot = join(root, 'app')
    const payloadRoot = join(root, 'payload')
    const scratchRoot = join(root, 'scratch')
    const reportRoot = join(root, 'reports')
    const sevenZipPath = join(root, '7za.exe')
    const memberBytes = Buffer.from('native directory classification fixture')
    await mkdir(join(appRoot, 'resources'), { recursive: true })
    await mkdir(payloadRoot)
    await mkdir(scratchRoot)
    await mkdir(reportRoot)
    await writeFile(join(appRoot, 'resources', 'fixture.bin'), memberBytes)
    await writeFile(join(payloadRoot, 'package.json'), '{}')
    await writeFile(sevenZipPath, 'controlled 7za fixture')
    const appManifest = await walkTree(appRoot, { windowsPathRules: true })
    const archivePath = join(scratchRoot, 'builder-nsis.7z')
    const archiveBytes = Buffer.from('captured archive bytes')
    await writeFile(archivePath, archiveBytes)
    await writeFile(
      join(reportRoot, 'windows-archive-capture.json'),
      JSON.stringify({
        archiveBytes: archiveBytes.length,
        archiveSha256: createHash('sha256').update(archiveBytes).digest('hex'),
        archiveName: 'builder-nsis.7z',
        preCompressedFileExtensions: []
      })
    )
    const listingText =
      'Path = builder-nsis.7z\nType = 7z\n\n----------\n' +
      'Path = resources\nSize = 0\nPacked Size = 0\nModified = \nAttributes = D\nCRC = \nEncrypted = -\nMethod = \nBlock = \n\n' +
      `Path = resources\\fixture.bin\nSize = ${memberBytes.length}\nPacked Size = ${memberBytes.length}\nModified = \nAttributes = A\nCRC = \nEncrypted = -\nMethod = \nBlock = \n`
    const commands: string[][] = []
    const run = async (command: string, args: string[]) => {
      commands.push(args)
      if (args[0] === 'i') return result(command, args, 'controlled 7za version')
      if (args[0] === 'l') return result(command, args, listingText)
      if (args[0] === 't') return result(command, args)
      if (args[0] === 'x') {
        const extractionRoot = args[2].slice(2)
        await mkdir(join(extractionRoot, 'resources'), { recursive: true })
        await writeFile(join(extractionRoot, 'resources', 'fixture.bin'), memberBytes)
        return result(command, args)
      }
      if (args[0] === 'a') throw new Error('controlled stop after native-D extraction identity')
      throw new Error(`Unexpected native-D controlled 7za command: ${args.join(' ')}`)
    }

    // The first probe's add command occurs only after the unchanged archive t and extraction identity
    // stages. The current parser should stop earlier on the native D directory-type mismatch.
    await expect(
      runWindowsDiagnostics(
        {
          appRoot,
          appManifest,
          reportRoot,
          scratchRoot,
          installer: '',
          payloadRoot,
          report: {}
        },
        { run, redact: String, sevenZipPath }
      )
    ).rejects.toThrow('controlled stop after native-D extraction identity')
    expect(commands.map((args) => args[0])).toEqual(['i', 'l', 't', 'x', 'a'])
    const diagnostic = JSON.parse(
      await readFile(join(reportRoot, 'windows-archive-membership-diagnostic.json'), 'utf8')
    )
    expect(diagnostic).toMatchObject({
      status: 'identity-match',
      mismatchClasses: {
        missingPaths: 0,
        unexpectedPaths: 0,
        changedPaths: 0,
        typeDifferences: 0,
        byteCountDifferences: 0
      }
    })
    expect(await readFile(join(reportRoot, 'windows-archive-listing.slt'), 'utf8')).toBe(listingText)
    expect(commands[2]).toEqual(['t', archivePath])
    expect(commands[3]).toEqual(['x', '-y', `-o${join(scratchRoot, 'archive-identity-check')}`, archivePath])
  })

  it('marks a changed raw image failed and never writes a complete probe', async () => {
    const root = await temporaryRoot()
    const payloadRoot = join(root, 'payload')
    const source = join(root, 'source')
    const scratch = join(root, 'scratch')
    const output = join(root, 'output')
    await mkdir(payloadRoot)
    await writeFile(join(payloadRoot, 'package.json'), '{}')
    await mkdir(source)
    await writeFile(join(source, 'fixture.txt'), 'source bytes')
    await mkdir(scratch)
    await mkdir(output)
    const manifest = await walkTree(source)
    const { run } = imageRunner({
      onConvert: async (raw, image) => {
        await copyFile(raw, image)
        await writeFile(raw, 'mutated raw image')
      }
    })
    let failure: any
    try {
      await runMacProbe({
        id: 'changed-raw',
        sourceRoot: source,
        sourceManifest: manifest,
        entries: manifest.entries,
        payloadRoot: process.cwd(),
        scratchRoot: scratch,
        output,
        reports: [],
        run,
        redact: String
      })
    } catch (error) {
      failure = error
    }
    const record = JSON.parse(await readFile(join(output, 'probe-changed-raw.json'), 'utf8'))
    expect(failure.message).toMatch(/changed during conversion/)
    expect(record.status).toBe('failed')
    expect(record.verified).toBe(false)
    expect(record.rawImage.digestUnchangedThroughConversion).toBe(false)
    expect(record.outputBytes).toBeNull()
  })

  it('waits for child close after output overflow before image ownership cleanup', async () => {
    const root = await temporaryRoot()
    const payloadRoot = join(root, 'payload')
    const scratch = join(root, 'scratch')
    await mkdir(payloadRoot)
    await writeFile(join(payloadRoot, 'package.json'), '{}')
    await mkdir(scratch)
    class Child extends EventEmitter {
      stdout = new PassThrough()
      stderr = new PassThrough()
      kills: Array<string | undefined> = []
      kill(signal?: string) {
        this.kills.push(signal)
        return true
      }
    }
    let child!: Child
    let spawned!: () => void
    const spawnedPromise = new Promise<void>((resolveSpawned) => {
      spawned = resolveSpawned
    })
    const commands: string[][] = []
    const run = async (command: string, args: string[], options: any) => {
      commands.push(args)
      if (args[0] === 'create')
        return runDiagnosticChild(command, args, {
          ...options,
          maxOutputBytes: 4,
          spawnImpl: () => {
            child = new Child()
            spawned()
            return child as any
          }
        })
      if (args[0] === 'info') return result(command, args, info())
      throw new Error('unexpected command after failed create')
    }
    let settled = false
    const operation = withOwnedMacImage({
      payloadRoot: process.cwd(),
      scratchRoot: scratch,
      caseId: 'overflow',
      prepareProjection: async () => {},
      run
    }).finally(() => {
      settled = true
    })
    await spawnedPromise
    child.stdout.write('12345')
    await Promise.resolve()
    expect(child.kills).toHaveLength(1)
    expect(settled).toBe(false)
    expect(commands.some((args) => args[0] === 'info')).toBe(false)
    child.emit('close', null, 'SIGTERM')
    let failure: any
    try {
      await operation
    } catch (error) {
      failure = error
    }
    expect(failure.result).toMatchObject({ outputLimitExceeded: true, signal: 'SIGTERM' })
    expect(Buffer.byteLength(failure.result.stdout)).toBeLessThanOrEqual(4)
    expect(commands.some((args) => args[0] === 'info')).toBe(true)
  })

  it('requests timeout termination once and clears escalation when close arrives', async () => {
    class Child extends EventEmitter {
      stdout = new PassThrough()
      stderr = new PassThrough()
      kills: Array<string | undefined> = []
      kill(signal?: string) {
        this.kills.push(signal)
        return true
      }
    }
    const child = new Child()
    const timers: Array<{ callback: () => void; cleared: boolean }> = []
    const run = runDiagnosticChild('fixture', [], {
      timeoutMs: 1,
      spawnImpl: () => child as any,
      setTimeoutImpl: (callback: () => void) => {
        const timer = { callback, cleared: false }
        timers.push(timer)
        return timer as any
      },
      clearTimeoutImpl: (timer: any) => {
        if (timer) timer.cleared = true
      }
    } as any)
    timers[0].callback()
    expect(child.kills).toEqual([undefined])
    expect(timers).toHaveLength(2)
    timers[1].callback()
    expect(child.kills).toEqual([undefined, 'SIGKILL'])
    let settled = false
    const observed = run.catch((error) => {
      settled = true
      throw error
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    child.emit('close', null, 'SIGKILL')
    await expect(observed).rejects.toMatchObject({ result: { timedOut: true, signal: 'SIGKILL' } })
    expect(timers.every((timer) => timer.cleared)).toBe(true)
    timers[1].callback()
    expect(child.kills).toEqual([undefined, 'SIGKILL'])
  })

  it('preserves success, nonzero close, and emitted spawn failure outcomes', async () => {
    const spawn = (close: [number | null, string | null], error?: Error) => {
      const child = new EventEmitter() as any
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      queueMicrotask(() => {
        if (error) child.emit('error', error)
        child.emit('close', ...close)
      })
      child.kill = () => true
      return child
    }
    await expect(runDiagnosticChild('ok', [], { spawnImpl: () => spawn([0, null]) } as any)).resolves.toMatchObject({
      exitCode: 0,
      outputLimitExceeded: false
    })
    await expect(runDiagnosticChild('nonzero', [], { spawnImpl: () => spawn([7, null]) } as any)).rejects.toMatchObject(
      { result: { exitCode: 7 } }
    )
    await expect(
      runDiagnosticChild('spawn-error', [], { spawnImpl: () => spawn([null, null], new Error('ENOENT')) } as any)
    ).rejects.toMatchObject({ result: { exitCode: null, spawnError: 'ENOENT' } })
  })
})
