import { useState } from 'react'
import { NavLink } from 'react-router-dom'

const UPDATE_LABEL = 'Update Intelligence'
const UPDATING_LABEL = 'Updating'

function UpdateIntelligenceControl() {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!window.intelligence?.runPass) return null

  return (
    <div className="win-no-drag flex max-w-[220px] flex-col items-end gap-1">
      <button
        type="button"
        data-intelligence-update=""
        disabled={running}
        title="Update Intelligence from your meetings"
        onClick={() => {
          void (async () => {
            setRunning(true)
            setError(null)
            try {
              const result = await window.intelligence!.runPass!()
              if (result.error) setError(result.error)
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e))
            } finally {
              setRunning(false)
            }
          })()
        }}
        className="rounded-full bg-mantu px-3 py-1.5 text-xs font-semibold text-white shadow hover:brightness-110 disabled:opacity-60"
      >
        {running ? UPDATING_LABEL : UPDATE_LABEL}
      </button>
      {error && (
        <p className="text-right text-[11px] leading-snug text-rose-300" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

const links = [
  { to: '/', label: 'Today', end: true },
  { to: '/coaching', label: 'Coaching' },
  { to: '/deals', label: 'Deals' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/people', label: 'People' },
  { to: '/stats', label: 'Stats' },
  { to: '/graph', label: 'Relationships' },
  { to: '/meetings', label: 'Meetings' },
]

export function NavBar() {
  return (
    // win-drag: lets you grab the header anywhere to move this normal-framed window, not just the thin
    // OS title bar above it (CSS-only — no JS drag here, since the vis-network graph view and selectable
    // text below would fight a JS pointer-based drag). Every interactive child opts back out via
    // win-no-drag so its clicks still land.
    <header className="win-drag sticky top-0 z-20 border-b border-[var(--color-mantu-border)] bg-[var(--color-mantu-bg)]/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-3">
          {/* Real Mantu "M" mark (same asset as the app icon), not the favicon's stylized bolt shape.
              BASE_URL keeps it working in the packaged file:// build. */}
          <img
            src={`${import.meta.env.BASE_URL}mantu-mark.png`}
            alt="Mantu"
            className="h-8 w-8 shrink-0 rounded-lg object-contain"
          />
          <div>
            <div className="text-sm font-semibold text-white/90">Mantu Intelligence</div>
            <div className="text-[11px] text-white/40">Your meetings, compounded</div>
          </div>
        </div>
        <nav className="win-no-drag flex items-center gap-1 rounded-lg bg-white/5 p-1">
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              className={({ isActive }) =>
                `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-mantu text-white shadow'
                    : 'text-white/60 hover:bg-white/10 hover:text-white/90'
                }`
              }
            >
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <UpdateIntelligenceControl />
          {/* HashRouter + file:// packaging: a root-relative href navigates the top frame to the
              filesystem root instead of the app's own route. Hash nav stays in-window and in-app. */}
          <a
            href="#/embed"
            className="win-no-drag text-xs font-medium text-mantu-light hover:underline"
          >
            Compact embed view →
          </a>
        </div>
      </div>
    </header>
  )
}
