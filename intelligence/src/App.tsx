import { Suspense, lazy } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { NavBar } from './components/NavBar'
import { ErrorBoundary } from './components/ErrorBoundary'
import { PlaceholderBanner } from './components/PlaceholderBanner'
import { useDashboardData } from './lib/useDashboardData'
import { BriefingView } from './views/BriefingView'
import { CoachingView } from './views/CoachingView'
import { DealView } from './views/DealView'
import { AccountsView } from './views/AccountsView'
import { PeopleView } from './views/PeopleView'
import { StatsView } from './views/StatsView'
import { MeetingsView } from './views/MeetingsView'
import { EmbedView } from './views/EmbedView'

// Lazy: GraphView drags in vis-network + vis-data — most of the whole bundle — which every other
// route otherwise pays for at cold start. Renderer code is not bytecode-compiled (that constraint
// is src/main only), so dynamic import is safe here, and Vite splits it into its own chunk.
const GraphView = lazy(() => import('./views/GraphView').then((m) => ({ default: m.GraphView })))

function LoadingOrError({ loading, error }: { loading: boolean; error: string | null }) {
  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-white/40">
        Loading dashboard data…
      </div>
    )
  }
  if (error) {
    return (
      <div className="mx-auto max-w-xl px-6 py-16 text-center">
        {/* The messages thrown upstream already name their own source (a data.json status, a dead
            brain bridge). Prefixing every one with "Failed to load data.json" told a user inside
            Métis — where data.json is never read — to go fix a file that is not involved. */}
        <p className="text-sm text-rose-300">{error}</p>
      </div>
    )
  }
  return null
}

function DashboardRoutes() {
  const { data, loading, error, stale, status, refreshStatus } = useDashboardData()
  // Key the boundary on the route so switching tabs remounts it fresh and clears a prior view's error;
  // NavBar sits outside it, so navigation always recovers a crashed view.
  const { pathname } = useLocation()

  return (
    <div className="min-h-screen">
      <NavBar status={status} refreshStatus={refreshStatus} />
      {data?.meta.is_placeholder && <PlaceholderBanner note={data.meta.note} />}
      {/* File-mode data (no live brain bridge) always shows its age — a data.json baked months ago
          must never read as current. Live-brain mode regenerates on read, so no banner needed. */}
      {data && !data.meta.is_placeholder && !window.intelligence && (
        <div className="border-b border-white/10 bg-white/[0.03] px-4 py-1.5 text-[11px] text-white/50" role="status">
          Static data file, as of {new Date(data.meta.generated).toLocaleString()}. Open inside Métis for live numbers.
        </div>
      )}
      {/* The numbers below are the last good read, and the newest one failed. Say so rather than
          letting a dead bridge present frozen figures as current. */}
      {data && stale && (
        <div
          className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-[11px] text-amber-200"
          role="status"
        >
          Showing the last successful read. The latest refresh failed: {stale}
        </div>
      )}
      {!data ? (
        <LoadingOrError loading={loading} error={error} />
      ) : (
        <ErrorBoundary key={pathname}>
          <Routes>
            <Route path="/" element={<BriefingView data={data} />} />
            <Route path="/coaching" element={<CoachingView data={data} />} />
            <Route path="/deals" element={<DealView data={data} />} />
            <Route path="/accounts" element={<AccountsView data={data} />} />
            <Route path="/people" element={<PeopleView data={data} />} />
            <Route path="/stats" element={<StatsView data={data} />} />
            <Route
              path="/graph"
              element={
                <Suspense
                  fallback={
                    <div className="flex h-64 items-center justify-center text-sm text-white/40">
                      Loading the relationship graph…
                    </div>
                  }
                >
                  <GraphView data={data} />
                </Suspense>
              }
            />
            <Route path="/meetings" element={<MeetingsView data={data} />} />
          </Routes>
        </ErrorBoundary>
      )}
    </div>
  )
}

function EmbedRoute() {
  const { data, loading, error, stale } = useDashboardData()
  if (!data) {
    return (
      <div className="min-h-screen bg-[var(--color-mantu-bg)]">
        <LoadingOrError loading={loading} error={error} />
      </div>
    )
  }
  return (
    <div className="min-h-screen bg-[var(--color-mantu-bg)]">
      {/* Same rule as the full dashboard (MQA-221): the embed shows the same numbers, so it owes the
          same disclosure when they stop updating. Compact, because that is this surface's whole point. */}
      {stale && (
        <div
          className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[10px] text-amber-200"
          role="status"
        >
          Last successful read. The latest refresh failed.
        </div>
      )}
      <EmbedView data={data} />
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/embed" element={<EmbedRoute />} />
      <Route path="/*" element={<DashboardRoutes />} />
    </Routes>
  )
}
