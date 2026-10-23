import type { ArtifactActionResult, ArtifactChip, ArtifactRecord, TurnArtifacts } from '@shared/artifact'
import type { ArtifactFs } from './artifact-fs'
import { isExecutableType, type ArtifactRegistry } from './registry'
import { matchesFingerprint, verifyArtifactFile, type FileFingerprint } from './verify'

export interface ArtifactServiceDeps {
  registry: ArtifactRegistry
  fs: ArtifactFs
  /** OS open of a file; resolves to an error string, or '' on success. */
  openPath(path: string): Promise<string>
  showItemInFolder(path: string): void
  now(): number
  /** How long after `arm` a drag may start. */
  armWindowMs?: number
}

export interface DragItem {
  file: string
}

export interface ArtifactService {
  /** The turn's output manifest and one verified chip per artifact, in creation order. */
  forTurn(turnId: string): Promise<TurnArtifacts>
  open(artifactId: string): Promise<ArtifactActionResult>
  reveal(artifactId: string): Promise<ArtifactActionResult>
  /**
   * Pointer-down on a chip: re-checks that the file still looks as it did when it was verified (size, mtime, inode, not
   * a symlink; no digest) and arms a drag for a few seconds. Asynchronous, so the drag itself never has to touch the disk.
   */
  arm(artifactId: string): Promise<ArtifactActionResult>
  /**
   * Starts the OS drag of exactly the recorded file, only while armed. Synchronous, because the drag must begin inside the
   * user's gesture. `begin` is only ever handed the recorded path, never anything from the renderer.
   */
  dragStart(artifactId: string, begin: (item: DragItem) => void): ArtifactActionResult
}

const toChip = (record: ArtifactRecord, status: ArtifactChip['status']): ArtifactChip => ({
  artifactId: record.artifactId,
  turnId: record.turnId,
  kind: record.kind,
  displayName: record.displayName,
  bytes: record.bytes,
  createdAt: record.createdAt,
  producer: record.provenance.producer,
  status
})

export function createArtifactService(deps: ArtifactServiceDeps): ArtifactService {
  const { registry, fs } = deps
  const verified = new Map<string, FileFingerprint>()
  const armedUntil = new Map<string, number>()
  const armWindowMs = deps.armWindowMs ?? 5000

  async function check(
    artifactId: string
  ): Promise<{ record: ArtifactRecord; status: 'ready' | 'missing' | 'changed' } | null> {
    const record = registry.get(artifactId)
    if (!record) return null
    const result = await verifyArtifactFile(record, fs)
    if (result.status === 'ready') verified.set(artifactId, result.fingerprint)
    else {
      verified.delete(artifactId)
      armedUntil.delete(artifactId)
    }
    return { record, status: result.status }
  }

  async function act(artifactId: string, run: (record: ArtifactRecord) => Promise<ArtifactActionResult>) {
    const checked = await check(artifactId)
    if (!checked) return { ok: false, reason: 'not-found' } as const
    if (checked.status !== 'ready') return { ok: false, reason: checked.status } as const
    return run(checked.record)
  }

  return {
    async forTurn(turnId) {
      const manifest = registry.outputManifest(turnId)
      const chips: ArtifactChip[] = []
      for (const id of manifest.artifactIds) {
        const checked = await check(id)
        if (checked) chips.push(toChip(checked.record, checked.status))
      }
      return { manifest, chips }
    },
    open: (artifactId) =>
      act(artifactId, async (record) => {
        if (isExecutableType(record.path)) return { ok: false, reason: 'blocked' }
        return (await deps.openPath(record.path)) === '' ? { ok: true } : { ok: false, reason: 'failed' }
      }),
    reveal: (artifactId) =>
      act(artifactId, async (record) => {
        deps.showItemInFolder(record.path)
        return { ok: true }
      }),
    async arm(artifactId) {
      const record = registry.get(artifactId)
      if (!record) return { ok: false, reason: 'not-found' }
      const expected = verified.get(artifactId)
      if (!expected || !(await matchesFingerprint(record, expected, fs))) {
        verified.delete(artifactId)
        armedUntil.delete(artifactId)
        return { ok: false, reason: 'changed' }
      }
      armedUntil.set(artifactId, deps.now() + armWindowMs)
      return { ok: true }
    },
    dragStart(artifactId, begin) {
      const record = registry.get(artifactId)
      if (!record) return { ok: false, reason: 'not-found' }
      const until = armedUntil.get(artifactId)
      if (until === undefined || deps.now() > until) {
        armedUntil.delete(artifactId)
        return { ok: false, reason: 'changed' }
      }
      begin({ file: record.path })
      return { ok: true }
    }
  }
}
