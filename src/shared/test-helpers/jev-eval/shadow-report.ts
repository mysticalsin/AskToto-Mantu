import { z } from 'zod'
import { type JevDecider, runScenario } from './harness'
import { computeJevMetrics } from './metrics'
import {
  CapabilitySchema,
  ExpectSchema,
  LanguageSchema,
  MeetingTypeSchema,
  type Scenario,
  ScenarioIdSchema
} from './label-schema'

const Rate = z.number().nullable()
const MetricsCoreSchema = z.strictObject({
  scenarios: z.number(),
  falseInterruptions: z.number(),
  missedHelpful: z.number(),
  firstUsefulCardLatencyMs: z.strictObject({ p50: Rate, p95: Rate }),
  meetingMinutes: z.number(),
  classifierCallsPerMinute: Rate,
  generationCallsAvoided: z.number(),
  duplicateCardRate: Rate,
  staleDrops: z.number(),
  units: z.strictObject({ classifier: z.number(), generator: z.number() })
})
const MetricsSchema = MetricsCoreSchema.extend({
  byLanguage: z.partialRecord(LanguageSchema, MetricsCoreSchema),
  byMeetingType: z.partialRecord(MeetingTypeSchema, MetricsCoreSchema)
}).strict()

const RowSchema = z.strictObject({
  scenarioId: ScenarioIdSchema,
  verdict: z.enum(['pass', 'fail', 'not_run']),
  missing: z.array(CapabilitySchema),
  owners: z.array(z.string()),
  falseInterruptions: z.number(),
  missed: z.number(),
  expectFailures: z.array(ExpectSchema.keyof())
})

/** Allowlisted keys only: the report has no field that could carry transcript or card text. */
export const JevShadowReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  cohort: z.literal('synthetic'),
  realCohort: z.strictObject({
    status: z.literal('BLOCKED_EXTERNAL'),
    decision: z.literal('D-15'),
    unblock: z.string()
  }),
  deciders: z.array(z.strictObject({ name: z.string(), rows: z.array(RowSchema), metrics: MetricsSchema }))
})
export type JevShadowReport = z.infer<typeof JevShadowReportSchema>

export function buildShadowCohortReport(
  scenarios: readonly Scenario[],
  deciders: readonly JevDecider[]
): JevShadowReport {
  return {
    schemaVersion: 1,
    cohort: 'synthetic',
    realCohort: {
      status: 'BLOCKED_EXTERNAL',
      decision: 'D-15',
      unblock:
        'Owner chooses the classifier provider and approves opt-in consented evaluation meetings; cost in currency needs its pricing.'
    },
    deciders: deciders.map((decider) => {
      const results = scenarios.map((s) => runScenario(s, decider))
      return {
        name: decider.name,
        rows: results.map((r) => ({
          scenarioId: r.scenarioId,
          verdict: r.verdict,
          missing: r.missing,
          owners: r.owners,
          falseInterruptions: r.falseInterruptions,
          missed: r.missed,
          expectFailures: r.expectFailures
        })),
        metrics: computeJevMetrics(results)
      }
    })
  }
}
