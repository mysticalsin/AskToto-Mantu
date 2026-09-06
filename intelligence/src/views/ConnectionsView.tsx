import { Link } from 'react-router-dom'
import type { DashboardData } from '../types/data'
import { EmptyState } from '../components/EmptyState'
import { slug } from '../lib/slug'

interface Props {
  data: DashboardData
}

export function ConnectionsView({ data }: Props) {
  const rows = uniquePairs(data.meeting_connections ?? [])
  const meetingSlugs = new Set(data.meetings_feed.map((m) => m.slug))

  if (rows.length === 0) {
    return (
      <EmptyState
        title="Connections"
        standfirst="Named links between meetings that share a person, account, deal, or topic."
        headline="No cross-meeting connections yet."
        body="Connections appear when two saved meetings share a person, account, deal, or topic. Save those meetings, then use Update Intelligence. If this brain looks empty, reconnect OneDrive in Settings → Brain."
      />
    )
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <h1 className="text-2xl font-semibold text-white/95">Connections</h1>
      <p className="mt-1 text-sm text-white/50">
        Named links between meetings. Each row has two destinations.
      </p>
      <ul className="mt-6 flex list-none flex-col gap-2 p-0">
        {rows.map((row) => (
          <li
            key={row.id}
            className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
          >
            <p className="text-sm text-white/80">{row.sentence}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <MeetingDest file={row.a.file} title={row.a.title} known={meetingSlugs} />
              <span className="text-white/40">and</span>
              <MeetingDest file={row.b.file} title={row.b.title} known={meetingSlugs} />
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white/50">
                {row.kind} · {row.via}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function MeetingDest({
  file,
  title,
  known
}: {
  file: string
  title: string
  known: Set<string>
}): JSX.Element {
  const s = slug(file)
  if (known.has(s)) {
    return (
      <Link to={`/meetings?m=${encodeURIComponent(s)}`} className="text-mantu-light hover:underline">
        {title}
      </Link>
    )
  }
  return <span className="text-white/70">{title}</span>
}

function uniquePairs<T extends { id: string; kind: string; via: string; a: { file: string }; b: { file: string } }>(
  edges: T[]
): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const e of edges) {
    const files = [e.a.file, e.b.file].sort()
    const key = `${e.kind}|${e.via.toLowerCase()}|${files[0]}|${files[1]}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(e)
  }
  return out
}
