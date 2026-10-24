/**
 * DataDisclosureSection.tsx — Settings › Privacy › Your data (G83). Renders DATA_DISCLOSURES as one inset grouped
 * list: each row is a native <details> disclosure (keyboard reachable without extra code) whose summary carries the
 * title and a text badge for whether the data leaves this Mac. Copy only: no IPC, no paths.
 */
import { Database } from 'lucide-react'
import {
  DATA_DISCLOSURES,
  DISCLOSURE_KINDS,
  DISCLOSURE_KIND_LABEL,
  LEAVES_DEVICE_LABEL,
  type DataDisclosure
} from '@shared/data-disclosure'
import { Section } from '../../ui/Section'

function DisclosureRow({ row }: { row: DataDisclosure }): JSX.Element {
  const facts: ReadonlyArray<readonly [string, string]> = [
    ['Reads', row.reads],
    ['Stored', row.storedAt],
    ['Leaves this Mac', row.leavesDeviceDetail || LEAVES_DEVICE_LABEL.never],
    ['Kept', row.retention],
    ['Delete', row.howToDelete]
  ]
  return (
    <details className="group border-t border-[color:var(--cl-border)] first:border-t-0">
      <summary className="flex min-h-[36px] cursor-pointer list-none items-center gap-2 px-3 py-2 text-[12px] text-[color:var(--cl-foreground)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--cl-primary)]">
        <span className="min-w-0 flex-1 truncate font-medium">{row.title}</span>
        <span
          data-leaves={row.leavesDevice}
          className="shrink-0 rounded-full bg-[var(--cl-primary-soft)] px-2 py-0.5 text-[11px] text-[color:var(--cl-muted-foreground)]"
        >
          {LEAVES_DEVICE_LABEL[row.leavesDevice]}
        </span>
      </summary>
      <dl className="m-0 grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-3 pb-3 text-[11px] leading-snug">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-[color:var(--cl-muted-foreground)]">{label}</dt>
            <dd className="m-0 min-w-0 break-words text-[color:var(--cl-foreground)]">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

export function DataDisclosureSection(): JSX.Element {
  return (
    <Section title="Your data" desc="What Métis keeps, where it lives, and how to remove it." icon={Database}>
      <div className="flex flex-col gap-3">
        {DISCLOSURE_KINDS.map((kind) => {
          const rows = DATA_DISCLOSURES.filter((row) => row.kind === kind)
          if (rows.length === 0) return null
          return (
            <div key={kind} className="flex flex-col gap-1">
              <p className="m-0 px-1 text-[11px] font-medium text-[color:var(--cl-muted-foreground)]">
                {DISCLOSURE_KIND_LABEL[kind]}
              </p>
              <div className="overflow-hidden rounded-lg border border-[color:var(--cl-border)]">
                {rows.map((row) => (
                  <DisclosureRow key={row.id} row={row} />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </Section>
  )
}
