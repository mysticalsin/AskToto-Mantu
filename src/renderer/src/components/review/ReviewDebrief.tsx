import { useState } from 'react'
import { Check, EarOff, Save } from 'lucide-react'
import { DEBRIEF_MAX_CHARS } from '@shared/ipc'
import { TextButton } from '../ui'
import { InlineOrb } from '../AgentStatus'

/**
 * 90-SECOND DEBRIEF — the unsaid, captured while it's still warm. Live reviews only (a past meeting's moment has
 * passed). Stored inside the saved meeting file: same encryption, same retention, same deletion; the brain folds it
 * into signals on re-ingest. The box enforces main's limit, and main's reason is shown when a save is refused.
 */
export function ReviewDebrief({ savedPath }: { savedPath: string }): JSX.Element {
  const [debrief, setDebrief] = useState('')
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    if (!debrief.trim() || state === 'saving') return
    setState('saving')
    setError(null)
    try {
      const file = savedPath.split('/').pop() ?? savedPath
      const r = await window.toto.debriefSave(file, debrief)
      if (!r.ok) setError(r.error || null)
      setState(r.ok ? 'saved' : 'error')
    } catch {
      setState('error')
    }
  }
  return (
    <div className="rounded-xl border border-[var(--color-hair-soft)] bg-white/[0.02] px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
        <EarOff size={12} /> 90-second debrief, off the record
      </div>
      {state === 'saved' ? (
        <div className="flex items-center gap-2 text-[12px] text-[color:var(--color-ink-2)]">
          <Check size={13} className="text-[var(--color-success)]" />
          Saved with the meeting. It feeds your intelligence brain, never a follow-up email.
        </div>
      ) : (
        <>
          <textarea
            value={debrief}
            onChange={(e) => setDebrief(e.target.value)}
            rows={2}
            maxLength={DEBRIEF_MAX_CHARS}
            placeholder="What wasn't said out loud? Hallway remarks, hesitation, your gut read…"
            className="no-drag focus-ring w-full resize-none rounded-lg border border-[var(--color-hair-soft)] bg-white/[0.03] px-2.5 py-1.5 text-[12px] text-[color:var(--color-ink)] placeholder:text-[color:var(--color-ink-3)]"
          />
          <div className="mt-1.5 flex items-center justify-between">
            <span className="text-[10px] text-[color:var(--color-ink-3)]">
              {state === 'error'
                ? error || 'Could not save. Try again.'
                : 'Impressions, not transcript. 90 seconds, then move on.'}
            </span>
            <TextButton onClick={() => void save()} disabled={!debrief.trim() || state === 'saving'}>
              {state === 'saving' ? <InlineOrb kind="writing" /> : <Save size={11} />}
              Save debrief
            </TextButton>
          </div>
        </>
      )}
    </div>
  )
}
