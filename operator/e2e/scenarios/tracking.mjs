/**
 * tracking: the scenario Tony most cares about ("make sure it works end to end with tracking from
 * Métis and all"). One real seat (Montréal, CA — licensed and approved, matching the desktop
 * contract in operator/README.md) heartbeats, asks, listens/recaps, rates, and pushes a CRM send
 * through a real HMAC-signed HTTP round trip against the booted Worker, then every assertion reads
 * back through the SAME admin JSON endpoints the console itself renders from
 * (operator/src/routes/live.ts, events.ts, sessions.ts, admin-core.ts) — never the store directly.
 */
import '../lib/http.mjs'
import { Check } from '../lib/assert.mjs'
import { adminClient } from '../lib/admin.mjs'
import { Seat } from '../seat.mjs'

export const DEVICE_ID = 'e2e-track-ca-01'
export const HOSTNAME = 'e2e-mbp-tracking'
export const SSO_EMAIL = 'tracking.ca@example.com'
const OS = 'darwin'
const APP_VERSION = '1.9.0-e2e'
const CF = { country: 'CA', city: 'Montréal', region: 'Quebec', latitude: '45.5017', longitude: '-73.5673' }
const QUESTION = 'What is our Q3 pipeline coverage for the Nightingale account, and is it trending up or down?'
const ASK_ID = 'e2e-track-ask-01'
const RECAP_ID = 'e2e-track-recap-01'
const CRM_ID = 'e2e-track-crm-01'

function bodyHasSubstring(text, needle) {
  return typeof text === 'string' && text.includes(needle)
}

