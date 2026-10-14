import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isSafeEntryName } from './archive'
import { SpeechPackError } from './errors'
import { pathExists as exists } from './download'
import type { SpeechPackComponent, SpeechPackComponentId } from './manifest'
import { componentManifestIdentity } from './resolver'
import { createSpeechPackOwnedTreeCleanup, type TreeEntry } from './owned-tree-cleanup'
import {
  authorizePriorPackRestore,
  priorPackRestoreStillCurrent,
  rollbackSpeechPackActivation
} from './activation-authority'
import {
  hasUnsafeSpeechPackMarkerVersion,
  parseSpeechPackActivationMarker,
  type SpeechPackActivationMarker,
  type SpeechPackMarkerSnapshot
} from './marker'
import {
  capturePhysicalOwner,
  capturePhysicalPathVersion,
  physicalOwnerMatches,
  physicalPathVersionMatches,
  physicalPathVersionFromStats,
  samePhysicalPathVersion,
  type PhysicalOwner,
  type PhysicalPathVersion
} from './physical-ownership'

const MAX_MARKER_BYTES = 4096
const asideReceipts = new Map<string, Map<string, { componentId: string; path: string; owner: PhysicalOwner }>>()

export interface InstallDirectoryOwners {
  root: PhysicalOwner
  component: PhysicalOwner
  stagingBase: PhysicalOwner
  staging: PhysicalOwner
  work: PhysicalOwner
}

export interface RollbackDirectoryOwner {
  path: string
  version: PhysicalPathVersion
  verified: boolean
  postRenameVersionPending?: boolean
}

export interface RollbackOwnership {
  directories: InstallDirectoryOwners
  staging: PhysicalPathVersion
  destinationBefore: PhysicalPathVersion | null
  aside: RollbackDirectoryOwner | null
  promoted: RollbackDirectoryOwner | null
  previousMarker: SpeechPackMarkerSnapshot | null
  promotedMarker: SpeechPackMarkerSnapshot | null
  previousMarkerTarget: PhysicalOwner | null
}

export interface SpeechPackActivationRollbackOptions {
  rootDir: string
  authorizeActivation: (component: SpeechPackComponent, signal: AbortSignal) => Promise<void>
  authorizeRollback: (
    componentId: SpeechPackComponentId,
    marker: Pick<SpeechPackActivationMarker, 'version' | 'manifestIdentity'> | null,
    transaction: symbol
  ) => boolean | Promise<boolean>
  authorizeRollbackCurrent: (
    componentId: SpeechPackComponentId,
    marker: Pick<SpeechPackActivationMarker, 'version' | 'manifestIdentity'> | null,
    transaction: symbol
  ) => boolean
  assertTransferAuthorized: (component: SpeechPackComponent, signal: AbortSignal) => void
  dirVerified: (component: SpeechPackComponent, path: string) => Promise<boolean>
  activationStep: (step: 'marker-tmp-written' | 'marker-written') => Promise<void>
}

