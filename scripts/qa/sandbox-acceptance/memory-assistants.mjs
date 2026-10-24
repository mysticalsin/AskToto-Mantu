// G88 sandbox scenario `--scenario memory-assistants` (CAP-26, CAP-29 local half, E2E-06/07): assistants are created only through
// the visible confirm card (a trusted click, never the confirm IPC), creation is idempotent, a memory is corrected and deleted,
// and all of it survives a relaunch with no tombstoned memory coming back and nothing readable at rest.
// QA identity only. Reports carry counts, revisions and booleans, never an assistant prompt or a memory text.
// Honest limits at this tip: the assistants bridge has no renderer consumer and `propose` is owner-command only, and the
// user-memory bridge has no add call (what Métis remembers comes from the owner's own command in main). A step whose surface is
// absent is NOT_SUPPORTED with the reason; it is never faked and no QA hook was added to src/.
import { join } from 'node:path'
import { fail, notSupported, pass, stepFromJudgment } from './judgment.mjs'
import { runStep } from './lib.mjs'
import { cleanQuit, dependentOutcome } from './settings-hig.mjs'
import { scanTreesForMarkers } from './voice-actions-lib.mjs'

export const MEMORY_ASSISTANTS_STEPS = Object.freeze([
  'launch-and-renderer-ready',
  'ma-assistant-propose-card',
  'ma-assistant-idempotent',
  'ma-memory-correct',
  'ma-memory-delete-tombstone',
  'clean-quit',
  'relaunch',
  'ma-persisted-after-relaunch',
  'final-quit',
  'ma-no-marker-at-rest'
])

/** Words this scenario writes. They must be unreadable at rest at the end and must never reach the report. */
export const MA_ASSISTANT_NAME = 'Marmoset helper'
export const MA_CORRECTED_TEXT = 'zebrafinch preference'
export const MA_MARKERS = Object.freeze(['marmoset', 'zebrafinch'])
const DRAFT_BASE = 'general'
const CARD_BUTTON = /^(create|confirm|add)\b.*assistant/i

/** A card must mount, the click must create exactly one assistant, and no confirm IPC may have been used. */
export function judgeProposeCard({ list, propose, cardMounted, confirmedViaIpc, countBefore, countAfter }) {
  if (!list) return notSupported('window.toto.assistants is not exposed by this build')
  if (!list.ok) return notSupported(`the assistants list is unavailable (${list.reason})`)
  if (!propose) return notSupported('propose was not attempted')
  if (!propose.ok)
    return notSupported(
      `propose is refused for a renderer-originated draft (${propose.reason}); no product route issues an owner command here`
    )
  if (confirmedViaIpc) return fail(['the assistant was confirmed through the confirm IPC, not the visible card'])
  if (!cardMounted)
    return notSupported(
      'no visible confirm card mounted for the proposal at this tip, so nothing can be confirmed by a click'
    )
  if (countAfter !== countBefore + 1)
    return fail([`the card click left ${countAfter} assistant(s), expected ${countBefore + 1}`])
  return pass()
}

/** Proposing and confirming the same draft again creates no second assistant. */
export function judgeIdempotent({ countBefore, countFirst, countSecond }) {
  const problems = []
  if (countFirst !== countBefore + 1)
    problems.push(`the first creation left ${countFirst}, expected ${countBefore + 1}`)
  if (countSecond !== countFirst) problems.push(`the repeat left ${countSecond} assistant(s), expected ${countFirst}`)
  return problems.length ? fail(problems) : pass()
}

/**
 * Correct a memory: the same id, a higher revision, and the corrected text is what the list now holds.
 * @param {{ status: string, count: number, correctOk?: boolean, revisionBefore?: number, revisionAfter?: number, textMatches?: boolean, sameId?: boolean }} input
 */
export function judgeMemoryCorrect({ status, count, correctOk, revisionBefore, revisionAfter, textMatches, sameId }) {
  if (status !== 'ok') return notSupported('the user memory list is unavailable')
  if (count === 0)
    return notSupported(
      'no memory exists in this profile and the bridge has no add call (memories come only from the owner command in main), so there is nothing to correct'
    )
  const problems = []
  if (!correctOk) problems.push('correct was refused')
  if (!sameId) problems.push('the corrected memory is no longer listed under its id')
  if (!(revisionAfter > revisionBefore))
    problems.push(`the revision did not rise (${revisionBefore} -> ${revisionAfter})`)
  if (!textMatches) problems.push('the list does not hold the corrected text')
  return problems.length ? fail(problems) : pass()
}