export async function run(ctx) {
  const startedAt = Date.now()
  const check = new Check()
  const admin = adminClient(ctx)
  const seat = new Seat({
    baseUrl: ctx.baseUrl,
    secret: ctx.ingestSecret,
    deviceId: DEVICE_ID,
    seatHash: 'e2e-track-seathash-01',
    os: OS,
    appVersion: APP_VERSION,
    hostname: HOSTNAME,
    ssoEmail: SSO_EMAIL,
    cf: CF,
    hmac: ctx.hmac
  })

  // 1. Heartbeat creates the seat.
  const hb = await seat.heartbeat()
  check.that(hb.status === 200, 'heartbeat returns 200', { file: 'operator/src/index.ts', line: 315, expected: 200, actual: hb.status })
  check.that(hb.json?.ok === true, 'heartbeat body ok:true', { expected: true, actual: hb.json?.ok })

  // 2. Seat appears in live.json (Realtime/Overview poll) with hostname, country, OS.
  const live = await admin.get('/v1/admin/live.json')
  check.that(live.status === 200, 'GET /v1/admin/live.json returns 200', { actual: live.status })
  const liveRow = live.json?.liveSeatsTable?.find((r) => r.deviceId === DEVICE_ID)
  check.that(Boolean(liveRow), 'seat appears in live.json liveSeatsTable', {
    file: 'operator/src/dashboard.ts',
    line: 1172,
    expected: `a row with deviceId ${DEVICE_ID}`,
    actual: live.json?.liveSeatsTable?.map((r) => r.deviceId)
  })
  if (liveRow) {
    check.that(liveRow.hostname === HOSTNAME, 'live.json row hostname matches the seat', { expected: HOSTNAME, actual: liveRow.hostname })
    check.that(liveRow.country === 'CA', 'live.json row country matches the simulated edge geo', { expected: 'CA', actual: liveRow.country })
    check.that(liveRow.os === OS, 'live.json row os matches the seat', { expected: OS, actual: liveRow.os })
  }

  // 3. Same fields on the Realtime page's own live-seats endpoint.
  const liveSeats = await admin.get('/v1/admin/realtime/live-seats.json')
  const rtRow = liveSeats.json?.rows?.find((r) => r.deviceId === DEVICE_ID)
  check.that(Boolean(rtRow), 'seat appears in /v1/admin/realtime/live-seats.json', {
    file: 'operator/src/routes/live.ts',
    line: 62,
    actual: liveSeats.json?.rows?.map((r) => r.deviceId)
  })
  if (rtRow) {
    check.that(rtRow.hostname === HOSTNAME && rtRow.country === 'CA' && rtRow.os === OS, 'realtime live-seats row carries the same hostname/country/os', {
      expected: { hostname: HOSTNAME, country: 'CA', os: OS },
      actual: { hostname: rtRow.hostname, country: rtRow.country, os: rtRow.os }
    })
  }

  // 4. An ask lands in events.json and sessions.json with its question type, never its text.
  const ask = await seat.ask({
    id: ASK_ID,
    question: QUESTION,
    questionType: 'factual',
    mode: 'typed',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    ttftMs: 420,
    totalMs: 3100,
    inputTokens: 1200,
    outputTokens: 340,
    outcome: 'answered'
  })
  check.that(ask.status === 200 && ask.json?.ok === true, 'ask ingest returns 200 ok:true', { actual: { status: ask.status, body: ask.json } })

  const events = await admin.get(`/v1/admin/events.json?device=${encodeURIComponent(DEVICE_ID)}&range=24h&limit=200`)
  check.that(!bodyHasSubstring(events.text, QUESTION), 'events.json never contains the raw ask text', {
    file: 'operator/src/routes/events.ts',
    line: 178,
    expected: 'no substring of the question in the response body',
    actual: 'checked full response text'
  })
  const askEvent = events.json?.rows?.find((r) => r.kind === 'ask' && r.deviceId === DEVICE_ID)
  check.that(Boolean(askEvent), 'ask event lands in events.json for this seat', { actual: events.json?.rows?.map((r) => r.kind) })
  if (askEvent) {
    check.that(askEvent.questionType === 'factual', 'events.json ask row carries the question type', {
      file: 'operator/src/routes/events.ts',
      line: 128,
      expected: 'factual',
      actual: askEvent.questionType
    })
  }

  const sessions = await admin.get(`/v1/admin/sessions.json?device=${encodeURIComponent(DEVICE_ID)}&range=24h`)
  check.that(!bodyHasSubstring(sessions.text, QUESTION), 'sessions.json never contains the raw ask text', { file: 'operator/src/routes/sessions.ts' })
  const sessionRow = sessions.json?.rows?.find((r) => r.deviceId === DEVICE_ID)
  check.that(Boolean(sessionRow), 'seat has a session row in sessions.json', { actual: sessions.json?.rows?.map((r) => r.deviceId) })
  check.that((sessionRow?.asks ?? 0) >= 1, 'session row counts at least one ask', { actual: sessionRow?.asks })

  if (sessionRow) {
    const detail = await admin.get(`/v1/admin/sessions/${encodeURIComponent(sessionRow.id)}.json`)
    check.that(!bodyHasSubstring(detail.text, QUESTION), 'session detail never contains the raw ask text', {
      file: 'operator/src/routes/sessions.ts',
      line: 174
    })
    const askDetail = detail.json?.asks?.find((a) => a.id === ASK_ID)
    check.that(Boolean(askDetail), 'session detail lists this ask by id', { actual: detail.json?.asks?.map((a) => a.id) })
    check.that(askDetail?.questionType === 'factual', 'session detail ask carries the question type', { actual: askDetail?.questionType })
    check.that(!('question' in (askDetail ?? {})) && !('preview' in (askDetail ?? {})), 'session detail ask row has no question/preview field at all', {
      actual: askDetail ? Object.keys(askDetail) : null
    })
  }

  // 5. Positive control: the audited single-ask Reveal DOES return the real text, and is audited.
  const revealed = await admin.get(`/v1/admin/asks/${encodeURIComponent(ASK_ID)}`)
  check.that(revealed.status === 200 && revealed.json?.question === QUESTION, 'admin Reveal returns the exact ask text for this one id', {
    file: 'operator/src/routes/admin-core.ts',
    line: 313,
    expected: QUESTION,
    actual: revealed.json?.question
  })
  const auditAfterReveal = await admin.get(`/v1/admin/audit.json?action=reveal&limit=20`)
  const revealAudit = auditAfterReveal.json?.audit?.find((a) => a.ask_id === ASK_ID)
  check.that(Boolean(revealAudit), 'the Reveal call is audited with this ask id', { actual: auditAfterReveal.json?.audit?.map((a) => a.ask_id) })

  // 6. Recap and rating land.
  const recap = await seat.recap({ id: RECAP_ID, minutes: 12 })
  check.that(recap.status === 200 && recap.json?.ok === true, 'recap ingest returns 200 ok:true', { actual: { status: recap.status, body: recap.json } })
  const rating = await seat.rating({ id: ASK_ID, rating: 'up' })
  check.that(rating.status === 200 && rating.json?.ok === true, 'rating ingest returns 200 ok:true', { actual: { status: rating.status, body: rating.json } })

  const eventsAfter = await admin.get(`/v1/admin/events.json?device=${encodeURIComponent(DEVICE_ID)}&range=24h&limit=200`)
  const recapEvent = eventsAfter.json?.rows?.find((r) => r.kind === 'recap' && r.deviceId === DEVICE_ID)
  check.that(Boolean(recapEvent), 'recap event lands in events.json', { actual: eventsAfter.json?.rows?.map((r) => r.kind) })
  check.that(recapEvent?.detail === '12m', 'recap event detail records the duration', { actual: recapEvent?.detail })
  const ratingEvent = eventsAfter.json?.rows?.find((r) => r.kind === 'rating' && r.deviceId === DEVICE_ID)
  check.that(Boolean(ratingEvent), 'rating event lands in events.json', { actual: eventsAfter.json?.rows?.map((r) => r.kind) })

  const asksList = await admin.get('/v1/admin/asks')
  const askListRow = asksList.json?.asks?.find((a) => a.id === ASK_ID)
  check.that(askListRow?.rating === 'up', 'the rated ask shows rating "up" in the asks list', {
    file: 'operator/src/routes/admin-core.ts',
    line: 303,
    expected: 'up',
    actual: askListRow?.rating
  })
  check.that(!('prompt_cipher' in (askListRow ?? {})) && !('question' in (askListRow ?? {})), 'the asks list never carries ciphertext or question text', {
    actual: askListRow ? Object.keys(askListRow) : null
  })

  // 7. A CRM send lands and can be retried without auto-sending.
  const crm = await seat.crmSend({ id: CRM_ID, status: 'failed', title: 'Acme Corp intro email', connector: 'salesforce', error: 'auth error' })
  check.that(crm.status === 200 && crm.json?.ok === true, 'CRM send ingest returns 200 ok:true', { actual: { status: crm.status, body: crm.json } })

  const dashBeforeRetry = await admin.get('/v1/admin/dashboard')
  const crmRowBefore = dashBeforeRetry.json?.crm?.rows?.find((r) => r.id === CRM_ID)
  check.that(crmRowBefore?.status === 'failed', 'CRM row shows failed before retry', { actual: crmRowBefore?.status })

  const retry = await admin.post(`/v1/admin/crm/${encodeURIComponent(CRM_ID)}/retry`, undefined)
  check.that(retry.status === 200 && retry.json?.ok === true && retry.json?.autoSend === false, 'CRM retry returns ok:true, autoSend:false (never auto-sends)', {
    file: 'operator/src/routes/admin-core.ts',
    line: 382,
    expected: { ok: true, autoSend: false },
    actual: retry.json
  })

  const dashAfterRetry = await admin.get('/v1/admin/dashboard')
  const crmRowAfter = dashAfterRetry.json?.crm?.rows?.find((r) => r.id === CRM_ID)
  check.that(crmRowAfter?.status === 'pending', 'CRM row flips back to pending after retry (never straight to success)', {
    file: 'operator/src/routes/admin-core.ts',
    line: 377,
    expected: 'pending',
    actual: crmRowAfter?.status
  })

  return check.result('tracking', startedAt, { deviceId: DEVICE_ID })
}
