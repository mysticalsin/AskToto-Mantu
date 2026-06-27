import type { ReactNode } from 'react'

export function Panel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="glass-strong scroll-thin panel-enter max-h-[670px] overflow-y-auto rounded-2xl px-4 py-3.5">
      {children}
    </div>
  )
}
