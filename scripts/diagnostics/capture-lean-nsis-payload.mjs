import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'

function inside(root, path) {
  return path === root || path.startsWith(`${root}${sep}`)
}

async function digest(path) {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Capture input is not a regular file: ${path}`)
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), async function* (source) {
    for await (const chunk of source) hash.update(chunk)
  })
  const after = await lstat(path)
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error(`Capture input changed while hashing: ${path}`)
  }
  return { bytes: before.size, sha256: hash.digest('hex') }
}

export function readNsisCompletionEvent(context) {
  const file = context?.file
  const targetName = context?.target?.name
  const arch = context?.arch
  const extensions = context?.target?.options?.preCompressedFileExtensions
  if (typeof file !== 'string' || !file) throw new Error('Builder completion event is missing file')
  if (typeof targetName !== 'string' || targetName.toLowerCase() !== 'nsis')
    throw new Error('Builder completion event is not the NSIS target')
  if (!(arch === 'x64' || arch === 1)) throw new Error('Builder completion event is not x64')
  if (
    extensions !== null &&
    extensions !== undefined &&
    (!Array.isArray(extensions) || extensions.some((extension) => typeof extension !== 'string'))
  ) {
    throw new Error('Pinned NSIS target did not expose pre-compressed file extensions')
  }
  return { file, targetName, arch: 'x64', preCompressedFileExtensions: [...(extensions ?? [])] }
}

export default async function captureLeanNsisPayload(context) {
  const expectedOutput = process.env.METIS_ATTRIBUTION_EXPECTED_OUTPUT
  const scratch = process.env.METIS_ATTRIBUTION_SCRATCH
  const report = process.env.METIS_ATTRIBUTION_REPORT
  if (!expectedOutput || !scratch || !report) throw new Error('Attribution capture paths were not initialized')

  const event = readNsisCompletionEvent(context)
  const artifact = event.file
  const expectedRoot = await realpath(resolve(expectedOutput))
  const scratchRoot = await realpath(resolve(scratch))
  const reportRoot = await realpath(resolve(report))
  const artifactPath = resolve(artifact)
  const artifactRealPath = await realpath(artifactPath)
  const artifactStat = await lstat(artifactPath)
  if (!artifactStat.isFile() || artifactStat.isSymbolicLink() || !inside(expectedRoot, artifactRealPath)) {
    throw new Error('Completed installer escaped the expected output directory')
  }
  if (!/^Metis-Setup-[0-9A-Za-z.+-]+\.exe$/i.test(basename(artifactPath))) {
    throw new Error('Completed artifact is not the expected Setup EXE')
  }

  const candidates = []
  for (const entry of await readdir(expectedRoot, { withFileTypes: true })) {
    if (/\.nsis\.7z$/i.test(entry.name)) {
      if (!entry.isFile() || entry.isSymbolicLink())
        throw new Error(`NSIS archive is not a regular file: ${entry.name}`)
      candidates.push(resolve(expectedRoot, entry.name))
    }
  }
  if (candidates.length !== 1) throw new Error(`Expected one completed NSIS archive, found ${candidates.length}`)
  const archive = candidates[0]
  const archiveStat = await lstat(archive)
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || !inside(expectedRoot, archive)) {
    throw new Error('NSIS archive escaped the expected output directory')
  }

  const before = await digest(archive)
  const retained = resolve(scratchRoot, 'builder-nsis.7z')
  await mkdir(dirname(retained), { recursive: true })
  await pipeline(createReadStream(archive), createWriteStream(retained, { flags: 'wx' }))
  const retainedIdentity = await digest(retained)
  const after = await digest(archive)
  if (JSON.stringify(before) !== JSON.stringify(retainedIdentity) || JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error('NSIS archive changed or retained bytes failed verification')
  }
  await writeFile(
    resolve(reportRoot, 'windows-archive-capture.json'),
    `${JSON.stringify(
      {
        schema: 1,
        capture: 'builder-completed-nsis-archive',
        installerName: basename(artifactPath),
        archiveName: basename(archive),
        archiveBytes: retainedIdentity.bytes,
        archiveSha256: retainedIdentity.sha256,
        target: event.targetName,
        arch: event.arch,
        preCompressedFileExtensions: event.preCompressedFileExtensions,
        retainedScratchName: basename(retained)
      },
      null,
      2
    )}\n`,
    { flag: 'wx' }
  )
}
