import { DEFAULT_SETTINGS } from '../../ipc'
import type { QuietPolicy } from '../../quiet-mode-settings'
import jev01 from '../../__fixtures__/jev/JEV-01.json'
import jev02 from '../../__fixtures__/jev/JEV-02.json'
import jev03 from '../../__fixtures__/jev/JEV-03.json'
import jev04 from '../../__fixtures__/jev/JEV-04.json'
import jev05 from '../../__fixtures__/jev/JEV-05.json'
import jev06 from '../../__fixtures__/jev/JEV-06.json'
import jev07 from '../../__fixtures__/jev/JEV-07.json'
import jev08 from '../../__fixtures__/jev/JEV-08.json'
import jev09 from '../../__fixtures__/jev/JEV-09.json'
import jev10 from '../../__fixtures__/jev/JEV-10.json'
import jev11 from '../../__fixtures__/jev/JEV-11.json'
import jev12 from '../../__fixtures__/jev/JEV-12.json'
import {
  CAPABILITY_OWNERS,
  type Capability,
  type DecisionRecord,
  type Expect,
  type Language,
  type MeetingType,
  type Scenario,
  ScenarioSchema,
  type ScenarioId,
  type Step
} from './label-schema'

/**
 * Offline JEV evaluation harness: feeds a scenario's steps to a decider on an injected clock and scores
 * the decisions against the scenario's labels. No network, no timers, no randomness, no console output;
 * decision records hold ids, a content hash and counters, never utterance or card text.
 */

export interface JevContext {
  nowMs: number
  quiet: QuietPolicy
  settings: { autoSuggest: boolean; suggestEverySec: number; providerReady: boolean }
}

export type DeciderOutput = Omit<DecisionRecord, 'scenarioId' | 'stepIndex' | 'classifierCalls' | 'generationCalls'> & {
  classifierCalls?: number
  generationCalls?: number
}

export interface JevDecider {
  name: string
  capabilities: ReadonlySet<Capability>
  reset(ctx: JevContext): void
  onStep(step: Step, ctx: JevContext): DeciderOutput[]
}

export type Verdict = 'pass' | 'fail' | 'not_run'
export type ExpectKey = keyof Expect

export interface ScenarioResult {
  scenarioId: ScenarioId
  deciderName: string
  language: Language
  meetingType: MeetingType
  verdict: Verdict
  missing: Capability[]
  owners: string[]
  records: DecisionRecord[]
  durationMs: number
  falseInterruptions: number
  missed: number
  firstUsefulLatenciesMs: number[]
  expectFailures: ExpectKey[]
}

export interface RunOptions {
  quiet?: QuietPolicy
  settings?: Partial<JevContext['settings']>
}

const ALLOW_ALL: QuietPolicy = {
  toast: 'allow',
  sound: 'allow',
  spokenReply: 'allow',
  proactiveSuggestion: 'allow',
  autoAnswerCard: 'allow'
}

/** Outcomes that put a card in front of the user. */
export const CARD_OUTCOMES: ReadonlySet<string> = new Set(['generate', 'adopt-speculative', 'replace-card'])

export function loadScenarios(): Scenario[] {
  return [jev01, jev02, jev03, jev04, jev05, jev06, jev07, jev08, jev09, jev10, jev11, jev12].map((raw) =>
    ScenarioSchema.parse(raw)
  )
}

