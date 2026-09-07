/**
 * Live polling (plan D3/D4). Polls GET /v1/admin/live.json every 5s while the tab is visible,
 * 30s while hidden, sending If-None-Match from the last ETag and treating 304 as "nothing
 * changed". Network or non-2xx/304 errors back off through 5/10/20/40/60s and flip the rail
 * indicator to "Reconnecting"; a hidden tab always shows "Paused" regardless of connection
 * health. Every successful 200 updates the rail live indicator, the rail badges the payload
 * already carries (notifications only, see operator/src/spa/live-client.ts), any `[data-world-
 * live]` LIVE pill already on the page, and dispatches `metis:live` so a future page module can
 * re-render from the same payload (plan D2/P1). All state transitions are pure functions in
 * operator/src/spa/live-client.ts, unit-tested there (operator/vitest.config.ts does not cover
 * operator/client/**).
 */
import { relativeTime } from '../src/render'
import {
  badgeCountsFromSnapshot,
  displayLiveState,
  initialPollState,
  liveStatusText,
  nextPollState,
  pollDelayMs,
  type LiveSnapshotLike,
  type PollState
} from '../src/spa/live-client'

const LIVE_URL = '/v1/admin/live.json'

let poll: PollState = initialPollState()
let pollTimer: ReturnType<typeof setTimeout> | null = null
let tickTimer: ReturnType<typeof setInterval> | null = null
let inFlight = false

/** Plan 3.7 item 4: `data-live-url` marks a real Worker response (operator/src/ui.ts stamps it
 *  from operator/src/routes/admin-core.ts's `liveUrl`); a standalone preview
 *  (operator/scripts/preview.mjs) never sets it, so there is truly nothing behind
 *  `/v1/admin/live.json` to reconnect to -- read once, the attribute never changes after paint,
 *  so every failed poll there reads "Offline preview" in grey rather than an amber
 *  "Reconnecting" that implies a real connection just dropped. */
function hasLiveEndpoint(): boolean {
  try {
    return document.documentElement.hasAttribute('data-live-url')
  } catch {
    return true
  }
}

function documentVisible(): boolean {
  return document.visibilityState === 'visible'
}

function paintIndicator(): void {
  var display: 'live' | 'reconnecting' | 'paused' | 'offline' = hasLiveEndpoint()
    ? displayLiveState(poll.state, documentVisible())
    : 'offline'
  var text = display === 'offline' ? 'Offline preview' : liveStatusText(display, poll.lastSuccessAt, Date.now(), relativeTime)
  document.querySelectorAll<HTMLElement>('[data-live-indicator]').forEach(function (el) {
    el.setAttribute('data-state', display)
    var span = el.querySelector<HTMLElement>('[data-live-text]')
    if (span) span.textContent = text
  })
  document.querySelectorAll<HTMLElement>('[data-live-dot]').forEach(function (el) {
    el.setAttribute('data-state', display)
  })
}

function updateBadges(snapshot: LiveSnapshotLike): void {
  var counts = badgeCountsFromSnapshot(snapshot)
  ;(Object.keys(counts) as Array<keyof typeof counts>).forEach(function (id) {
    var n = counts[id]
    if (n == null) return
    var link = document.querySelector<HTMLElement>('[data-nav="' + id + '"]')
    if (!link) return
    var badge = link.querySelector<HTMLElement>('[data-badge="' + id + '"]')
    if (n > 0) {
      if (!badge) {
        badge = document.createElement('span')
        badge.className = 'nav-count'
        badge.setAttribute('data-badge', id)
        link.appendChild(badge)
      }
      badge.textContent = String(n)
    } else if (badge) {
      badge.remove()
    }
  })
}

function updateLivePills(snapshot: LiveSnapshotLike): void {
  document.querySelectorAll<HTMLElement>('[data-world-live]').forEach(function (el) {
    el.textContent = 'LIVE ' + snapshot.liveSeats
  })
}

function schedule(): void {
  if (pollTimer) clearTimeout(pollTimer)
  var delay = pollDelayMs(poll, documentVisible())
  pollTimer = setTimeout(runPoll, delay)
}

async function runPoll(): Promise<void> {
  if (inFlight) return
  inFlight = true
  var headers: Record<string, string> = { accept: 'application/json' }
  if (poll.etag) headers['if-none-match'] = poll.etag
  try {
    var res = await fetch(LIVE_URL, { credentials: 'include', headers: headers })
    if (res.status === 304) {
      poll = nextPollState(poll, { kind: 'not-modified' }, Date.now())
    } else if (res.ok) {
      var etag = (res.headers && res.headers.get && res.headers.get('etag')) || null
      var body = (await res.json()) as LiveSnapshotLike
      poll = nextPollState(poll, { kind: 'ok', etag: etag }, Date.now())
      updateBadges(body)
      updateLivePills(body)
      window.dispatchEvent(new CustomEvent('metis:live', { detail: body }))
    } else {
      poll = nextPollState(poll, { kind: 'error' }, Date.now())
    }
  } catch (e) {
    poll = nextPollState(poll, { kind: 'error' }, Date.now())
  }
  inFlight = false
  paintIndicator()
  schedule()
}

export function startLivePolling(): void {
  paintIndicator()
  document.addEventListener('visibilitychange', function () {
    paintIndicator()
    if (documentVisible()) {
      // Coming back into view: poll right away instead of waiting out the hidden cadence.
      if (pollTimer) clearTimeout(pollTimer)
      runPoll()
    }
  })
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = setInterval(paintIndicator, 1000)
  runPoll()
}
