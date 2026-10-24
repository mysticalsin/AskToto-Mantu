// G88 sandbox scenario `--scenario quiet-mode` (CAP-32, quiet half, G68): with a synthetic meeting live the output gate holds
// unsolicited output, a typed direct request is still answered, and the held output is released once after Stop.
// QA identity only. The gate is never disabled or reconfigured to make a step pass; the steps read `getQuietPolicy` and
// `quietOutputOffer` through the real preload bridge and drive the real Ask box. Reports carry actions, counts and booleans, never
// a question or an answer. The judges are pure (quiet-mode.test.ts); the runner needs the installed QA build.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { createMockLlmServer } from '../mock-llm-server.mjs'
import { sleep } from '../lib/app-driver.mjs'
import { fail, notSupported, pass, stepFromJudgment } from './judgment.mjs'
import { runStep } from './lib.mjs'
import { cleanQuit } from './settings-hig.mjs'
import { startSyntheticMeeting, stopAndSave } from './scenario.mjs'
import { mintSelfSignedCert, voiceExtraEnv, voiceSeedSettings } from './voice-actions.mjs'

export const QUIET_MODE_STEPS = Object.freeze([
  'launch-and-renderer-ready',
  'qm-policy-default',
  'qm-meeting-live',
  'qm-unsolicited-held',
  'qm-direct-request-answered',
  'qm-released-after-stop',
  'clean-quit'
])

/** src/shared/quiet-mode-settings.ts QUIET_OUTPUT_CHANNELS (quiet-mode.test.ts reads that file to catch drift). */
export const QUIET_CHANNELS = Object.freeze(['toast', 'sound', 'spokenReply', 'proactiveSuggestion', 'autoAnswerCard'])
const ACTIONS = Object.freeze(['allow', 'defer', 'drop'])

/** The question typed in the direct-request step. A report that contains it is withheld (run-acceptance checks). */
export const QUIET_QUESTION = 'How many quokkas live on the island?'
export const QUIET_MARKERS = Object.freeze(['quokka'])
const MOCK_ANSWER_TEXT = 'Backup answer from mock'
const ASK_BOX_LABEL = 'Ask Métis anything'

const shapeProblems = (policy) => {
  if (!policy || typeof policy !== 'object') return ['getQuietPolicy returned no policy object']
  const problems = []
  for (const channel of QUIET_CHANNELS)
    if (!ACTIONS.includes(policy[channel])) problems.push(`policy.${channel} is not allow, defer or drop`)
  const extra = Object.keys(policy).filter((key) => !QUIET_CHANNELS.includes(key))
  if (extra.length) problems.push(`policy carries ${extra.length} unknown channel(s)`)
  return problems
}

/** The idle default: a valid policy that allows everything. A host whose OS Focus is on makes it NOT_SUPPORTED, never a PASS. */
export function judgePolicyDefault(policy) {
  if (policy === null || policy === undefined)
    return notSupported('window.toto.getQuietPolicy is not exposed by this build')
  const problems = shapeProblems(policy)
  if (problems.length) return fail(problems)
  if (QUIET_CHANNELS.some((channel) => policy[channel] !== 'allow'))
    return notSupported(
      'the idle policy is already quiet on this host (an OS Focus mode may be active), so the default cannot be shown'
    )
  return pass()
}

/** With a meeting live every channel is held (defer or drop) and every offer gets the policy's own answer, never allow. */
export function judgeUnsolicitedHeld({ policy, offers }) {
  if (policy === null || policy === undefined || offers === null || offers === undefined)
    return notSupported('window.toto.getQuietPolicy or quietOutputOffer is not exposed by this build')
  const problems = shapeProblems(policy)
  for (const channel of QUIET_CHANNELS) {
    if (policy?.[channel] === 'allow') problems.push(`the policy still allows ${channel} while a meeting is live`)
    if (offers[channel] === 'allow') problems.push(`an unsolicited ${channel} offer was allowed during the meeting`)
    else if (!ACTIONS.includes(offers[channel])) problems.push(`the ${channel} offer returned no action`)
    else if (policy?.[channel] !== offers[channel])
      problems.push(`the ${channel} offer answered ${offers[channel]} but the policy says ${policy?.[channel]}`)
  }
  return problems.length ? fail(problems) : pass()
}

