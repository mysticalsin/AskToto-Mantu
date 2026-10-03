import {
  ADVANCED_LABEL,
  ADVANCED_ROWS,
  searchSettings,
  searchTerms,
  settingsDestinations,
  type SettingsRow,
  type SettingsScene
} from './data'

function Control({ row }: { row: SettingsRow }): JSX.Element {
  const { control } = row
  if (control.kind === 'switch') {
    return (
      <button
        className="dc-switch"
        type="button"
        role="switch"
        aria-checked={control.on}
        aria-label={row.label}
      >
        <span className="dc-switch-knob" aria-hidden="true" />
      </button>
    )
  }
  return (
    <div className="dc-row-control">
      <span className="dc-row-value">{control.value}</span>
      {control.action ? (
        <button className="dc-button" type="button">
          {control.action}
        </button>
      ) : null}
    </div>
  )
}

function Rows({ rows }: { rows: readonly SettingsRow[] }): JSX.Element {
  return (
    <ul className="dc-rows">
      {rows.map((r) => (
        <li key={r.id} className="dc-row" data-row={r.id}>
          <div className="dc-row-text">
            <span className="dc-row-label">{r.label}</span>
            <span className="dc-row-description">{r.description}</span>
          </div>
          <Control row={r} />
        </li>
      ))}
    </ul>
  )
}

function UpgradeBanners(): JSX.Element {
  return (
    <div className="dc-banners">
      <section className="dc-banner" role="status" aria-label="Settings now live in four places">
        <strong>Settings now live in four places</strong>
        <span>
          Find each setting under General, Voice &amp; meetings, Knowledge &amp; skills, or Privacy &amp; account.
        </span>
      </section>
      <section className="dc-banner" role="status" aria-label="Choose how speech is processed">
        <strong>Choose how speech is processed</strong>
        <span>Nothing changes until you choose.</span>
        <button className="dc-button" type="button">
          Choose
        </button>
      </section>
    </div>
  )
}

function SearchResults({ query, scene }: { query: string; scene: SettingsScene }): JSX.Element {
  const groups = searchSettings(query, scene.speech)
  const count = groups.reduce((n, g) => n + g.rows.length, 0)
  const related = searchTerms(query).slice(1)
  const summary =
    `${count} ${count === 1 ? 'setting matches' : 'settings match'} “${query}”` +
    (related.length > 0 ? `, including related words: ${related.join(', ')}.` : '.')
  return (
    <>
      <h2 className="dc-settings-heading">Search results</h2>
      <p className="dc-settings-summary">{summary}</p>
      {groups.map((g) => (
        <section key={g.label} className="dc-settings-section" aria-label={g.label}>
          <h3>{g.label}</h3>
          <Rows rows={g.rows} />
        </section>
      ))}
    </>
  )
}

function AdvancedDrawer(): JSX.Element {
  return (
    <aside className="dc-drawer" aria-label={ADVANCED_LABEL}>
      <div className="dc-drawer-header">
        <h2 className="dc-settings-heading">{ADVANCED_LABEL}</h2>
        <button className="dc-button" type="button">
          Close
        </button>
      </div>
      <p className="dc-settings-summary">For troubleshooting. Most people never need these.</p>
      <Rows rows={ADVANCED_ROWS} />
    </aside>
  )
}

/** The Settings 2.0 shell: sidebar (search, four destinations with readiness, Advanced) and the content pane. */
export function SettingsSurface({ scene }: { scene: SettingsScene }): JSX.Element {
  const destinations = settingsDestinations(scene.speech)
  const current = destinations.find((d) => d.id === scene.destination) ?? destinations[0]
  const query = scene.search?.trim() ?? ''
  return (
    <div className="dc-settings">
      <div className="dc-settings-sidebar">
        <h1 className="dc-settings-title">Settings</h1>
        <input
          className="dc-search"
          type="search"
          aria-label="Search settings"
          placeholder="Search settings"
          defaultValue={scene.search ?? ''}
        />
        <nav className="dc-nav" aria-label="Settings destinations">
          {destinations.map((d) => (
            <button
              key={d.id}
              className="dc-nav-item"
              type="button"
              aria-current={!query && d.id === current.id ? 'page' : undefined}
            >
              <span className="dc-nav-label">{d.label}</span>
              <span className="dc-nav-readiness">{d.readiness}</span>
            </button>
          ))}
          <button className="dc-nav-item dc-nav-advanced" type="button" aria-expanded={Boolean(scene.advancedOpen)}>
            <span className="dc-nav-label">{ADVANCED_LABEL}</span>
          </button>
        </nav>
      </div>
      <main className="dc-settings-content">
        {query ? (
          <SearchResults query={query} scene={scene} />
        ) : (
          <>
            {scene.migrated ? <UpgradeBanners /> : null}
            <h2 className="dc-settings-heading">{current.label}</h2>
            <p className="dc-settings-summary">{current.summary}</p>
            {current.sections.map((s) => (
              <section key={s.title} className="dc-settings-section" aria-label={s.title}>
                <h3>{s.title}</h3>
                <Rows rows={s.rows} />
              </section>
            ))}
          </>
        )}
      </main>
      {scene.advancedOpen ? <AdvancedDrawer /> : null}
    </div>
  )
}
