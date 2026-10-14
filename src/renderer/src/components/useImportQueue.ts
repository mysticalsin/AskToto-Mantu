import { useCallback, useEffect, useState, type DragEvent } from 'react'
import type { ImportAssetsProgress, ImportJobView, ImportAudioPickResult } from '@shared/ipc'
import { isImportDropFile, pickedFiles, skippedImportMessage } from './import-queue'

const SUMMARY_ONLY_IMPORT_NOTICE =
  'Recording import currently requires retaining a full transcript. Your organization’s summary-only policy prevents import. Your original recording is unchanged.'

export function useImportQueue(refreshList: () => void) {
  const [jobs, setJobs] = useState<ImportJobView[]>([])
  const [policyBlocked, setPolicyBlocked] = useState(false)
  const [policyHeldJobIds, setPolicyHeldJobIds] = useState<string[]>([])
  const [inventoryOverflow, setInventoryOverflow] = useState(false)
  const [policyHoldOverflow, setPolicyHoldOverflow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [assets, setAssets] = useState<ImportAssetsProgress | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const upsertJob = useCallback((job: ImportJobView): void => {
    setJobs((current) => [job, ...current.filter((existing) => existing.jobId !== job.jobId)])
  }, [])

  useEffect(() => {
    let stale = false
    let snapshotRequest = 0
    const refreshSnapshot = (): void => {
      const request = ++snapshotRequest
      window.toto
        .importJobsList()
        .then((snapshot) => {
          if (stale || request !== snapshotRequest) return
          const heldViews: ImportJobView[] = snapshot.heldJobIds.map((jobId) => ({
            jobId,
            title: 'Saved import',
            state: 'policy-held',
            cursor: 0,
            totalChunks: 0,
            pct: null,
            createdAt: 0,
            updatedAt: 0
          }))
          setJobs([
            ...snapshot.jobs,
            ...heldViews.filter((held) => !snapshot.jobs.some((job) => job.jobId === held.jobId))
          ])
          setPolicyBlocked(snapshot.policyBlocked)
          setPolicyHeldJobIds(snapshot.policyHeldJobIds)
          setInventoryOverflow(snapshot.inventoryOverflow)
          setPolicyHoldOverflow(snapshot.policyHoldOverflow)
          if (snapshot.policyBlocked) setError(null)
        })
        .catch(() => {})
    }
    refreshSnapshot()
    const unsub = window.toto.onImportAudioProgress(({ job }) => {
      if (stale || policyBlocked) return
      upsertJob(job)
      if (job.state === 'done') refreshList()
    })
    const unsubAssets = window.toto.onImportAssetsProgress((progress) => {
      if (!stale) setAssets(progress)
    })
    const unsubSettings = window.toto.onSettingsChanged(refreshSnapshot)
    return () => {
      stale = true
      unsub()
      unsubAssets()
      unsubSettings()
    }
  }, [policyBlocked, refreshList, upsertJob])

  const startPickedImports = useCallback(
    async (picked: ImportAudioPickResult): Promise<void> => {
      if (policyBlocked) {
        setError(SUMMARY_ONLY_IMPORT_NOTICE)
        return
      }
      const files = pickedFiles(picked)
      const skip = skippedImportMessage(picked)
      if (skip) setError(skip)
      if (!files.length) {
        if (!skip) setError(picked.error || 'Could not prepare the selected recordings.')
        return
      }
      try {
        const started = await window.toto.importAudioStartBatch(files.map((file) => file.token))
        for (const job of started) upsertJob(job)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not start the imports.')
      }
    },
    [policyBlocked, upsertJob]
  )

  const importAudio = useCallback(async (): Promise<void> => {
    setError(null)
    if (policyBlocked) {
      setError(SUMMARY_ONLY_IMPORT_NOTICE)
      return
    }
    let picked: ImportAudioPickResult
    try {
      picked = await window.toto.importAudioPick()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not open the file picker.')
      return
    }
    if (picked.cancelled) return
    await startPickedImports(picked)
  }, [policyBlocked, startPickedImports])

  const onDragOver = useCallback((event: DragEvent): void => {
    if (![...event.dataTransfer.types].includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }, [])

  const onDragLeave = useCallback((event: DragEvent): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node)) return
    setDragOver(false)
  }, [])

  const onDrop = useCallback(
    async (event: DragEvent): Promise<void> => {
      event.preventDefault()
      setDragOver(false)
      if (policyBlocked) {
        setError(SUMMARY_ONLY_IMPORT_NOTICE)
        return
      }
      const files = [...event.dataTransfer.files].filter(isImportDropFile)
      if (!files.length) {
        setError('Drop audio or video recordings to import them.')
        return
      }
      setError(null)
      try {
        await startPickedImports(await window.toto.importAudioDrop(files))
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not import the dropped recordings.')
      }
    },
    [policyBlocked, startPickedImports]
  )

  const cancel = useCallback((jobId: string): void => {
    void window.toto.importJobCancel(jobId).catch((caught) => {
      setError(caught instanceof Error ? caught.message : 'Could not cancel the import.')
    })
  }, [])

  const resume = useCallback(
    (jobId: string): void => {
      void window.toto
        .importJobResume(jobId)
        .then(upsertJob)
        .catch((caught) => {
          setError(caught instanceof Error ? caught.message : 'Could not resume the import.')
        })
    },
    [upsertJob]
  )

  const dismiss = useCallback((jobId: string): void => {
    void window.toto
      .importJobRemove(jobId)
      .then(() => setJobs((current) => current.filter((job) => job.jobId !== jobId)))
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : 'Could not dismiss the import.')
      })
  }, [])

  return {
    jobs,
    policyBlocked,
    policyHeldJobIds,
    inventoryOverflow,
    policyHoldOverflow,
    error,
    assets,
    dragOver,
    importAudio,
    onDragOver,
    onDragLeave,
    onDrop,
    cancel,
    resume,
    dismiss
  }
}
