import { useEffect, useRef, useState } from 'react'
import { Globe } from 'lucide-react'
import { TASK_BROWSER_COPY, type TaskBrowserStatus } from '@shared/task-browser'
import { TextButton } from '../../components/ui'
import { Section } from '../../ui/Section'

const HINT = 'text-[11px] leading-snug text-[color:var(--cl-muted-foreground)]'

/**
 * Settings: the task browser (G41, D-21). Métis opens its own browser window for a task, with its own profile. This
 * section tells the person that once, lets them clear that profile, and says honestly that using their current tab is
 * not available. It cannot open a window: the bridge takes no address.
 */
export function TaskBrowserSection(): JSX.Element {
  const [status, setStatus] = useState<TaskBrowserStatus | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  // When the confirm closes, focus returns to the Clear button instead of dropping to the page body.
  const clearRow = useRef<HTMLDivElement>(null)
  const wasConfirming = useRef(false)
  useEffect(() => {
    if (wasConfirming.current && !confirming) clearRow.current?.querySelector('button')?.focus()
    wasConfirming.current = confirming
  }, [confirming])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const next = await window.toto.taskBrowser.status()
        if (!cancelled) setStatus(next)
      } catch {
        /* no bridge (a test host): the section still shows its words */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const acknowledge = async (): Promise<void> => {
    const result = await window.toto.taskBrowser.acknowledge()
    if (result.ok) setStatus((s) => (s ? { ...s, disclosureAcknowledged: true } : s))
  }
  const clear = async (): Promise<void> => {
    setConfirming(false)
    const result = await window.toto.taskBrowser.clear()
    setMessage(result.ok ? TASK_BROWSER_COPY.cleared : TASK_BROWSER_COPY.clearFailed)
    if (result.ok) setStatus((s) => (s ? { ...s, openWindows: 0 } : s))
  }

  return (
    <Section title={TASK_BROWSER_COPY.title} desc={TASK_BROWSER_COPY.desc} icon={Globe}>
      <div className="flex flex-col gap-2">
        <p className={HINT}>{TASK_BROWSER_COPY.disclosure}</p>
        {status && !status.disclosureAcknowledged && (
          <div>
            <TextButton onClick={() => void acknowledge()}>{TASK_BROWSER_COPY.acknowledge}</TextButton>
          </div>
        )}
        {confirming ? (
          <div
            className="flex flex-col gap-1"
            role="group"
            aria-label={TASK_BROWSER_COPY.clearButton}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.preventDefault()
              e.stopPropagation()
              setConfirming(false)
            }}
          >
            <p className={HINT}>{TASK_BROWSER_COPY.clearConfirm}</p>
            <div className="flex items-center gap-1">
              <TextButton onClick={() => void clear()}>{TASK_BROWSER_COPY.clearConfirmButton}</TextButton>
              <TextButton autoFocus onClick={() => setConfirming(false)}>
                {TASK_BROWSER_COPY.clearCancel}
              </TextButton>
            </div>
          </div>
        ) : (
          <div ref={clearRow}>
            <TextButton onClick={() => setConfirming(true)}>{TASK_BROWSER_COPY.clearButton}</TextButton>
          </div>
        )}
        {message && (
          <p role="status" className={HINT}>
            {message}
          </p>
        )}
        <p className={HINT}>{status?.currentTab.copy ?? TASK_BROWSER_COPY.currentTab}</p>
      </div>
    </Section>
  )
}
