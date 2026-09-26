import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Check, FolderOpen, Link2 } from 'lucide-react'
import type { BrainScanHit, PublicSettings } from '@shared/ipc'

/**
 * Happy-path Mantu Intelligence connect: scan OneDrive for an existing second brain, then Connect.
 * Path paste is the power path (collapsed). Settings and onboarding setup both mount this.
 */
export function BrainConnectPanel({
  settings,
  patch,
  variant = 'settings',
  autoScan = true
}: {
  settings: PublicSettings
  patch: (p: Partial<PublicSettings>) => void
  variant?: 'settings' | 'setup'
  autoScan?: boolean
}): JSX.Element {
  const [hits, setHits] = useState<BrainScanHit[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanErr, setScanErr] = useState<string | null>(null)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [connectErr, setConnectErr] = useState<string | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pastePath, setPastePath] = useState('')

  const scan = useCallback(async (): Promise<void> => {
    setScanning(true)
    setScanErr(null)
    try {
      const result = await window.toto.brainScanOneDrive()
      setHits(result.hits)
      if (result.error) setScanErr(result.error)
    } catch (e) {
      setScanErr(e instanceof Error ? e.message : 'Could not scan OneDrive.')
      setHits([])
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    if (autoScan) void scan()
  }, [autoScan, scan])

  const connect = async (path: string): Promise<void> => {
    const target = path.trim()
    if (!target) {
      setConnectErr('Paste or pick a folder path first.')
      return
    }
    setConnecting(target)
    setConnectErr(null)
    try {
      const result = await window.toto.brainConnect(target)
      if (!result.ok) {
        setConnectErr(result.error)
        return
      }
      await Promise.resolve(patch({}))
      const refreshed = await window.toto.brainScanOneDrive()
      setHits(refreshed.hits)
    } catch (e) {
      setConnectErr(e instanceof Error ? e.message : 'Could not connect that folder.')
    } finally {
      setConnecting(null)
    }
  }

  const connectedPath = settings.meetingsFolder || settings.resolvedMeetingsFolder
  const setup = variant === 'setup'

  return (
    <div
      className={
        setup
          ? 'mt-1.5 flex flex-col gap-1.5'
          : 'cl-card flex flex-col gap-2 px-3 py-2.5'
      }
      data-brain-connect
    >
      {!setup && (
        <div className="flex items-center gap-2">
          <FolderOpen size={15} className="shrink-0 text-[color:var(--cl-primary)]" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--cl-foreground)]" title={connectedPath}>
            {connectedPath || 'No brain folder connected yet'}
          </span>
        </div>
      )}
      {setup && connectedPath && (
        <p className="m-0 text-[11px] leading-snug text-[color:var(--color-ink-3)]" title={connectedPath}>
          Connected: {connectedPath}
        </p>
      )}
      <p className={setup ? 'm-0 text-[11px] leading-snug text-[color:var(--color-ink-3)]' : 'text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]'}>
        Scan OneDrive for an existing second brain (AI Second Brain, wiki, or .brain). Connect keeps that folder as the Mantu Intelligence root after relaunch.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void scan()}
          disabled={scanning}
          className={
            setup
              ? 'no-drag focus-ring rounded-full bg-[var(--color-accent)]/15 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-accent-2)] hover:bg-[var(--color-accent)]/25 disabled:opacity-60'
              : 'no-drag cl-focus flex items-center gap-1 rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.1] disabled:opacity-60'
          }
        >
          {scanning ? 'Scanning…' : hits ? 'Scan again' : 'Scan OneDrive'}
        </button>
      </div>
      {scanErr && (
        <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--cl-destructive)]">
          <AlertCircle size={12} className="shrink-0" /> {scanErr}
        </div>
      )}
      {hits && hits.length === 0 && !scanning && (
        <p className={setup ? 'm-0 text-[11px] text-[color:var(--color-ink-3)]' : 'text-[12px] text-[color:var(--cl-muted-foreground)]'} role="status">
          No OneDrive second brain found. Save a meeting, or paste a folder path below.
        </p>
      )}
      {hits && hits.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {hits.map((hit) => {
            const active = hit.connected || hit.path === connectedPath
            return (
              <li
                key={hit.path}
                className={
                  setup
                    ? 'flex items-start gap-2 rounded-lg bg-white/[0.04] px-2 py-1.5'
                    : 'flex items-start gap-2 rounded-lg bg-white/[0.04] px-2 py-1.5'
                }
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] text-[color:var(--cl-foreground)]">{hit.label}</div>
                  <div className="truncate text-[10px] text-[color:var(--cl-muted-foreground)]" title={hit.path}>
                    {hit.markers.length > 0 ? hit.markers.join(' · ') : 'Existing folder'}
                  </div>
                </div>
                {active ? (
                  <span className="flex shrink-0 items-center gap-1 text-[11px] text-[color:var(--color-accent-2)]">
                    <Check size={12} /> Connected
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void connect(hit.path)}
                    disabled={connecting !== null}
                    className="no-drag focus-ring shrink-0 rounded-md bg-[var(--cl-primary)] px-2 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-60"
                  >
                    {connecting === hit.path ? 'Connecting…' : 'Connect'}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {connectErr && (
        <div className="flex items-center gap-1.5 text-[11px] text-[color:var(--cl-destructive)]">
          <AlertCircle size={12} className="shrink-0" /> {connectErr}
        </div>
      )}
      <div>
        <button
          type="button"
          onClick={() => setPasteOpen((v) => !v)}
          className="no-drag focus-ring text-[11px] text-[color:var(--cl-muted-foreground)] hover:text-[color:var(--cl-foreground)]"
        >
          <Link2 size={11} className="mr-1 inline" />
          {pasteOpen ? 'Hide path paste' : 'Paste a path (power path)'}
        </button>
        {pasteOpen && (
          <div className="mt-1.5 flex flex-col gap-1.5">
            <input
              type="text"
              value={pastePath}
              onChange={(e) => setPastePath(e.target.value)}
              placeholder="/Users/you/Library/CloudStorage/OneDrive-MantuGroup/Documents/AI Second Brain"
              spellCheck={false}
              className="no-drag cl-focus w-full rounded-lg border border-[var(--cl-input)] bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-[color:var(--cl-foreground)]"
            />
            <button
              type="button"
              onClick={() => void connect(pastePath)}
              disabled={connecting !== null}
              className="no-drag cl-focus self-start rounded-lg bg-white/[0.05] px-2.5 py-1.5 text-[12px] text-[color:var(--cl-foreground)] hover:bg-white/[0.1] disabled:opacity-60"
            >
              Connect pasted path
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
