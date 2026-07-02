import { NavLink } from 'react-router-dom'

const links = [
  { to: '/', label: 'Coaching', end: true },
  { to: '/deals', label: 'Deals' },
  { to: '/stats', label: 'Stats' },
  { to: '/graph', label: 'Relationships' },
]

export function NavBar() {
  return (
    <header className="sticky top-0 z-20 border-b border-[var(--color-mantu-border)] bg-[var(--color-mantu-bg)]/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-mantu text-sm font-bold text-white">
            M
          </div>
          <div>
            <div className="text-sm font-semibold text-white/90">Mantu Intelligence</div>
            <div className="text-[11px] text-white/40">Your meetings, compounded — built by Tony Walteur</div>
          </div>
        </div>
        <nav className="flex items-center gap-1 rounded-lg bg-white/5 p-1">
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
        <a
          href="/embed"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium text-mantu-light hover:underline"
        >
          Compact embed view →
        </a>
      </div>
    </header>
  )
}
