/**
 * The packaged half of the QA-only fatal fault hook (src/main/qa-identity.ts): prove the compiled bytes match
 * the package's declared identity, in both directions. A shipping package must never carry the hook, and the
 * QA-identity package must always carry it — otherwise scripts/qa/fault-fatal-relaunch.mjs cannot drive it.
 */
import { extractFile, listPackage, uncache } from '@electron/asar'

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
  // listPackage returns entries with the packing host's separator (backslash on Windows) and a leading
  // separator. Normalize to a leading-slash POSIX form to match against, but extractFile takes the RAW key
  // with only its leading separator stripped — the same two-step normalization
  // verifyPackagedDependencyPruning uses in check-packaged-runtime.mjs, or a Windows-packed archive fails
  // every extract here.
  const rawEntries = listPackage(archive)
  const toPosix = (entry) => `/${entry.split('\\').join('/').replace(/^\/+/, '')}`
  const rawByPosix = new Map(rawEntries.map((entry) => [toPosix(entry), entry]))
  const packageJson = rawByPosix.get('/package.json')
  if (!packageJson) throw new Error('app.asar has no package.json — the packaged app identity is missing')
  const qaIdentity = JSON.parse(extractFile(archive, packageJson.replace(/^[\\/]+/, '')).toString('utf8')).name === QA_IDENTITY_PACKAGE_NAME
  const mainFiles = [...rawByPosix.keys()].filter((entry) => /^\/out\/main\/.+\.(?:c?js|jsc)$/.test(entry))
  const carriesHook = mainFiles.some((entry) =>
    extractFile(archive, rawByPosix.get(entry).replace(/^[\\/]+/, '')).includes(QA_FAULT_MARKER)
  )
  if (carriesHook !== qaIdentity) {
    throw new Error(
      qaIdentity
        ? 'The QA-identity package lacks the QA fault hook. Build it with METIS_QA_IDENTITY=1 (package.json dist:qa-identity).'
        : 'A shipping package carries the QA fault hook. Only dist:qa-identity may set METIS_QA_IDENTITY=1.'
    )
  }
  return { qaIdentity }
}
