import { NavLink } from 'react-router-dom'

// TODO(tony): drop in the real profile URL — never fabricated, waiting on Tony to supply it.
const LINKEDIN_URL = 'https://www.linkedin.com/in/'

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
          {/* Real Mantu "M" mark (same asset as the app icon), not the favicon's stylized bolt shape.
              BASE_URL keeps it working in the packaged file:// build. */}
          <img
            src={`${import.meta.env.BASE_URL}mantu-mark.png`}
            alt="Mantu"
            className="h-8 w-8 shrink-0 rounded-lg object-contain"
          />
          <div>
            <div className="text-sm font-semibold text-white/90">Mantu Intelligence</div>
            <div className="text-[11px] text-white/40">
              Your meetings, compounded - built by{' '}
              <a
                href={LINKEDIN_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-white/60 hover:text-white/90 hover:underline"
              >
                Tony Walteur
              </a>
            </div>
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
