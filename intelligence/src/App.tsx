import { Route, Routes } from 'react-router-dom'
import { NavBar } from './components/NavBar'
import { PlaceholderBanner } from './components/PlaceholderBanner'
import { useDashboardData } from './lib/useDashboardData'
import { CoachingView } from './views/CoachingView'
import { DealView } from './views/DealView'
import { StatsView } from './views/StatsView'
import { GraphView } from './views/GraphView'
import { EmbedView } from './views/EmbedView'

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
        <p className="text-sm text-rose-300">Failed to load data.json: {error}</p>
      </div>
    )
  }
  return null
}

function DashboardRoutes() {
  const { data, loading, error } = useDashboardData()

  return (
    <div className="min-h-screen">
      <NavBar />
      {data?.meta.is_placeholder && <PlaceholderBanner note={data.meta.note} />}
      {!data ? (
        <LoadingOrError loading={loading} error={error} />
      ) : (
        <Routes>
          <Route path="/" element={<CoachingView data={data} />} />
          <Route path="/deals" element={<DealView data={data} />} />
          <Route path="/stats" element={<StatsView data={data} />} />
          <Route path="/graph" element={<GraphView data={data} />} />
        </Routes>
      )}
    </div>
  )
}

function EmbedRoute() {
  const { data, loading, error } = useDashboardData()
  if (!data) {
    return (
      <div className="min-h-screen bg-[var(--color-mantu-bg)]">
        <LoadingOrError loading={loading} error={error} />
      </div>
    )
  }
  return <EmbedView data={data} />
}

export default function App() {
  return (
    <Routes>
      <Route path="/embed" element={<EmbedRoute />} />
      <Route path="/*" element={<DashboardRoutes />} />
    </Routes>
  )
}