export function createSpeechPackActivationRollback(options: SpeechPackActivationRollbackOptions) {
  const { rootDir } = options
  const componentDir = (c: SpeechPackComponent): string => join(rootDir, c.id)
  const stagingDir = (c: SpeechPackComponent): string => join(rootDir, '.staging', c.id, c.version)
  const stagingBaseDir = (c: SpeechPackComponent): string => join(rootDir, '.staging', c.id)
  const workDir = (c: SpeechPackComponent): string => join(rootDir, '.staging', c.id, 'work')
  const finalDir = (c: SpeechPackComponent): string => join(rootDir, c.id, c.version)
  const markerPath = (c: SpeechPackComponent): string => join(rootDir, c.id, 'active.json')
  const ownedTree = createSpeechPackOwnedTreeCleanup()
  const { removeInspectedTree, packTreeAllowed, stagingTreeAllowed, treeEntryLimit } = ownedTree

  const recordOwnedAside = (c: SpeechPackComponent, path: string, owner: PhysicalOwner): void => {
    let receipts = asideReceipts.get(rootDir)
    if (!receipts) {
      receipts = new Map()
      asideReceipts.set(rootDir, receipts)
    }
    receipts.set(`${c.id}\0${path}`, { componentId: c.id, path, owner })
  }

  const captureInstallDirectories = async (c: SpeechPackComponent): Promise<Map<string, PhysicalOwner | null>> => {
    const paths = [rootDir, join(rootDir, '.staging'), stagingBaseDir(c), componentDir(c), stagingDir(c), workDir(c)]
    const captured = new Map<string, PhysicalOwner | null>()
    for (const path of paths) {
      const owner = await capturePhysicalOwner(path, 'directory')
      if (!owner) {
        try {
          await lstat(path)
          throw new SpeechPackError('tamper', 'pack directory is unsafe')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      captured.set(path, owner)
    }
    return captured
  }

  const requiredOwner = async (path: string, kind: 'directory' | 'file'): Promise<PhysicalOwner> => {
    const owner = await capturePhysicalOwner(path, kind)
    if (!owner) throw new SpeechPackError('tamper', 'pack path is not owned')
    return owner
  }

  const prepareOwnedInstallDirectories = async (
    c: SpeechPackComponent,
    initial: Map<string, PhysicalOwner | null>
  ): Promise<InstallDirectoryOwners> => {
    const paths = [rootDir, join(rootDir, '.staging'), stagingBaseDir(c), componentDir(c), stagingDir(c), workDir(c)]
    const expectedOwners = new Map<string, PhysicalOwner>()
    for (const path of paths) {
      const expected = initial.get(path)
      if (expected) {
        if (!(await physicalOwnerMatches(path, expected, 'directory')))
          throw new SpeechPackError('tamper', 'pack directory ownership changed')
        expectedOwners.set(path, expected)
      } else {
        try {
          await mkdir(path)
        } catch {
          throw new SpeechPackError('tamper', 'pack directory appeared outside this operation')
        }
        expectedOwners.set(path, await requiredOwner(path, 'directory'))
      }
    }
    const [rootOwner, stagingBaseOwner, ownedComponent, stagingOwner, workOwner] = await Promise.all([
      capturePhysicalOwner(rootDir, 'directory'),
      capturePhysicalOwner(stagingBaseDir(c), 'directory'),
      capturePhysicalOwner(componentDir(c), 'directory'),
      capturePhysicalOwner(stagingDir(c), 'directory'),
      capturePhysicalOwner(workDir(c), 'directory')
    ])
    if (!rootOwner || !stagingBaseOwner || !ownedComponent || !stagingOwner || !workOwner)
      throw new SpeechPackError('tamper', 'pack directory ownership is unavailable')
    for (const [path, owner] of expectedOwners) {
      if (!(await physicalOwnerMatches(path, owner, 'directory')))
        throw new SpeechPackError('tamper', 'pack directory ownership changed')
    }
    return {
      root: rootOwner,
      stagingBase: stagingBaseOwner,
      component: ownedComponent,
      staging: stagingOwner,
      work: workOwner
    }
  }

  const optionalDirectoryOwnerMatches = async (path: string, expected: PhysicalOwner | null): Promise<boolean> => {
    const current = await capturePhysicalOwner(path, 'directory')
    if (!current) return !(await exists(path))
    return expected !== null && current.dev === expected.dev && current.ino === expected.ino
  }

  const installDirectoriesCurrent = async (c: SpeechPackComponent, owners: InstallDirectoryOwners): Promise<boolean> =>
    (await physicalOwnerMatches(rootDir, owners.root, 'directory')) &&
    (await physicalOwnerMatches(componentDir(c), owners.component, 'directory')) &&
    (await physicalOwnerMatches(stagingBaseDir(c), owners.stagingBase, 'directory')) &&
    (await optionalDirectoryOwnerMatches(stagingDir(c), owners.staging)) &&
    (await optionalDirectoryOwnerMatches(workDir(c), owners.work))

  async function readMarkerFile(c: SpeechPackComponent): Promise<{ bytes: Buffer; owner: PhysicalPathVersion } | null> {
    try {
      const component = await lstat(componentDir(c), { bigint: true })
      if (!component.isDirectory() || component.isSymbolicLink()) return null
      const path = markerPath(c)
      const markerStat = await lstat(path, { bigint: true })
      if (
        !markerStat.isFile() ||
        markerStat.isSymbolicLink() ||
        markerStat.nlink !== 1n ||
        markerStat.size > BigInt(MAX_MARKER_BYTES)
      )
        return null
      const version = physicalPathVersionFromStats(markerStat, 'file')
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      let bytes: Buffer
      try {
        const opened = physicalPathVersionFromStats(await handle.stat({ bigint: true }), 'file')
        if (!samePhysicalPathVersion(opened, version)) return null
        const bounded = Buffer.alloc(MAX_MARKER_BYTES + 1)
        let offset = 0
        while (offset < bounded.length) {
          const { bytesRead } = await handle.read(bounded, offset, bounded.length - offset, offset)
          if (bytesRead === 0) break
          offset += bytesRead
        }
        if (offset > MAX_MARKER_BYTES) return null
        bytes = bounded.subarray(0, offset)
        const afterHandle = physicalPathVersionFromStats(await handle.stat({ bigint: true }), 'file')
        const afterPath = await capturePhysicalPathVersion(path, 'file')
        if (
          !samePhysicalPathVersion(afterHandle, version) ||
          !afterPath ||
          !samePhysicalPathVersion(afterPath, version)
        )
          return null
      } finally {
        await handle.close()
      }
      return { bytes, owner: version }
    } catch {
      return null
    }
  }

  async function readMarkerSnapshot(
    c: SpeechPackComponent,
    discardUnsafeVersion = false
  ): Promise<SpeechPackMarkerSnapshot | null> {
    const file = await readMarkerFile(c)
    if (!file) return null
    const marker = parseSpeechPackActivationMarker(file.bytes, c.id)
    if (!marker) {
      if (
        discardUnsafeVersion &&
        hasUnsafeSpeechPackMarkerVersion(file.bytes, c.id) &&
        (await physicalPathVersionMatches(markerPath(c), file.owner))
      )
        await rm(markerPath(c), { force: true })
      return null
    }
    try {
      const versionDir = await lstat(join(componentDir(c), marker.version))
      if (!versionDir.isDirectory() || versionDir.isSymbolicLink()) return null
      return { marker, bytes: file.bytes, owner: file.owner }
    } catch {
      return null
    }
  }

  const markerFileMatches = async (
    c: SpeechPackComponent,
    expected: SpeechPackMarkerSnapshot | null
  ): Promise<boolean> => {
    const current = await readMarkerFile(c)
    if (!expected) return current === null && !(await exists(markerPath(c)))
    return (
      current !== null &&
      current.owner.dev === expected.owner.dev &&
      current.owner.ino === expected.owner.ino &&
      current.owner.size === expected.owner.size &&
      current.owner.mtimeNs === expected.owner.mtimeNs &&
      current.owner.ctimeNs === expected.owner.ctimeNs &&
      current.bytes.equals(expected.bytes)
    )
  }

  async function writeMarker(c: SpeechPackComponent, signal: AbortSignal, ownership: RollbackOwnership): Promise<void> {
    if (!(await rollbackOwnershipCurrent(c, ownership)))
      throw new SpeechPackError('tamper', 'activation ownership changed')
    await options.authorizeActivation(c, signal)
    if (!(await rollbackOwnershipCurrent(c, ownership)))
      throw new SpeechPackError('tamper', 'activation ownership changed')
    const marker: SpeechPackActivationMarker = {
      schema: 2,
      component: c.id,
      version: c.version,
      manifestIdentity: componentManifestIdentity(c)
    }
    const temp = `${markerPath(c)}.tmp-${randomUUID()}`
    await writeFile(temp, JSON.stringify(marker), { flag: 'wx' })
    const tempVersion = await capturePhysicalPathVersion(temp, 'file')
    if (!tempVersion) throw new SpeechPackError('tamper', 'activation marker staging is unsafe')
    await options.activationStep('marker-tmp-written')
    await options.authorizeActivation(c, signal)
    options.assertTransferAuthorized(c, signal)
    if (
      !(await rollbackOwnershipCurrent(c, ownership)) ||
      !(await physicalPathVersionMatches(temp, tempVersion)) ||
      !(await markerFileMatches(c, ownership.previousMarker))
    )
      throw new SpeechPackError('tamper', 'activation marker ownership changed')
    await rename(temp, markerPath(c))
    const promoted = await readMarkerSnapshot(c)
    if (!promoted || promoted.owner.dev !== tempVersion.dev || promoted.owner.ino !== tempVersion.ino)
      throw new SpeechPackError('tamper', 'activation marker promotion failed')
    ownership.promotedMarker = promoted
    await options.activationStep('marker-written')
    if (!(await rollbackOwnershipCurrent(c, ownership)))
      throw new SpeechPackError('tamper', 'activation ownership changed')
  }

  async function rollbackOwnershipCurrent(c: SpeechPackComponent, ownership: RollbackOwnership): Promise<boolean> {
    if (!(await installDirectoriesCurrent(c, ownership.directories))) return false
    const stageVersion = await capturePhysicalPathVersion(stagingDir(c), 'directory')
    if (stageVersion && (stageVersion.dev !== ownership.staging.dev || stageVersion.ino !== ownership.staging.ino))
      return false
    if (ownership.aside) {
      if (ownership.aside.postRenameVersionPending) {
        const current = await capturePhysicalPathVersion(ownership.aside.path, 'directory')
        if (!current || current.dev !== ownership.aside.version.dev || current.ino !== ownership.aside.version.ino)
          return false
        ownership.aside.version = current
        ownership.aside.postRenameVersionPending = false
        recordOwnedAside(c, ownership.aside.path, current)
      } else if (!(await physicalPathVersionMatches(ownership.aside.path, ownership.aside.version))) return false
      if (ownership.aside.verified && !(await options.dirVerified(c, ownership.aside.path))) return false
    }
    if (ownership.promoted) {
      if (ownership.promoted.postRenameVersionPending) {
        const current = await capturePhysicalPathVersion(ownership.promoted.path, 'directory')
        if (
          !current ||
          current.dev !== ownership.promoted.version.dev ||
          current.ino !== ownership.promoted.version.ino
        )
          return false
        ownership.promoted.version = current
        ownership.promoted.postRenameVersionPending = false
      }
      if (
        !(await physicalPathVersionMatches(ownership.promoted.path, ownership.promoted.version)) ||
        !(await options.dirVerified(c, ownership.promoted.path)) ||
        !(await physicalPathVersionMatches(ownership.promoted.path, ownership.promoted.version))
      )
        return false
    } else if (ownership.aside?.path === finalDir(c)) {
      if (!(await physicalPathVersionMatches(finalDir(c), ownership.aside.version))) return false
    } else if (ownership.aside) {
      if (await exists(finalDir(c))) return false
    } else if (ownership.destinationBefore) {
      if (!(await physicalPathVersionMatches(finalDir(c), ownership.destinationBefore))) return false
    } else if (await exists(finalDir(c))) {
      return false
    }
    if (ownership.previousMarkerTarget) {
      const version = ownership.previousMarker?.marker.version
      const path =
        version === c.version && ownership.aside ? ownership.aside.path : version ? join(componentDir(c), version) : ''
      if (!path || !(await physicalOwnerMatches(path, ownership.previousMarkerTarget, 'directory'))) return false
    }
    if (ownership.promotedMarker) {
      if (
        !(await markerFileMatches(c, ownership.promotedMarker)) &&
        !(await markerFileMatches(c, ownership.previousMarker))
      )
        return false
    } else if (!(await markerFileMatches(c, ownership.previousMarker))) {
      return false
    }
    return installDirectoriesCurrent(c, ownership.directories)
  }

  async function restoreAside(
    c: SpeechPackComponent,
    ownership: RollbackOwnership,
    transaction: symbol
  ): Promise<boolean> {
    const aside = ownership.aside
    if (!aside?.verified || (await exists(finalDir(c)))) return false
    if (!(await physicalPathVersionMatches(aside.path, aside.version)) || !(await options.dirVerified(c, aside.path)))
      return false
    if (!(await installDirectoriesCurrent(c, ownership.directories))) return false
    if (
      !(await markerFileMatches(c, ownership.promotedMarker)) &&
      !(await markerFileMatches(c, ownership.previousMarker))
    )
      return false
    if (
      !(await authorizePriorPackRestore(
        c.id,
        ownership.previousMarker?.marker ?? null,
        options.authorizeRollback,
        options.authorizeRollbackCurrent,
        transaction
      ))
    )
      return false
    if (
      !(await installDirectoriesCurrent(c, ownership.directories)) ||
      !(await physicalPathVersionMatches(aside.path, aside.version)) ||
      (await exists(finalDir(c))) ||
      (!(await markerFileMatches(c, ownership.promotedMarker)) &&
        !(await markerFileMatches(c, ownership.previousMarker))) ||
      !priorPackRestoreStillCurrent(
        c.id,
        ownership.previousMarker?.marker ?? null,
        options.authorizeRollbackCurrent,
        transaction
      )
    )
      return false
    await rename(aside.path, finalDir(c))
    const restored = await capturePhysicalPathVersion(finalDir(c), 'directory')
    if (!restored || restored.dev !== aside.version.dev || restored.ino !== aside.version.ino) return false
    if (!(await options.dirVerified(c, finalDir(c))) || !(await physicalPathVersionMatches(finalDir(c), restored)))
      return false
    ownership.aside = { path: finalDir(c), version: restored, verified: true }
    asideReceipts.get(rootDir)?.delete(`${c.id}\0${aside.path}`)
    return true
  }

  async function restoreMarkerSnapshot(
    c: SpeechPackComponent,
    ownership: RollbackOwnership,
    transaction: symbol
  ): Promise<boolean> {
    const snapshot = ownership.previousMarker
    if (!snapshot || !(await installDirectoriesCurrent(c, ownership.directories))) return false
    if (await markerFileMatches(c, snapshot)) return true
    if (!ownership.promotedMarker || !(await markerFileMatches(c, ownership.promotedMarker))) return false
    const target =
      snapshot.marker.version === c.version && ownership.aside
        ? ownership.aside.path
        : join(componentDir(c), snapshot.marker.version)
    if (
      !ownership.previousMarkerTarget ||
      !(await physicalOwnerMatches(target, ownership.previousMarkerTarget, 'directory'))
    )
      return false
    if (
      !(await authorizePriorPackRestore(
        c.id,
        snapshot.marker,
        options.authorizeRollback,
        options.authorizeRollbackCurrent,
        transaction
      ))
    )
      return false
    if (
      !(await installDirectoriesCurrent(c, ownership.directories)) ||
      !(await physicalOwnerMatches(target, ownership.previousMarkerTarget, 'directory')) ||
      !(await markerFileMatches(c, ownership.promotedMarker))
    )
      return false
    const temp = `${markerPath(c)}.restore-${randomUUID()}`
    try {
      await writeFile(temp, snapshot.bytes, { flag: 'wx' })
      const tempVersion = await capturePhysicalPathVersion(temp, 'file')
      if (
        !tempVersion ||
        !(await installDirectoriesCurrent(c, ownership.directories)) ||
        !(await physicalPathVersionMatches(temp, tempVersion)) ||
        !(await physicalOwnerMatches(target, ownership.previousMarkerTarget, 'directory')) ||
        !(await markerFileMatches(c, ownership.promotedMarker)) ||
        !priorPackRestoreStillCurrent(c.id, snapshot.marker, options.authorizeRollbackCurrent, transaction)
      )
        return false
      await rename(temp, markerPath(c))
      const restored = await readMarkerSnapshot(c)
      if (!restored || !restored.bytes.equals(snapshot.bytes)) return false
      ownership.previousMarker = restored
      return true
    } catch {
      return false
    }
  }

  async function removePromotedDirectory(
    c: SpeechPackComponent,
    ownership: RollbackOwnership,
    transaction: symbol
  ): Promise<boolean> {
    const promoted = ownership.promoted
    if (!promoted) return true
    if (!(await rollbackOwnershipCurrent(c, ownership))) return false
    if (
      !(await authorizePriorPackRestore(
        c.id,
        ownership.previousMarker?.marker ?? null,
        options.authorizeRollback,
        options.authorizeRollbackCurrent,
        transaction
      ))
    )
      return false
    if (
      !(await rollbackOwnershipCurrent(c, ownership)) ||
      !(await physicalPathVersionMatches(promoted.path, promoted.version)) ||
      !(await options.dirVerified(c, promoted.path)) ||
      !(await physicalPathVersionMatches(promoted.path, promoted.version))
    )
      return false
    if (
      !(await removeInspectedTree(promoted.path, promoted.version, c.files.length * 2 + 1, (relative, kind) =>
        packTreeAllowed(c, relative, kind)
      ))
    )
      return false
    ownership.promoted = null
    return !(await exists(promoted.path))
  }

  async function removeOwnedMarker(
    c: SpeechPackComponent,
    ownership: RollbackOwnership,
    transaction: symbol
  ): Promise<boolean> {
    const expected = ownership.promotedMarker ?? ownership.previousMarker
    if (!(await installDirectoriesCurrent(c, ownership.directories)) || !(await markerFileMatches(c, expected)))
      return false
    if (
      !(await authorizePriorPackRestore(
        c.id,
        ownership.previousMarker?.marker ?? null,
        options.authorizeRollback,
        options.authorizeRollbackCurrent,
        transaction
      ))
    )
      return false
    if (
      !(await installDirectoriesCurrent(c, ownership.directories)) ||
      !(await markerFileMatches(c, expected)) ||
      !priorPackRestoreStillCurrent(
        c.id,
        ownership.previousMarker?.marker ?? null,
        options.authorizeRollbackCurrent,
        transaction
      )
    )
      return false
    await rm(markerPath(c), { force: true })
    return !(await exists(markerPath(c)))
  }

  async function deactivate(
    c: SpeechPackComponent,
    ownership: RollbackOwnership,
    transaction: symbol
  ): Promise<boolean> {
    if (!(await rollbackOwnershipCurrent(c, ownership))) return false
    try {
      return await rollbackSpeechPackActivation({
        currentVersion: c.version,
        hadAside: ownership.aside !== null,
        previousMarker: ownership.previousMarker?.marker ? { marker: ownership.previousMarker.marker } : null,
        authorize: () =>
          authorizePriorPackRestore(
            c.id,
            ownership.previousMarker?.marker ?? null,
            options.authorizeRollback,
            options.authorizeRollbackCurrent,
            transaction
          ),
        stillCurrent: () =>
          priorPackRestoreStillCurrent(
            c.id,
            ownership.previousMarker?.marker ?? null,
            options.authorizeRollbackCurrent,
            transaction
          ),
        restoreMarker: () => restoreMarkerSnapshot(c, ownership, transaction),
        removeCurrent: () => removePromotedDirectory(c, ownership, transaction),
        restoreAside: () => restoreAside(c, ownership, transaction),
        removeMarker: () => removeOwnedMarker(c, ownership, transaction)
      })
    } catch {
      return false
    }
  }

  async function removeVerifiedAsides(
    c: SpeechPackComponent,
    rootOwner: PhysicalOwner,
    componentOwner: PhysicalOwner,
    activeVersion: PhysicalPathVersion,
    activeMarker: SpeechPackMarkerSnapshot
  ): Promise<void> {
    const receipts = asideReceipts.get(rootDir)
    if (!receipts) return
    for (const [key, receipt] of receipts) {
      const path = receipt.path
      if (
        receipt.componentId !== c.id ||
        dirname(path) !== componentDir(c) ||
        !basename(path).startsWith(`${c.version}.old-`)
      )
        continue
      const version = await capturePhysicalPathVersion(path, 'directory')
      if (!version && !(await exists(path))) {
        receipts.delete(key)
        continue
      }
      if (
        !version ||
        version.dev !== receipt.owner.dev ||
        version.ino !== receipt.owner.ino ||
        !(await options.dirVerified(c, path))
      )
        continue
      if (
        !(await physicalOwnerMatches(rootDir, rootOwner, 'directory')) ||
        !(await physicalOwnerMatches(componentDir(c), componentOwner, 'directory')) ||
        !(await physicalPathVersionMatches(path, version)) ||
        !(await physicalPathVersionMatches(finalDir(c), activeVersion)) ||
        !(await markerFileMatches(c, activeMarker)) ||
        !(await physicalOwnerMatches(rootDir, rootOwner, 'directory')) ||
        !(await physicalOwnerMatches(componentDir(c), componentOwner, 'directory')) ||
        !(await physicalPathVersionMatches(path, version)) ||
        !(await physicalPathVersionMatches(finalDir(c), activeVersion))
      )
        continue
      try {
        if (
          await removeInspectedTree(path, version, c.files.length * 2 + 1, (relative, kind) =>
            packTreeAllowed(c, relative, kind)
          )
        )
          receipts.delete(key)
      } catch {
        // An incomplete cleanup leaves its receipt available for a later owned retry.
      }
    }
  }

  async function cleanupAfterVerifiedInitialize(
    c: SpeechPackComponent,
    marker: SpeechPackMarkerSnapshot | null
  ): Promise<boolean> {
    if (
      !marker ||
      marker.marker.version !== c.version ||
      marker.marker.manifestIdentity !== componentManifestIdentity(c) ||
      !(await markerFileMatches(c, marker)) ||
      !(await options.dirVerified(c, finalDir(c)))
    )
      return false
    const [rootOwner, ownedComponent, activeVersion] = await Promise.all([
      capturePhysicalOwner(rootDir, 'directory'),
      capturePhysicalOwner(componentDir(c), 'directory'),
      capturePhysicalPathVersion(finalDir(c), 'directory')
    ])
    if (
      !rootOwner ||
      !ownedComponent ||
      !activeVersion ||
      !(await markerFileMatches(c, marker)) ||
      !(await physicalPathVersionMatches(finalDir(c), activeVersion))
    )
      return false
    await removeVerifiedAsides(c, rootOwner, ownedComponent, activeVersion, marker)
    return (
      (await physicalOwnerMatches(rootDir, rootOwner, 'directory')) &&
      (await physicalOwnerMatches(componentDir(c), ownedComponent, 'directory')) &&
      (await physicalPathVersionMatches(finalDir(c), activeVersion)) &&
      (await markerFileMatches(c, marker)) &&
      (await options.dirVerified(c, finalDir(c)))
    )
  }

  async function cleanupStaging(c: SpeechPackComponent, owners: InstallDirectoryOwners): Promise<boolean> {
    const base = stagingBaseDir(c)
    if (!(await installDirectoriesCurrent(c, owners))) return false
    const version = await capturePhysicalPathVersion(base, 'directory')
    if (!version || version.dev !== owners.stagingBase.dev || version.ino !== owners.stagingBase.ino) return false
    let removed = false
    try {
      removed = await removeInspectedTree(base, version, treeEntryLimit(c), (relative, kind) =>
        stagingTreeAllowed(c, relative, kind)
      )
    } catch {
      return false
    }
    return removed && (await physicalOwnerMatches(rootDir, owners.root, 'directory'))
  }

  async function captureOwnedExtract(path: string, c: SpeechPackComponent): Promise<TreeEntry[] | null> {
    return ownedTree.captureExtractTree(path, c)
  }

  async function removeOwnedWork(
    c: SpeechPackComponent,
    owners: InstallDirectoryOwners,
    expectedExtract?: TreeEntry[]
  ): Promise<boolean> {
    const work = workDir(c)
    if (!(await installDirectoriesCurrent(c, owners))) return false
    const version = await capturePhysicalPathVersion(work, 'directory')
    if (!version || version.dev !== owners.work.dev || version.ino !== owners.work.ino) return false
    try {
      const archivePrefix = c.source.kind === 'archive' ? c.source.entryPrefix : null
      const movedExtractFiles = new Set(archivePrefix ? c.files.map((file) => `${archivePrefix}/${file.path}`) : [])
      return await ownedTree.removeInspectedTree(
        work,
        version,
        treeEntryLimit(c),
        (relative, kind) => {
          if (relative === '') return kind === 'directory'
          if (relative === 'extract') return Boolean(expectedExtract) && kind === 'directory'
          if (relative.startsWith('extract/')) return Boolean(expectedExtract) && isSafeEntryName(relative.slice(8))
          return (
            kind === 'file' &&
            ['archive.download', 'archive.download.partial', 'archive.download.partial.json'].includes(relative)
          )
        },
        expectedExtract,
        movedExtractFiles
      )
    } catch {
      return false
    }
  }

  return {
    captureInstallDirectories,
    prepareOwnedInstallDirectories,
    requiredOwner,
    installDirectoriesCurrent,
    optionalDirectoryOwnerMatches,
    readMarkerSnapshot,
    markerFileMatches,
    writeMarker,
    rollbackOwnershipCurrent,
    removeVerifiedAsides,
    cleanupAfterVerifiedInitialize,
    cleanupStaging,
    removeOwnedWork,
    captureOwnedExtract,
    recordOwnedAside,
    deactivate,
    capturePhysicalOwner,
    capturePhysicalPathVersion,
    physicalOwnerMatches,
    physicalPathVersionMatches
  }
}