/** Delete a memory: one fewer item, one more tombstone, and the id is gone. */
export function judgeTombstone({ before, removeOk, after }) {
  if (!before || before.status !== 'ok') return notSupported('the user memory list is unavailable')
  if (before.count === 0) return notSupported('no memory exists in this profile, so there is nothing to delete')
  const problems = []
  if (!removeOk) problems.push('remove was refused')
  if (after.idStillListed) problems.push('the deleted memory is still listed')
  if (after.count !== before.count - 1) problems.push(`${after.count} memories remain, expected ${before.count - 1}`)
  if (!(after.tombstones > before.tombstones)) problems.push('no tombstone was recorded for the deletion')
  return problems.length ? fail(problems) : pass()
}

/** After a relaunch: exactly the assistants this profile created, and the deleted memory has not come back. */
export function judgePersisted({ expectedAssistants, assistantsAfter, deletedMemoryListed }) {
  if (expectedAssistants === null && deletedMemoryListed === null)
    return notSupported('nothing was created or deleted in this profile, so there is nothing to persist')
  const problems = []
  if (expectedAssistants !== null && assistantsAfter !== expectedAssistants)
    problems.push(`${assistantsAfter} assistant(s) after the relaunch, expected exactly ${expectedAssistants}`)
  if (deletedMemoryListed === true) problems.push('a deleted memory came back after the relaunch')
  return problems.length ? fail(problems) : pass()
}

/** Nothing the scenario wrote is readable at rest once the app has quit. */
export function judgeNoMarkerAtRest({ scan, markersWritten }) {
  if (!markersWritten)
    return notSupported(
      'no marker was written (the steps that write one were not supported), so the scan proves nothing'
    )
  const problems = []
  if (scan.files === 0) problems.push('the scan read no files, so it proves nothing')
  for (const [index, count] of Object.values(scan.hits).entries())
    if (count > 0) problems.push(`${count} readable hit(s) for scenario marker ${index + 1} of ${MA_MARKERS.length}`)
  return problems.length ? fail(problems) : pass()
}

const listAssistantsSource = `async () => {
  const api = window.toto && window.toto.assistants
  if (!api) return null
  const result = await api.list()
  return result.ok ? { ok: true, count: result.assistants.filter((a) => !a.system).length } : { ok: false, reason: result.reason }
}`
const listMemorySource = `async () => {
  const api = window.toto && window.toto.userMemory
  if (!api) return null
  const result = await api.list()
  return { status: result.status, count: result.items.length, tombstones: result.tombstones, ids: result.items.map((i) => i.id), revisions: Object.fromEntries(result.items.map((i) => [i.id, i.revision])), texts: Object.fromEntries(result.items.map((i) => [i.id, i.text])) }
}`

/**
 * Run the scenario, recording one step per id of MEMORY_ASSISTANTS_STEPS.
 * @param {{ report: any, layout: any, launch: () => Promise<any>, onSession: (session: any) => void }} args
 */
