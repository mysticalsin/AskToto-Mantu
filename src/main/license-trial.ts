/**
 * license-trial.ts — pure logic for Métis's LOCAL, unsigned trial fallback (Act 5 of the onboarding
 * rebuild, MQA-281). Distinct from the Ed25519 SIGNED lease (license-lease-verify.ts): a trial has no
 * server involved at all — it's a plain per-install timestamp that lets someone who has never activated
 * a license (and may never get one — this product has no price, no checkout, keys are only ever handed
 * out) keep using Métis for a bounded window before `checkLicenseGrace()` (license.ts) would otherwise
 * block them with `reason: 'not_activated'`.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: the trial clock starts on the first QUALIFYING USE — a real
 * suggestion/summary/recap actually delivered to the user — never on install, never on first launch, and
 * never from Act 2's onboarding demo (which is a scripted fake meeting, structurally incapable of
 * reaching the real ask pipeline this hooks into — see onboarding-demo.ts's own header and its
 * IPC-free contract test). Starting the clock at install would burn trial days nobody actually got value
 * from (a user who downloads, gets distracted, and opens Métis for real a week later would already have
 * lost a week of a 14-day trial to nothing); starting it on qualifying use means every trial day was a
 * day the product actually worked for someone.
 *
 * TRIAL_DAYS mirrors the license server's own `DEFAULT_TRIAL_DAYS` (license-server/lib/app.mjs) — the
 * two numbers describe the same product decision (an admin-minted trial KEY and this client-local trial
 * FALLBACK both give a new user two weeks), not a technical dependency between the files.
 */
import type { AskMode } from '@shared/ipc'

export const TRIAL_DAYS = 14
export const TRIAL_MS = TRIAL_DAYS * 24 * 60 * 60 * 1000

/** Which ask outcomes count as "the user got real value out of Métis" for trial-start purposes. A plain
 *  typed `answer` is excluded on purpose — Act 5's brief calls out "first real suggestion/summary"
 *  specifically (the live copilot chip and the meeting recap/summary are the moments this product is
 *  actually FOR), and `recap` is the same "summary" moment under its other name (a saved meeting's
 *  writeup). `vision` is excluded too: a single screen-context answer is not the core loop. */
export function isQualifyingTrialMode(mode: AskMode | string): boolean {
  return mode === 'suggest' || mode === 'summary' || mode === 'recap'
}

export type TrialState = 'none' | 'active' | 'expired'

export interface TrialStatus {
  state: TrialState
  /** Whole days left, floor-rounded, clamped to [0, TRIAL_DAYS]. 0 whenever state !== 'active'. */
  daysRemaining: number
}

/** Pure derivation of where a trial stands right now, given only its start timestamp (or null/never
 *  started). No settings access, no clock mutation — `now` is an explicit parameter so this is
 *  deterministic in tests. */
export function trialStatus(trialStartedAt: number | null, now: number = Date.now()): TrialStatus {
  if (trialStartedAt == null || !Number.isFinite(trialStartedAt)) return { state: 'none', daysRemaining: 0 }
  const elapsed = now - trialStartedAt
  // A trial start stamped in the future (clock rolled back after it was set, or a corrupt value) is not
  // trusted to extend anything — treated the same as "not started yet" rather than granting extra days.
  if (elapsed < 0) return { state: 'none', daysRemaining: 0 }
  if (elapsed >= TRIAL_MS) return { state: 'expired', daysRemaining: 0 }
  const daysRemaining = Math.max(0, Math.min(TRIAL_DAYS, Math.ceil((TRIAL_MS - elapsed) / (24 * 60 * 60 * 1000))))
  return { state: 'active', daysRemaining }
}

/** Should THIS qualifying ask start the trial clock? Pure and idempotent by construction: once
 *  `trialStartedAt` is non-null it can never restart or extend — a trial is "first qualifying use",
 *  singular, not "most recent qualifying use". */
export function shouldStartTrial(params: { trialStartedAt: number | null; mode: AskMode | string }): boolean {
  if (params.trialStartedAt != null) return false
  return isQualifyingTrialMode(params.mode)
}
