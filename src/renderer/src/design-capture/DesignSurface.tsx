import {
  DESIGN_STATES,
  SAMPLE_ANSWER,
  SAMPLE_QUESTION,
  SAMPLE_REVIEW,
  type DesignState
} from './states'

function Bar({ phase }: { phase: 'idle' | 'listening' }): JSX.Element {
  return (
    <div className="dc-card dc-bar" data-phase={phase}>
      <span className="dc-dot" aria-hidden="true" />
      <span className="dc-bar-label">{phase === 'listening' ? 'Listening' : 'Ready'}</span>
      <span className="dc-bar-hint">{phase === 'listening' ? '00:42' : 'Press to start'}</span>
    </div>
  )
}

function Answer({ streaming }: { streaming: boolean }): JSX.Element {
  return (
    <div className="dc-card dc-answer" data-streaming={streaming}>
      <div className="dc-question">{SAMPLE_QUESTION}</div>
      {SAMPLE_ANSWER.slice(0, streaming ? 1 : SAMPLE_ANSWER.length).map((line) => (
        <p key={line}>{line}</p>
      ))}
      {streaming ? <span className="dc-caret" aria-hidden="true" /> : null}
    </div>
  )
}

function Review(): JSX.Element {
  return (
    <div className="dc-card dc-review">
      <h2>{SAMPLE_REVIEW.title}</h2>
      <h3>Decisions</h3>
      <ul>
        {SAMPLE_REVIEW.decisions.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>
      <h3>Actions</h3>
      <ul>
        {SAMPLE_REVIEW.actions.map((a) => (
          <li key={a}>{a}</li>
        ))}
      </ul>
    </div>
  )
}

function ErrorBanner(): JSX.Element {
  return (
    <div className="dc-card dc-error" role="alert">
      <strong>Something went wrong</strong>
      <span>The sample request could not finish. Your notes are safe.</span>
      <button type="button">Try again</button>
    </div>
  )
}

export function DesignSurface({ state }: { state: DesignState }): JSX.Element {
  switch (state.kind) {
    case 'bar':
      return <Bar phase={state.phase} />
    case 'answer':
      return <Answer streaming={state.streaming} />
    case 'review':
      return <Review />
    case 'error':
      return <ErrorBanner />
  }
}

/** Shown without a `?state=` query (or with an unknown one): links to every state. */
export function DesignIndex({ unknown }: { unknown?: string }): JSX.Element {
  return (
    <div className="dc-card dc-index">
      <h2>Design states</h2>
      {unknown ? <p role="alert">Unknown state: {unknown}</p> : null}
      <ul>
        {DESIGN_STATES.map((s) => (
          <li key={s.id}>
            <a href={`?state=${s.id}`}>{s.title}</a>
          </li>
        ))}
      </ul>
    </div>
  )
}
