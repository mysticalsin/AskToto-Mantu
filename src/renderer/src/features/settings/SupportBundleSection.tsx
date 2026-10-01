import { useCallback, useEffect, useState } from 'react'
import { Check, ExternalLink, RefreshCw } from 'lucide-react'
import type { UpdateCheckResult } from '@shared/ipc'
import { TextButton } from '../../components/ui'
import { Section } from '../../ui/Section'
import { AgentStatus } from '../../components/AgentStatus'

/** Settings → About → Diagnostics. Nothing in this app uploads anywhere (zero telemetry, crash upload
 *  off), so when support needs the log trail the user exports it themselves: main + audit logs, crash
 *  dumps and the boot sentinel into a folder they choose — never meetings, the brain, or settings. */
export function SupportBundleSection(): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; path?: string; files?: number; error?: string; cancelled?: boolean } | null>(null)
  const exportBundle = async (): Promise<void> => {
    setBusy(true)
    try {
      setResult(await window.toto.diagnosticsExport())
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title="Diagnostics" desc="Export the app's logs for support. Never includes meetings, notes, or the knowledge graph.">
      <div className="flex flex-col items-center gap-2">
        <TextButton onClick={() => void exportBundle()} disabled={busy}>
          {busy ? 'Exporting…' : 'Export diagnostics bundle'}
        </TextButton>
        {result?.ok && (
          <span className="text-[12px] text-[color:var(--cl-muted-foreground)]">
            Exported {result.files} file{result.files === 1 ? '' : 's'} to {result.path}
          </span>
        )}
        {result && !result.ok && !result.cancelled && (
          <span className="text-[12px] text-[var(--color-danger)]">{result.error}</span>
        )}
      </div>
    </Section>
  )
}

/** Settings → About → Updates. electron-updater's silent flow still auto-installs where the platform
 *  supports it (it then shows the UpdateReadyToast); this row exists so EVERY build — including
 *  unsigned macOS ones that cannot auto-install — can still DISCOVER that a newer version was
 *  published and reach the download page. Auto-checks once when the section mounts (i.e. when the
 *  user opens About), manual re-check any time. */
export function UpdatesSection(): JSX.Element {
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  // The in-app download lifecycle, driven by the electron-updater events (onUpdateProgress/onUpdateReady):
  // 'idle' → 'downloading' (percent) → 'ready' (Restart & install). 'blocked' means this build can't
  // self-install (portable / Store / policy / dev) — the download-page link is offered instead.
  const [phase, setPhase] = useState<'idle' | 'downloading' | 'ready' | 'blocked'>('idle')
  const [percent, setPercent] = useState(0)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  const check = useCallback((): void => {
    setChecking(true)
    void window.toto
      .checkForUpdate()
      .then(setResult)
      .catch((e) => setResult({ ok: false, current: '', error: e instanceof Error ? e.message : String(e) }))
      .finally(() => setChecking(false))
  }, [])
  useEffect(() => {
    check()
  }, [check])

  // Stream download progress + the ready signal from electron-updater the whole time this section is open,
  // so a download already running in the background (auto-update) shows here too, not only when we started it.
  useEffect(() => {
    const offProgress = window.toto.onUpdateProgress((d) => {
      setPercent(Math.max(0, Math.min(100, Math.round(d?.percent ?? 0))))
      setPhase((p) => (p === 'ready' ? p : 'downloading'))
    })
    const offReady = window.toto.onUpdateReady(() => {
      setPercent(100)
      setPhase('ready')
    })
    // A download that was running just died (proxy, sleep, checksum, signature). 'blocked' is the state
    // that renders the download-page link, so the fallback below stops being unreachable mid-download.
    const offError = window.toto.onUpdateError((d) => {
      setPhase('blocked')
      setDownloadError(d?.message ?? 'The update download failed. Open the download page to install manually.')
    })
    return () => {
      offProgress()
      offReady()
      offError()
    }
  }, [])

  const startDownload = useCallback((): void => {
    setDownloadError(null)
    setPercent(0)
    setPhase('downloading')
    void window.toto
      .downloadUpdate()
      .then((r) => {
        if (!r.started) {
          setPhase('blocked')
          if (r.reason) setDownloadError(r.reason)
        }
      })
      .catch((e) => {
        setPhase('blocked')
        setDownloadError(e instanceof Error ? e.message : String(e))
      })
  }, [])

  return (
    <Section title="Updates" desc="Métis installs a QA-approved Latest from Metis-Releases. Draft and prerelease builds are never offered." icon={RefreshCw}>
      <div className="flex flex-col items-center gap-2">
        {result?.current ? (
          <span className="text-[12px] text-[color:var(--cl-muted-foreground)]">Installed version: {result.current}</span>
        ) : null}

        {result?.ok && result.available && phase === 'idle' && (
          <button
            onClick={startDownload}
            className="no-drag focus-ring rounded-full bg-[color:var(--cl-primary)] px-3 py-1.5 text-[12px] font-medium text-[color:var(--cl-primary-foreground)] transition-colors hover:opacity-90"
          >
            Download &amp; install version {result.latest}
          </button>
        )}

        {phase === 'downloading' && (
          <div className="flex w-full max-w-[220px] flex-col items-center gap-1.5">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--cl-border)]">
              <div
                className="h-full rounded-full bg-[color:var(--cl-primary)] transition-[width] duration-300 ease-out"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="text-[11px] text-[color:var(--cl-muted-foreground)]">Downloading update… {percent}%</span>
          </div>
        )}

        {phase === 'ready' && (
          <button
            onClick={() => void window.toto.installUpdate()}
            className="no-drag focus-ring rounded-full bg-[color:var(--cl-primary)] px-3 py-1.5 text-[12px] font-medium text-[color:var(--cl-primary-foreground)] transition-colors hover:opacity-90"
          >
            Restart &amp; install now
          </button>
        )}

        {/* Download-page fallback: a build that cannot self-install (portable / Store / managed / unsigned mac),
            or any download-start failure. Always reachable so the user is never stranded. */}
        {result?.ok && result.available && (phase === 'blocked' || phase === 'idle') && (
          <a
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-[color:var(--cl-muted-foreground)] underline transition-colors hover:text-[color:var(--cl-foreground)]"
          >
            {phase === 'blocked' ? 'Open the download page instead' : 'Or open the download page'}
          </a>
        )}
        {downloadError && <span className="text-[11px] text-[var(--color-danger)]">{downloadError}</span>}

        {result?.ok && !result.available && phase === 'idle' && (
          <span className="text-[12px] text-[color:var(--cl-muted-foreground)]">You&apos;re on the latest version.</span>
        )}
        {result && !result.ok && <span className="text-[12px] text-[var(--color-danger)]">{result.error}</span>}
        <TextButton onClick={check} disabled={checking}>
          {checking ? <AgentStatus kind="searching" size="inline" caption /> : 'Check for updates'}
        </TextButton>
      </div>
    </Section>
  )
}
