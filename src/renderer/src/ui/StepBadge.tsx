import { CircleCheck } from 'lucide-react'

export function StepBadge({ n, done }: { n: number; done?: boolean }): JSX.Element {
  return (
    <span
      className={[
        'flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
        done
          ? 'bg-[var(--cl-success)]/20 text-[color:var(--cl-success)]'
          : 'bg-[var(--cl-primary-soft)] text-[color:var(--cl-primary)]'
      ].join(' ')}
    >
      {done ? <CircleCheck size={14} /> : n}
    </span>
  )
}
