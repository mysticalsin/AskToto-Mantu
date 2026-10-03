import {
  ADVANCED_LABEL,
  POLICY_OWNER,
  advancedRows,
  effectivePolicy,
  hiddenSearchMatches,
  sceneNotices,
  searchSettings,
  searchTerms,
  settingsDestinations,
  type PolicyId,
  type SettingsNotice,
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
      {control.kind === 'progress' ? (
        <div
          className="dc-progress"
          role="progressbar"
          aria-label={`${row.label} download`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={control.percent}
        >
          <span className="dc-progress-fill" style={{ width: `${control.percent}%` }} />
        </div>
      ) : null}
      <span className="dc-row-value" data-reverted={row.saveError ? 'true' : undefined}>
        {control.value}
      </span>
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
            {r.lock ? (
              <span className="dc-row-lock" data-lock={r.lock.pending ? 'pending' : 'locked'}>
                <strong>
                  {r.lock.pending
                    ? `From your next meeting: ${r.lock.value}, locked by ${r.lock.owner}.`
                    : `Locked by ${r.lock.owner}.`}
                </strong>
                {` ${r.lock.reason}`}
              </span>
            ) : null}
          </div>
          <Control row={r} />
          {r.saveError ? (
            <p className="dc-row-error" role="alert">
              {r.saveError}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

function Notice({ notice }: { notice: SettingsNotice }): JSX.Element {
  return (
    <section
      className="dc-banner"
      role={notice.tone === 'warning' ? 'alert' : 'status'}
      aria-label={notice.title}
      data-tone={notice.tone === 'warning' ? 'warning' : undefined}
    >
      <strong>{notice.title}</strong>
      <span>{notice.body}</span>
      {notice.action ? (
        <button className="dc-button" type="button">
          {notice.action}
        </button>
      ) : null}
    </section>
  )
}

const UPGRADE_NOTICES: readonly SettingsNotice[] = [
  {
    title: 'Settings now live in four places',
    body: 'Find each setting under General, Voice & meetings, Knowledge & skills, or Privacy & account.',
    tone: 'info'
  },
  { title: 'Choose how speech is processed', body: 'Nothing changes until you choose.', tone: 'info', action: 'Choose' }
]

function Notices({ notices }: { notices: readonly SettingsNotice[] }): JSX.Element | null {
  if (notices.length === 0) return null
  return (
    <div className="dc-banners">
      {notices.map((n) => (
        <Notice key={n.title} notice={n} />
      ))}
    </div>
  )
}

function SearchResults({ query, scene }: { query: string; scene: SettingsScene }): JSX.Element {
  const groups = searchSettings(query, scene.speech, scene)
  const hidden = hiddenSearchMatches(query, scene.speech, scene)
  const count = groups.reduce((n, g) => n + g.rows.length, 0)
  const related = searchTerms(query).slice(1)
  const matched =
    count === 0
      ? `No settings match “${query}”.`
      : `${count} ${count === 1 ? 'setting matches' : 'settings match'} “${query}”` +
        (related.length > 0 ? `, including related words: ${related.join(', ')}.` : '.')
  const hiddenNote =
    hidden.length === 0
      ? ''
      : ` ${POLICY_OWNER} hides ${hidden.length} matching ${hidden.length === 1 ? 'control' : 'controls'} on this computer.`
  return (
    <>
      <h2 className="dc-settings-heading">Search results</h2>
      <p className="dc-settings-summary">{matched + hiddenNote}</p>
      {hidden.length > 0 ? (
        <section className="dc-empty" role="status" aria-label="Hidden by your organisation">
          <strong>Hidden by your organisation</strong>
          <span>These controls are not shown on this computer. Ask your IT team if you need them.</span>
          <button className="dc-button" type="button">
            View effective policy
          </button>
        </section>
      ) : null}
      {groups.map((g) => (
        <section key={g.label} className="dc-settings-section" aria-label={g.label}>
          <h3>{g.label}</h3>
          <Rows rows={g.rows} />
        </section>
      ))}
    </>
  )
}

function AdvancedDrawer({ scene }: { scene: SettingsScene }): JSX.Element {
  return (
    <aside className="dc-drawer" aria-label={ADVANCED_LABEL}>
      <div className="dc-drawer-header">
        <h2 className="dc-settings-heading">{ADVANCED_LABEL}</h2>
        <button className="dc-button" type="button">
          Close
        </button>
      </div>
      <p className="dc-settings-summary">For troubleshooting. Most people never need these.</p>
      <Rows rows={advancedRows(scene)} />
    </aside>
  )
}

function PolicySheet({ policy, scene }: { policy: PolicyId; scene: SettingsScene }): JSX.Element {
  return (
    <aside className="dc-drawer dc-sheet" role="dialog" aria-label="Effective policy">
      <div className="dc-drawer-header">
        <h2 className="dc-settings-heading">Effective policy</h2>
        <button className="dc-button" type="button">
          Close
        </button>
      </div>
      <p className="dc-settings-summary">What applies on this computer, who set it and why.</p>
      <table className="dc-policy-table">
        <thead>
          <tr>
            <th scope="col">Setting</th>
            <th scope="col">Value</th>
            <th scope="col">Source</th>
            <th scope="col">Why</th>
          </tr>
        </thead>
        <tbody>
          {effectivePolicy(policy, scene.speech).map((r) => (
            <tr key={r.setting} data-policy-row={r.setting}>
              <th scope="row">{r.setting}</th>
              <td>{r.value}</td>
              <td>{r.source}</td>
              <td>{r.why}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </aside>
  )
}

/** The Settings 2.0 shell: sidebar (search, four destinations with readiness, Advanced) and the content pane. */
export function SettingsSurface({ scene }: { scene: SettingsScene }): JSX.Element {
  const destinations = settingsDestinations(scene.speech, scene)
  const current = destinations.find((d) => d.id === scene.destination) ?? destinations[0]
  const query = scene.search?.trim() ?? ''
  return (
    <div className="dc-settings">
      <div className="dc-settings-sidebar">
        <h1 className="dc-settings-title">Settings</h1>
        {scene.recording ? (
          <p className="dc-recording" role="status">
            <span className="dc-recording-dot" aria-hidden="true" />
            Recording a meeting, 00:42
          </p>
        ) : null}
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
            <Notices notices={[...(scene.migrated ? UPGRADE_NOTICES : []), ...sceneNotices(scene)]} />
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
      {scene.advancedOpen ? <AdvancedDrawer scene={scene} /> : null}
      {scene.policySheet && scene.policy ? <PolicySheet policy={scene.policy} scene={scene} /> : null}
    </div>
  )
}
