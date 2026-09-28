import * as ingestModule from '../brain/ingest'
import * as storeModule from '../brain/store'
import { settleIntelligenceIndexForTests } from '../brain/intelligence-index'

// ingest.ts and store.ts export their lane state as live bindings (`export let`) for this file only: read, never assign.
type IngestLane = Pick<
  typeof ingestModule,
  'indexLock' | 'drainTask' | 'backfillFinalization' | 'rebuildReplayTask' | 'backfillObserver'
>
type EntityLane = Pick<typeof storeModule, 'entityMutationLock'>

/**
 * Test-only: wait for the entity-mutation lane (account/person/deal/graph writes, corrections, publish)
 * to go idle. Loops because a write already in flight can chain another (e.g. a correction replay, or
 * the publish call inside a backfill's own withEntityLock) before a single await would return — a
 * suite's cleanup that deletes the profile right after only the FIRST write settled would still race the
 * next one.
 */
export async function whenEntityWritesSettle(store: EntityLane = storeModule): Promise<void> {
  let seen: Promise<void> | null = null
  while (seen !== store.entityMutationLock) {
    seen = store.entityMutationLock
    await seen
  }
}

/**
 * Test-only: wait for the WHOLE ingest worker lane — queue drain, backfill finalization, rebuild replay,
 * the completion observer, and every index.json/entity write any of them chain — to go fully idle.
 *
 * `whenIndexWritesSettle` alone only waits for a write already queued on `indexLock` at the moment it's
 * called. A drain/finalization/replay task that hasn't reached its own `updateIndex`/`withEntityLock` call
 * yet is invisible to it — and each stage can start the next (drain completing a backfill run can trigger
 * finalization; finalization can resolve the completion observer), so one pass is not enough either. This
 * loops until a full pass leaves every one of these references unchanged.
 *
 * Pass the ingest/store module instances the suite actually exercises when it resets modules between tests.
 */
export async function whenIngestWorkSettles(
  ingest: IngestLane = ingestModule,
  store: EntityLane = storeModule
): Promise<void> {
  for (;;) {
    const before = [ingest.indexLock, ingest.drainTask, ingest.backfillFinalization, ingest.rebuildReplayTask, ingest.backfillObserver]
    const pending: Array<Promise<unknown> | null | undefined> = [
      ingest.indexLock,
      ingest.drainTask,
      ingest.backfillFinalization,
      ingest.rebuildReplayTask,
      ingest.backfillObserver?.run.completion,
      whenEntityWritesSettle(store)
    ]
    await Promise.allSettled(pending.filter((p): p is Promise<unknown> => !!p))
    const after = [ingest.indexLock, ingest.drainTask, ingest.backfillFinalization, ingest.rebuildReplayTask, ingest.backfillObserver]
    if (before.every((ref, i) => ref === after[i])) return
  }
}

/**
 * Test-only: await every brain background task — ingest's queue drain, backfill finalization, rebuild
 * replay and entity/index writes (whenIngestWorkSettles), plus Intelligence's catch-up/recap run and its
 * own state-write completion (settleIntelligenceIndexForTests) — before a suite's cleanup deletes the
 * temp profile. Call this from every `src/main/brain/*.test.ts` suite's `afterEach`, before removing the
 * profile directory: deleting it while any of these are still writing races an in-flight tmp+rename and
 * fails an unrelated test with ENOTEMPTY on rmdir, in whichever suite happens to run next.
 *
 * Order matters: an Intelligence run's own ingest work must drain first so its completion (awaited by
 * settleIntelligenceIndexForTests) can actually resolve.
 */
export async function settleBrainWritesForTests(): Promise<void> {
  await whenIngestWorkSettles()
  await settleIntelligenceIndexForTests()
}