/** A typed ask is answered while quiet: the answer view shows and the mock LLM saw exactly one request. */
export function judgeDirectAnswered({ mockAvailable, mockRequests, answerShown, askBoxFound }) {
  if (!mockAvailable) return notSupported('the local mock LLM could not start, so no answer can be observed')
  if (!askBoxFound) return notSupported(`no text box named "${ASK_BOX_LABEL}" is on screen in this build`)
  const problems = []
  if (!answerShown) problems.push('the answer view never showed the mock answer while quiet')
  if (mockRequests !== 1) problems.push(`the mock LLM saw ${mockRequests} request(s), expected exactly 1`)
  return problems.length ? fail(problems) : pass()
}

/** After Stop the gate ends the quiet and releases what it deferred, once, naming every deferred channel. */
export function judgeReleased({ deferredChannels, events, policyAfter }) {
  if (deferredChannels.length === 0) return fail(['no offer was deferred, so there is nothing to release'])
  if (events.length === 0) {
    if (policyAfter && QUIET_CHANNELS.every((channel) => policyAfter[channel] === 'allow'))
      return fail(['the policy is allow again after Stop but no release event arrived'])
    return notSupported('the policy is still quiet after Stop (an OS Focus mode may be active), so no release is due')
  }
  const problems = []
  if (events.length > 1) problems.push(`${events.length} release events arrived, expected one coalesced batch`)
  const released = new Set(events.flatMap((event) => event.channels ?? []))
  for (const channel of deferredChannels)
    if (!released.has(channel)) problems.push(`the deferred ${channel} offer was never released`)
  if (events.some((event) => !(event.releasedAtMs >= event.startedAtMs)))
    problems.push('a release event is dated before its own start')
  return problems.length ? fail(problems) : pass()
}

/**
 * The local mock LLM the direct-request step needs, started before the profile is seeded (the seed names its port).
 * It is optional: without it that step is NOT_SUPPORTED. Same mock and certificate handling as voice-actions.
 */
export async function prepareQuietMode({ layout, log = () => {} }) {
  let mock = null
  let mockReason = null
  try {
    const certDir = join(layout.tmp, 'qm-cert')
    try {
      const tls = mintSelfSignedCert(certDir)
      const { server, log: requestLog } = createMockLlmServer({ tls })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      mock = { server, log: requestLog, port: server.address().port }
    } finally {
      rmSync(certDir, { recursive: true, force: true })
    }
  } catch (error) {
    mockReason = `the local mock LLM could not start: ${String(error?.message ?? error).slice(0, 200)}`
    log(mockReason)
  }
  return {
    mock,
    mockReason,
    seed: mock ? voiceSeedSettings(mock.port) : {},
    extraEnv: voiceExtraEnv(layout, { fifo: false, tls: Boolean(mock) }),
    stop: async () => {
      if (mock) await new Promise((resolve) => mock.server.close(() => resolve())).catch(() => {})
    }
  }
}

/**
 * Run the scenario, recording one step per id of QUIET_MODE_STEPS.
 * @param {{ report: any, launch: () => Promise<any>, onSession: (session: any) => void, prepared: Awaited<ReturnType<typeof prepareQuietMode>>, config?: { saveWaitSeconds?: number } }} args
 */