export function runScenario(scenario: Scenario, decider: JevDecider, opts: RunOptions = {}): ScenarioResult {
  const base = {
    scenarioId: scenario.id,
    deciderName: decider.name,
    language: scenario.language,
    meetingType: scenario.meetingType
  }
  const missing = scenario.requires.filter((c) => !decider.capabilities.has(c))
  if (missing.length > 0) {
    return {
      ...base,
      verdict: 'not_run',
      missing,
      owners: missing.map((c) => CAPABILITY_OWNERS[c]),
      records: [],
      durationMs: 0,
      falseInterruptions: 0,
      missed: 0,
      firstUsefulLatenciesMs: [],
      expectFailures: []
    }
  }

  const settings = {
    autoSuggest: true,
    suggestEverySec: DEFAULT_SETTINGS.suggestEverySec,
    providerReady: true,
    ...opts.settings
  }
  const quiet = opts.quiet ?? ALLOW_ALL
  let clock = 0
  decider.reset({ nowMs: clock, quiet, settings })

  const records: DecisionRecord[] = []
  const stepTimes: number[] = []
  scenario.steps.forEach((step, stepIndex) => {
    if (step.kind === 'pause') clock += step.ms
    else if ('tMs' in step) clock = Math.max(clock, step.tMs)
    stepTimes.push(clock)
    for (const out of decider.onStep(step, { nowMs: clock, quiet, settings })) {
      records.push({
        ...out,
        scenarioId: scenario.id,
        stepIndex,
        classifierCalls: out.classifierCalls ?? 0,
        generationCalls: out.generationCalls ?? 0
      })
    }
  })

  // Score each label over its window: from its own step up to (not including) the next label's step.
  const labels = [...scenario.labels].sort((a, b) => a.at - b.at)
  let falseInterruptions = 0
  let missed = 0
  const firstUsefulLatenciesMs: number[] = []
  labels.forEach((label, i) => {
    const end = labels[i + 1]?.at ?? scenario.steps.length
    const cards = records.filter((r) => r.stepIndex >= label.at && r.stepIndex < end && CARD_OUTCOMES.has(r.outcome))
    if (!label.warranted) falseInterruptions += cards.length
    else if (cards.length === 0) {
      // A quiet-gated card is neither a hit nor a miss.
      const quiet = records.some(
        (r) => r.stepIndex >= label.at && r.stepIndex < end && r.outcome === 'suppressed-quiet'
      )
      if (!quiet) missed += 1
    } else if (label.useful) {
      const first = cards[0]
      firstUsefulLatenciesMs.push(first.latencyMs ?? stepTimes[first.stepIndex] - stepTimes[label.at])
    }
  })

  const expectFailures = checkExpect(scenario, records)
  const clean = falseInterruptions === 0 && missed === 0 && expectFailures.length === 0
  return {
    ...base,
    verdict: clean ? 'pass' : 'fail',
    missing: [],
    owners: [],
    records,
    durationMs: clock,
    falseInterruptions,
    missed,
    firstUsefulLatenciesMs,
    expectFailures
  }
}

function checkExpect(scenario: Scenario, records: DecisionRecord[]): ExpectKey[] {
  const { expect } = scenario
  const failures: ExpectKey[] = []
  if (expect.maxCards !== undefined && records.filter((r) => CARD_OUTCOMES.has(r.outcome)).length > expect.maxCards)
    failures.push('maxCards')
  if (expect.mustStaleDrop) {
    const dropped = new Set(records.filter((r) => r.outcome === 'stale-drop').map((r) => r.utteranceId))
    if (!expect.mustStaleDrop.every((id) => dropped.has(id))) failures.push('mustStaleDrop')
  }
  if (expect.finalCardKey !== undefined) {
    let current: string | undefined
    for (const r of records) if (CARD_OUTCOMES.has(r.outcome) && r.cardKey) current = r.cardKey
    if (current !== expect.finalCardKey) failures.push('finalCardKey')
  }
  if (expect.noActionWithoutContract) {
    const refused = new Set(records.filter((r) => r.outcome === 'refuse-action').map((r) => r.stepIndex))
    const unrefused = scenario.steps.some((s, i) => s.kind === 'action' && !refused.has(i))
    if (unrefused) failures.push('noActionWithoutContract')
  }
  if (expect.maxClassifierCalls !== undefined) {
    const calls = records.reduce((n, r) => n + r.classifierCalls, 0)
    if (calls > expect.maxClassifierCalls) failures.push('maxClassifierCalls')
  }
  return failures
}
