import { useEffect, useState } from 'react'
import { FileText } from 'lucide-react'
import {
  ARTIFACT_CHANGED_NOTICE,
  ARTIFACT_NOTICES,
  artifactContentType,
  artifactFailureNotice,
  type ArtifactActionResult,
  type ArtifactChip
} from '@shared/artifact'
import { TextButton } from './ui'

const formatBytes = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`

/**
 * The files a turn produced (G53). Only an artifact main has just verified (record exists, file exists with the
 * recorded digest) is shown as a file; a moved or changed one says so and offers nothing. Nothing here holds a path:
 * every action is by artifact id and main resolves it.
 */
export function ArtifactChips({
  turnId,
  settled
}: {
  turnId: string | undefined
  settled: boolean
}): JSX.Element | null {
  const [chips, setChips] = useState<ArtifactChip[]>([])
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    if (!turnId || !settled) return
    let live = true
    // Answer is also rendered by surfaces whose bridge predates G53 (demo seeding, design capture): show nothing there.
    const load = window.toto?.getTurnArtifacts
    if (!load) return
    load(turnId)
      .then((result) => {
        if (live) setChips(result.chips)
      })
      .catch(() => {
        if (live) setChips([])
      })
    return () => {
      live = false
    }
  }, [turnId, settled])

  const run = (action: Promise<ArtifactActionResult>, success: string | null = null): void => {
    setFailure(null)
    void settleArtifactAction(action).then((notice) => setFailure(notice ?? success))
  }

  return (
    <ArtifactChipList
      chips={chips}
      failure={failure}
      onOpen={(id) => run(window.toto.openArtifact(id))}
      onReveal={(id) => run(window.toto.revealArtifact(id))}
      onPreview={(id) => run(window.toto.previewArtifact(id))}
      onCopy={(id) => run(window.toto.copyArtifact(id), ARTIFACT_NOTICES.copied)}
      onArm={(id) => void window.toto.armArtifactDrag(id).catch(() => {})}
      onDrag={(id) => window.toto.startArtifactDrag(id)}
    />
  )
}

/** The notice to show after an open or reveal: none on success, the honest moved-or-changed line otherwise. */
export async function settleArtifactAction(
  action: Promise<{ ok: boolean } | ArtifactActionResult>
): Promise<string | null> {
  try {
    const result = await action
    return result.ok ? null : artifactFailureNotice(result as ArtifactActionResult)
  } catch {
    return artifactFailureNotice({ ok: false, reason: 'changed' })
  }
}

export function ArtifactChipList({
  chips,
  failure,
  onOpen,
  onReveal,
  onPreview,
  onCopy,
  onArm,
  onDrag
}: {
  chips: ArtifactChip[]
  failure: string | null
  onOpen(artifactId: string): void
  onReveal(artifactId: string): void
  onPreview(artifactId: string): void
  onCopy(artifactId: string): void
  onArm(artifactId: string): void
  onDrag(artifactId: string): void
}): JSX.Element | null {
  if (chips.length === 0) return null
  return (
    <div className="answer__artifacts flex flex-col gap-1" role="group" aria-label="Files from this answer">
      {chips.map((chip) =>
        chip.status === 'ready' ? (
          <div
            key={chip.artifactId}
            draggable
            onPointerDown={() => onArm(chip.artifactId)}
            onDragStart={(e) => {
              // The OS drag is started by main, for the recorded file only; the browser's own drag is cancelled.
              e.preventDefault()
              onDrag(chip.artifactId)
            }}
            className="answer__artifact flex items-center gap-1.5 text-[11px] text-[color:var(--color-ink-2)]"
          >
            <FileText size={11} />
            <span className="truncate">{chip.displayName}</span>
            <span className="text-[color:var(--color-ink-3)]">{formatBytes(chip.bytes)}</span>
            <TextButton ariaLabel={`Open ${chip.displayName}`} onClick={() => onOpen(chip.artifactId)}>
              Open
            </TextButton>
            <TextButton ariaLabel={`Show in folder ${chip.displayName}`} onClick={() => onReveal(chip.artifactId)}>
              Show in folder
            </TextButton>
            {artifactContentType(chip.displayName) && (
              <>
                <TextButton ariaLabel={`Preview ${chip.displayName}`} onClick={() => onPreview(chip.artifactId)}>
                  Preview
                </TextButton>
                <TextButton ariaLabel={`Copy ${chip.displayName}`} onClick={() => onCopy(chip.artifactId)}>
                  Copy
                </TextButton>
              </>
            )}
          </div>
        ) : (
          <div key={chip.artifactId} className="answer__artifact text-[11px] text-[color:var(--color-ink-3)]">
            {chip.displayName}: {ARTIFACT_CHANGED_NOTICE}
          </div>
        )
      )}
      {failure && (
        <div
          role={failure === ARTIFACT_NOTICES.copied ? 'status' : 'alert'}
          className={`text-[11px] ${failure === ARTIFACT_NOTICES.copied ? 'text-[color:var(--color-ink-2)]' : 'text-[var(--color-danger)]'}`}
        >
          {failure}
        </div>
      )}
    </div>
  )
}