export async function runQuietModeScenario({ report, launch, onSession, prepared, config = {} }) {
  let session = null
  const ctx = { deferredChannels: [] }
  await runStep(report, 'launch-and-renderer-ready', async () => {
    session = await launch()
    onSession(session)
    return {
      evidence: {
        pid: session.pid,
        rendererReadyAudit: session.audit().some((record) => record.event === 'app.renderer.ready'),
        cdpConnected: Boolean(session.page),
        captureFileSourceAudit: session.audit().some((record) => record.event === 'qa.capture.file_source')
      }
    }
  })
  const launched = { requires: ['launch-and-renderer-ready'] }
  const readPolicy = async () => {
    const page = await session.connect()
    return page.evaluate(() =>
      typeof window.toto?.getQuietPolicy === 'function' ? window.toto.getQuietPolicy() : null
    )
  }

  await runStep(
    report,
    'qm-policy-default',
    async () => {
      const policy = await readPolicy()
      return stepFromJudgment(judgePolicyDefault(policy), { policy: policy ?? null })
    },
    launched
  )
  await runStep(report, 'qm-meeting-live', () => startSyntheticMeeting(session), launched)

  await runStep(
    report,
    'qm-unsolicited-held',
    async () => {
      const page = await session.connect()
      const policy = await readPolicy()
      const offers = await page.evaluate(async (channels) => {
        if (typeof window.toto?.quietOutputOffer !== 'function') return null
        window.__qmReleased = []
        if (typeof window.toto.onQuietOutputReleased === 'function')
          window.__qmUnsub = window.toto.onQuietOutputReleased((batch) => window.__qmReleased.push(batch))
        const out = {}
        for (const channel of channels) out[channel] = await window.toto.quietOutputOffer(channel)
        return out
      }, QUIET_CHANNELS)
      ctx.deferredChannels = offers ? QUIET_CHANNELS.filter((channel) => offers[channel] === 'defer') : []
      return stepFromJudgment(judgeUnsolicitedHeld({ policy, offers }), {
        policy: policy ?? null,
        offers: offers ?? null,
        deferredChannels: ctx.deferredChannels.length
      })
    },
    { requires: ['qm-meeting-live'] }
  )

  await runStep(
    report,
    'qm-direct-request-answered',
    async () => {
      const page = await session.connect()
      const box = page.getByRole('textbox', { name: ASK_BOX_LABEL }).first()
      const askBoxFound = await box
        .waitFor({ state: 'visible', timeout: 10_000 })
        .then(() => true)
        .catch(() => false)
      if (!prepared.mock || !askBoxFound)
        return stepFromJudgment(
          judgeDirectAnswered({
            mockAvailable: Boolean(prepared.mock),
            mockRequests: 0,
            answerShown: false,
            askBoxFound
          }),
          { mockAvailable: Boolean(prepared.mock), askBoxFound }
        )
      await page.evaluate(() => window.toto.setApiKey('custom', 'synthetic-mock-key'))
      prepared.mock.log.clear()
      await box.fill(QUIET_QUESTION)
      await box.press('Enter')
      const answerShown = await page
        .getByText(MOCK_ANSWER_TEXT)
        .first()
        .waitFor({ state: 'visible', timeout: 40_000 })
        .then(() => true)
        .catch(() => false)
      await sleep(500)
      const mockRequests = prepared.mock.log.total()
      return stepFromJudgment(judgeDirectAnswered({ mockAvailable: true, mockRequests, answerShown, askBoxFound }), {
        answerShown,
        mockRequests
      })
    },
    { requires: ['qm-unsolicited-held'] }
  )

  await runStep(
    report,
    'qm-released-after-stop',
    async () => {
      const stopped = await stopAndSave(session, { waitSeconds: config.saveWaitSeconds ?? 180 })
      const page = await session.connect()
      let events = []
      for (let waited = 0; waited < 15_000 && events.length === 0; waited += 500) {
        events = await page.evaluate(() => window.__qmReleased ?? [])
        if (events.length === 0) await sleep(500)
      }
      const policyAfter = await readPolicy()
      return stepFromJudgment(judgeReleased({ deferredChannels: ctx.deferredChannels, events, policyAfter }), {
        meetingSaved: Boolean(stopped.file),
        deferredChannels: ctx.deferredChannels.length,
        releaseEvents: events.length,
        releasedChannels: events.reduce((total, event) => total + (event.channels?.length ?? 0), 0)
      })
    },
    { requires: ['qm-unsolicited-held'] }
  )

  await runStep(report, 'clean-quit', () => cleanQuit(session), launched)
}
