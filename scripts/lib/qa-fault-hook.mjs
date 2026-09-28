/**
 * The packaged half of the QA-only fatal fault hook (src/main/qa-identity.ts): prove the compiled bytes match
 * the package's declared identity, in both directions. A shipping package must never carry the hook, and the
 * QA-identity package must always carry it — otherwise scripts/qa/fault-fatal-relaunch.mjs cannot drive it.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { getRawHeader, listPackage, uncache } from '@electron/asar'

/** The string only the QA fault hook (src/main/qa-identity.ts) puts into a main-process bundle. */
export const QA_FAULT_MARKER = 'METIS_QA_FAULT_HOOK'
/** The packaged package.json name of the QA-identity variant (build/qa-identity.electron-builder.yml extraMetadata). */
export const QA_IDENTITY_PACKAGE_NAME = 'asktoto-qa'

/**
 * Fail unless the packaged main process carries the QA fault hook exactly when the package is the QA identity:
 * a shipping package must never contain it, and a QA package without it cannot run the packaged exit-path proof.
 */
export function assertQaFaultHookMatchesIdentity(archive) {
  // @electron/asar caches headers by archive path. This gate may inspect the same path after a repack.
  uncache(archive)
  try {
    const { header, headerSize } = getRawHeader(archive)
    assertArchiveBytesComplete(archive, header, headerSize)
    // Keep the same raw-key normalization verifyPackagedDependencyPruning uses: listPackage reports
    // host-separator entries, while the header stores POSIX paths and raw reads use header offsets.
    const rawEntries = listPackage(archive)
    const toPosix = (entry) => `/${entry.split('\\').join('/').replace(/^\/+/, '')}`
    const rawByPosix = new Map(rawEntries.map((entry) => [toPosix(entry), entry]))
    const packedFilesByPosix = new Map(listPackedFiles(header).map((entry) => [entry.path, entry.file]))
    const packageJson = packedFilesByPosix.get('/package.json')
    if (!packageJson) throw new Error('app.asar has no package.json — the packaged app identity is missing')
    const qaIdentity = JSON.parse(readPackedFile(archive, headerSize, packageJson, 'package.json').toString('utf8')).name === QA_IDENTITY_PACKAGE_NAME
    const mainFiles = [...rawByPosix.keys()].filter((entry) => /^\/out\/main\/.+\.(?:c?js|jsc)$/.test(entry))
    const carriesHook = mainFiles.some((entry) =>
      readPackedFile(archive, headerSize, packedFilesByPosix.get(entry), rawByPosix.get(entry)).includes(QA_FAULT_MARKER)
    )
    if (carriesHook !== qaIdentity) {
      throw new Error(
        qaIdentity
          ? 'The QA-identity package lacks the QA fault hook. Build it with METIS_QA_IDENTITY=1 (package.json dist:qa-identity).'
          : 'A shipping package carries the QA fault hook. Only dist:qa-identity may set METIS_QA_IDENTITY=1.'
      )
    }
    return { qaIdentity }
  } finally {
    uncache(archive)
  }
}

function assertArchiveBytesComplete(archive, header, headerSize) {
  const expectedSize = 8 + headerSize + packedPayloadSize(listPackedFiles(header).map(({ file }) => file))
  const actualSize = statSync(archive).size
  if (actualSize !== expectedSize) {
    throw new Error(`app.asar is incomplete: expected ${expectedSize} bytes from the ASAR header, found ${actualSize}`)
  }
}

function listPackedFiles(entry, prefix = '') {
  const files = []
  for (const [name, child] of Object.entries(entry.files || {})) {
    const path = `${prefix}/${name.split('\\').join('/').replace(/^\/+/, '')}`
    if (child.files) {
      files.push(...listPackedFiles(child, path))
    } else if (!child.unpacked && child.offset !== undefined && child.size !== undefined) {
      files.push({ path, file: child })
    }
  }
  return files
}

function packedPayloadSize(files) {
  return Math.max(0, ...files.map((file) => Number(file.offset) + file.size))
}

function readPackedFile(archive, headerSize, file, path) {
  if (file?.offset === undefined || file?.size === undefined) {
    throw new Error(`app.asar entry is not a packed file: ${path}`)
  }
  const buffer = Buffer.alloc(file.size)
  const fd = openSync(archive, 'r')
  try {
    let bytesRead = 0
    const position = 8 + headerSize + Number(file.offset)
    while (bytesRead < file.size) {
      // @electron/asar's extractFile ignores short reads, leaving Buffer.alloc's NUL bytes for JSON.parse.
      const count = readSync(fd, buffer, bytesRead, file.size - bytesRead, position + bytesRead)
      if (count === 0) {
        throw new Error(`app.asar is incomplete: could not read ${path} from the packed payload`)
      }
      bytesRead += count
    }
    return buffer
  } finally {
    closeSync(fd)
  }
}
