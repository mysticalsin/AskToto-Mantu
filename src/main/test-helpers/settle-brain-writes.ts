import { whenIngestWorkSettles } from '../brain/ingest'
import { settleIntelligenceIndexForTests } from '../brain/intelligence-index'

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
