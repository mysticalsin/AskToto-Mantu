import { useId } from 'react'
import { Sparkles } from 'lucide-react'
import type { Profile } from '@shared/ipc'
import { LazyInput, LazyTextarea } from '../../ui/LazyText'
import { ctl } from '../../ui/ctl'

export function ProfileEditor({
  profile,
  onChange,
  disabled = false
}: {
  profile: Profile
  onChange: (p: Profile) => void
  disabled?: boolean
}): JSX.Element {
  const set = (k: keyof Profile, v: string): void => {
    if (disabled) return
    onChange({ ...profile, [k]: v })
  }
  const inputCls = [ctl, disabled ? 'opacity-60' : ''].join(' ')
  const nameId = useId()
  const roleId = useId()
  const companyId = useId()
  const jdId = useId()
  const resumeId = useId()
  const notesId = useId()
  return (
    <div className={['flex flex-col gap-2', disabled ? 'opacity-80' : ''].join(' ')}>
      <div className="grid grid-cols-3 gap-2">
        <div className="flex flex-col gap-0.5">
          <label htmlFor={nameId} className="sr-only">Name</label>
          <LazyInput id={nameId} disabled={disabled} className={inputCls} placeholder="Name" value={profile.name} onCommit={(v) => set('name', v)} />
        </div>
        <div className="flex flex-col gap-0.5">
          <label htmlFor={roleId} className="sr-only">Role</label>
          <LazyInput id={roleId} disabled={disabled} className={inputCls} placeholder="Role" value={profile.role} onCommit={(v) => set('role', v)} />
        </div>
        <div className="flex flex-col gap-0.5">
          <label htmlFor={companyId} className="sr-only">Company</label>
          <LazyInput id={companyId} disabled={disabled} className={inputCls} placeholder="Company" value={profile.company} onCommit={(v) => set('company', v)} />
        </div>
      </div>
      <label htmlFor={jdId} className="sr-only">Job description</label>
      <LazyTextarea
        id={jdId}
        disabled={disabled}
        className={inputCls + ' h-16 w-full resize-none'}
        placeholder="Job description (paste the posting)…"
        value={profile.jobDescription}
        onCommit={(v) => set('jobDescription', v)}
      />
      <label htmlFor={resumeId} className="sr-only">Background / résumé</label>
      <LazyTextarea
        id={resumeId}
        disabled={disabled}
        className={inputCls + ' h-20 w-full resize-none'}
        placeholder="Your background / résumé…"
        value={profile.resume}
        onCommit={(v) => set('resume', v)}
      />
      <label htmlFor={notesId} className="sr-only">Notes</label>
      <LazyTextarea
        id={notesId}
        disabled={disabled}
        className={inputCls + ' h-12 w-full resize-none'}
        placeholder="Anything else Métis should know…"
        value={profile.notes}
        onCommit={(v) => set('notes', v)}
      />
      <div className="flex items-center gap-1.5 px-1 text-[11px] text-[color:var(--cl-muted-foreground)]">
        <Sparkles size={11} className="text-[color:var(--cl-primary)]" />
        Paste your résumé and the job post for better interview answers.
      </div>
    </div>
  )
}
