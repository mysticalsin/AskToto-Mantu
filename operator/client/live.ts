/**
 * Live polling (plan D3/D4). Polls GET /v1/admin/live.json every 5s while the tab is visible,
 * 30s while hidden, sending If-None-Match from the last ETag and treating 304 as "nothing
 * changed". Network or non-2xx/304 errors back off through 5/10/20/30s and flip the rail
 * indicator to "Live paused · retrying"; a hidden tab always shows "Paused" regardless of
 * connection health. A 401 or a redirect (Cloudflare Access sending the browser to its login
 * page, seen as an opaque redirect because of `redirect: 'manual'`) is terminal: polling stops,
 * the indicator reads "Session expired — reload" and a `[data-session-banner]` alert appears.
 * This module is the ONLY live poller; pages listen to `metis:live` / `metis:live-state`. Every successful 200 updates the rail live indicator, the rail badges the payload
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
let lastDispatchedState: string | null = null

function documentVisible(): boolean {
  return document.visibilityState === 'visible'
}

function paintIndicator(): void {
  var display = displayLiveState(poll.state, documentVisible())
  var text = liveStatusText(display, poll.lastSuccessAt, Date.now(), relativeTime)
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

function dispatchState(): void {
  if (poll.state === lastDispatchedState) return
  lastDispatchedState = poll.state
  window.dispatchEvent(new CustomEvent('metis:live-state', { detail: { state: poll.state } }))
}

function showSessionBanner(): void {
  if (document.querySelector('[data-session-banner]')) return
  var banner = document.createElement('div')
  banner.className = 'session-banner'
  banner.setAttribute('data-session-banner', '')
  banner.setAttribute('role', 'alert')
  var text = document.createElement('span')
  text.textContent = 'Session expired — reload'
  var button = document.createElement('button')
  button.type = 'button'
  button.className = 'tool'
  button.textContent = 'Reload'
  button.addEventListener('click', function () {
    window.location.reload()
  })
  banner.appendChild(text)
  banner.appendChild(button)
  var host = document.querySelector('.main') || document.body
  host.insertBefore(banner, host.firstChild)
}

function stopPolling(): void {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
}

function schedule(): void {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
  var delay = pollDelayMs(poll, documentVisible())
  if (delay == null) {
    stopPolling()
    showSessionBanner()
    return
  }
  pollTimer = setTimeout(runPoll, delay)
}

async function runPoll(): Promise<void> {
  if (inFlight || poll.state === 'expired') return
  inFlight = true
  var headers: Record<string, string> = { accept: 'application/json' }
  if (poll.etag) headers['if-none-match'] = poll.etag
  try {
    var res = await fetch(LIVE_URL, { credentials: 'include', headers: headers, redirect: 'manual' })
    if (res.type === 'opaqueredirect' || res.status === 401 || (res.status >= 300 && res.status < 400 && res.status !== 304)) {
      poll = nextPollState(poll, { kind: 'expired' }, Date.now())
    } else if (res.status === 304) {
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
  dispatchState()
  schedule()
}

export function startLivePolling(): void {
  paintIndicator()
  document.addEventListener('visibilitychange', function () {
    paintIndicator()
    if (poll.state === 'expired') return
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
