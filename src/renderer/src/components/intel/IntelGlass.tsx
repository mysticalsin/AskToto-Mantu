import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import { AlertTriangle, Brain } from 'lucide-react'
import { Spinner } from '../ui'
import { INTEL_SPRING, intelStagger, useIntelReducedMotion } from './IntelMotion'

export const INTEL_GLASS = 'intel-glass'
export const INTEL_GLASS_DANGER = 'intel-glass intel-glass--danger'
export const INTEL_GLASS_OK = 'intel-glass intel-glass--accent'

export function IntelCard({
  children,
  className = '',
  delay = 0,
  tone = 'default',
  static: isStatic = false
}: {
  children: ReactNode
  className?: string
  delay?: number
  tone?: 'default' | 'danger' | 'accent'
  static?: boolean
}): JSX.Element {
  const reduced = useIntelReducedMotion()
  const toneClass = tone === 'danger' ? 'intel-glass--danger' : tone === 'accent' ? 'intel-glass--accent' : ''
  const cls = `intel-glass ${toneClass} ${className}`.trim()
  if (isStatic || reduced) {
    return <div className={cls}>{children}</div>
  }
  return (
    <motion.div
      className={cls}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...INTEL_SPRING, delay }}
    >
      {children}
    </motion.div>
  )
}

export function IntelSectionTitle({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="mb-1.5 flex items-center text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-ink-3)]">
      {children}
    </div>
  )
}

export function IntelStatTile({
  value,
  label,
  delay = 0
}: {
  value: number | string
  label: string
  delay?: number
}): JSX.Element {
  const reduced = useIntelReducedMotion()
  const body = (
    <>
      <div className="font-ui text-[20px] font-semibold leading-none tracking-tight text-[color:var(--color-ink)]">
        {value}
      </div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-ink-3)]">{label}</div>
    </>
  )
  const cls =
    'intel-glass intel-glass--tile flex min-w-0 flex-1 flex-col items-center gap-0.5 px-2 py-2.5'
  if (reduced) return <div className={cls}>{body}</div>
  return (
    <motion.div
      className={cls}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -2 }}
      transition={{ ...INTEL_SPRING, delay }}
    >
      {body}
    </motion.div>
  )
}

export function IntelLoading({ label = 'Reading the brain…' }: { label?: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-2 py-2" role="status" aria-live="polite">
      <div className="flex items-center justify-center gap-2 py-4 text-[12px] text-[color:var(--color-ink-3)]">
        <Spinner size={14} /> {label}
      </div>
      <div className="flex gap-2">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="intel-shimmer h-12 flex-1 rounded-[var(--radius-lg)]" />
        ))}
      </div>
      <div className="intel-shimmer h-[84px] rounded-[var(--radius-lg)]" />
    </div>
  )
}

export function IntelEmpty({
  title,
  body,
  action,
  delay = 0
}: {
  title: string
  body: string
  action?: ReactNode
  delay?: number
}): JSX.Element {
  return (
    <IntelCard className="flex flex-col items-center gap-3 px-6 py-8 text-center" delay={delay}>
      <span className="intel-empty-mark grid h-12 w-12 place-items-center">
        <Brain size={26} className="text-[color:var(--color-accent-text)]" />
      </span>
      <div className="text-[13px] font-semibold text-[color:var(--color-ink)]">{title}</div>
      <div className="max-w-[380px] text-[12px] leading-snug text-[color:var(--color-ink-3)]">{body}</div>
      {action}
    </IntelCard>
  )
}

export function IntelError({
  title,
  body,
  action,
  compact = false
}: {
  title?: string
  body: string
  action?: ReactNode
  compact?: boolean
}): JSX.Element {
  return (
    <div
      className={`${INTEL_GLASS_DANGER} ${compact ? 'px-3 py-2' : 'px-3 py-2.5'}`}
      role="alert"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--color-danger)]" />
        <div className="min-w-0 flex-1">
          {title && (
            <div className="text-[11px] font-semibold text-[var(--color-danger)]">{title}</div>
          )}
          <div className={`text-[11px] leading-snug text-[var(--color-danger)] ${title ? 'mt-0.5 opacity-90' : ''}`}>
            {body}
          </div>
          {action && <div className="mt-2">{action}</div>}
        </div>
      </div>
    </div>
  )
}

export function IntelStagger({
  children,
  className = ''
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  const reduced = useIntelReducedMotion()
  if (reduced) return <div className={className}>{children}</div>
  return (
    <motion.div
      className={className}
      initial="hidden"
      animate="show"
      variants={{
        hidden: {},
        show: { transition: { staggerChildren: 0.045, delayChildren: 0.04 } }
      }}
    >
      {children}
    </motion.div>
  )
}

export function IntelStaggerItem({
  children,
  className = '',
  index = 0
}: {
  children: ReactNode
  className?: string
  index?: number
}): JSX.Element {
  const reduced = useIntelReducedMotion()
  if (reduced) return <div className={className}>{children}</div>
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...INTEL_SPRING, delay: intelStagger(index) }}
    >
      {children}
    </motion.div>
  )
}