export async function runMemoryAssistantsScenario({ report, layout, launch, onSession }) {
  let session = null
  const ctx = { countBefore: null, countFirst: null, deletedId: null, deletedOk: false, markersWritten: false }
  const start = async () => {
    session = await launch()
    onSession(session)
    return session
  }
  const page = () => session.connect()
  const ready = () => ({
    evidence: {
      pid: session.pid,
      rendererReadyAudit: session.audit().some((record) => record.event === 'app.renderer.ready'),
      cdpConnected: Boolean(session.page)
    }
  })
  const listAssistants = async () => (await page()).evaluate(`(${listAssistantsSource})()`)
  const listMemory = async () => (await page()).evaluate(`(${listMemorySource})()`)
  const summary = (memory) => memory && { status: memory.status, count: memory.count, tombstones: memory.tombstones }

  await runStep(report, 'launch-and-renderer-ready', async () => {
    await start()
    return ready()
  })
  const launched = { requires: ['launch-and-renderer-ready'] }

  await runStep(
    report,
    'ma-assistant-propose-card',
    async () => {
      const p = await page()
      const list = await listAssistants()
      ctx.countBefore = list?.ok ? list.count : null
      const propose = list?.ok
        ? await p.evaluate(
            async ([name, base]) => {
              const result = await window.toto.assistants.propose([{ name, base }])
              return result.ok ? { ok: true } : { ok: false, reason: result.reason }
            },
            [MA_ASSISTANT_NAME, DRAFT_BASE]
          )
        : null
      const card = propose?.ok ? p.getByRole('button', { name: CARD_BUTTON }).first() : null
      const cardMounted = card
        ? await card
            .waitFor({ state: 'visible', timeout: 5_000 })
            .then(() => true)
            .catch(() => false)
        : false
      if (cardMounted) await card.click({ timeout: 5_000 })
      const after = cardMounted ? await listAssistants() : null
      ctx.countFirst = after?.ok ? after.count : null
      const judgment = judgeProposeCard({
        list,
        propose,
        cardMounted,
        confirmedViaIpc: false,
        countBefore: ctx.countBefore,
        countAfter: ctx.countFirst
      })
      if (judgment.outcome === 'PASS') ctx.markersWritten = true
      return stepFromJudgment(judgment, {
        countBefore: ctx.countBefore,
        cardMounted,
        countAfter: ctx.countFirst,
        confirmedViaIpc: false
      })
    },
    launched
  )

  await runStep(
    report,
    'ma-assistant-idempotent',
    async () => {
      const blocked = dependentOutcome(report.steps, 'ma-assistant-propose-card')
      if (blocked) return blocked
      const p = await page()
      await p.evaluate(
        async ([name, base]) => {
          await window.toto.assistants.propose([{ name, base }])
        },
        [MA_ASSISTANT_NAME, DRAFT_BASE]
      )
      const card = p.getByRole('button', { name: CARD_BUTTON }).first()
      if (await card.isVisible().catch(() => false)) await card.click({ timeout: 5_000 })
      const second = await listAssistants()
      const countSecond = second?.ok ? second.count : null
      return stepFromJudgment(
        judgeIdempotent({ countBefore: ctx.countBefore, countFirst: ctx.countFirst, countSecond }),
        { countBefore: ctx.countBefore, countFirst: ctx.countFirst, countSecond }
      )
    },
    launched
  )

  await runStep(
    report,
    'ma-memory-correct',
    async () => {
      const before = await listMemory()
      if (!before || before.status !== 'ok' || before.count === 0)
        return stepFromJudgment(
          judgeMemoryCorrect({ status: before?.status ?? 'unavailable', count: before?.count ?? 0 }),
          {
            memory: summary(before)
          }
        )
      const id = before.ids[0]
      const correctOk = await (await page()).evaluate(
        async ([memoryId, text]) => (await window.toto.userMemory.correct(memoryId, text)).ok,
        [id, MA_CORRECTED_TEXT]
      )
      const after = await listMemory()
      ctx.markersWritten = ctx.markersWritten || correctOk
      return stepFromJudgment(
        judgeMemoryCorrect({
          status: after.status,
          count: after.count,
          correctOk,
          revisionBefore: before.revisions[id],
          revisionAfter: after.revisions[id],
          textMatches: after.texts[id] === MA_CORRECTED_TEXT,
          sameId: after.ids.includes(id)
        }),
        { correctOk, revisionBefore: before.revisions[id], revisionAfter: after.revisions[id] }
      )
    },
    launched
  )

  await runStep(
    report,
    'ma-memory-delete-tombstone',
    async () => {
      const before = await listMemory()
      if (!before || before.status !== 'ok' || before.count === 0)
        return stepFromJudgment(judgeTombstone({ before: before && { status: before.status, count: before.count } }), {
          memory: summary(before)
        })
      const id = before.ids[0]
      const removeOk = await (await page()).evaluate(
        async (memoryId) => (await window.toto.userMemory.remove(memoryId)).ok,
        id
      )
      const after = await listMemory()
      ctx.deletedId = id
      ctx.deletedOk = removeOk
      return stepFromJudgment(
        judgeTombstone({
          before: { status: before.status, count: before.count, tombstones: before.tombstones },
          removeOk,
          after: { count: after.count, tombstones: after.tombstones, idStillListed: after.ids.includes(id) }
        }),
        { removeOk, before: summary(before), after: summary(after) }
      )
    },
    launched
  )

  await runStep(report, 'clean-quit', () => cleanQuit(session), launched)
  await runStep(
    report,
    'relaunch',
    async () => {
      await start()
      return ready()
    },
    { requires: ['clean-quit'] }
  )
  await runStep(
    report,
    'ma-persisted-after-relaunch',
    async () => {
      const assistants = await listAssistants()
      const memory = await listMemory()
      const expectedAssistants =
        report.steps.find((step) => step.id === 'ma-assistant-propose-card')?.status === 'PASS' ? ctx.countFirst : null
      const deletedMemoryListed = ctx.deletedOk ? Boolean(memory?.ids?.includes(ctx.deletedId)) : null
      const assistantsAfter = assistants?.ok ? assistants.count : null
      return stepFromJudgment(judgePersisted({ expectedAssistants, assistantsAfter, deletedMemoryListed }), {
        expectedAssistants,
        assistantsAfter,
        deletedMemoryListed
      })
    },
    { requires: ['relaunch'] }
  )
  await runStep(report, 'final-quit', () => cleanQuit(session), { requires: ['relaunch'] })
  await runStep(report, 'ma-no-marker-at-rest', async () => {
    const excluded = (path) => path.startsWith(join(layout.userData, 'qa-capture'))
    const scan = scanTreesForMarkers([layout.userData, layout.home, layout.tmp], MA_MARKERS, { exclude: excluded })
    return stepFromJudgment(judgeNoMarkerAtRest({ scan, markersWritten: ctx.markersWritten }), {
      filesScanned: scan.files,
      bytesScanned: scan.bytes,
      hitsPerMarker: Object.values(scan.hits),
      markersChecked: MA_MARKERS.length
    })
  })
}
