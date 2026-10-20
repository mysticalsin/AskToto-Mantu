import { fnv1a } from '@shared/hash'

/** Session memory of Review's CRM and "Book next steps" pushes; module scope so it outlives Review. */
/** The exact payload "Push to CRM" sends — deliberately thin (see the note on the push panel below). */
export type CrmPayload = { title: string; date: string; summary: string }
export type CrmPushPhase = 'idle' | 'sending' | 'sent' | 'error'

// Session memory of the CRM pushes that already landed. `pushState` below is plain component state:
// leaving for History unmounts Review entirely, and re-opening a meeting resets it, so on its own an
// already-pushed meeting re-arms "Push to CRM" and a second Confirm push files a byte-identical duplicate
// record. Keyed on the payload rather than the meeting file because the payload is what the CRM actually
// receives — and because savedPath is still null while a live meeting's autosave is retrying, so a file
// key would miss a push made in that window. Module scope, not a ref: it has to outlive the component.
const pushedCrmPayloads = new Set<string>()

/**
 * MQA-092 — the payload's fingerprint, and the single identity both memories agree on: this in-session
 * Set and the durable `crm_pushed` frontmatter marker main writes (recall.ts's setMeetingCrmPushed).
 * A hash rather than the payload itself because it has to survive into a YAML scalar; base-36 FNV-1a
 * because it already exists in shared/hash.ts and this is dedupe, not security. An edited recap hashes
 * differently and correctly re-arms the chip — that is a different record, not a duplicate.
 */
export function crmPushKey(p: CrmPayload): string {
  return fnv1a(JSON.stringify([p.title, p.date, p.summary])).toString(36)
}

/** Remember a push the CRM accepted, so re-opening this meeting doesn't offer to send it again. */
export function markCrmPushed(p: CrmPayload): void {
  pushedCrmPayloads.add(crmPushKey(p))
}

/** Seed the session memory from a meeting's durable marker, so a push made before the last relaunch is
 *  still known. Takes the raw fingerprint (not a payload) because that is what the frontmatter holds. */
export function seedCrmPushed(key: string | undefined): void {
  if (key) pushedCrmPayloads.add(key)
}

/** Whether THIS payload already reached the CRM — drives both the "Pushed to Polo Pre-Sales." line and
 *  the hiding of the "Push to CRM" chip, so neither depends on Review still being mounted. A changed
 *  recap is a different payload and re-arms the chip, which is correct: it is no longer the same record. */
export function crmPushDone(phase: CrmPushPhase, p: CrmPayload): boolean {
  return phase === 'sent' || pushedCrmPayloads.has(crmPushKey(p))
}

// ── "Book next steps" — push recap action items to a connected task manager (Plane today) ──────────────
// One MCP task per (action item × connection) — see the design note on NextStepArgs below for the exact
// wire shape. Per-card push status; a card that already succeeded this session is remembered the same
// way pushedCrmPayloads remembers a CRM push, so leaving Review and coming back never re-arms it.
export type NextStepPhase = 'idle' | 'sending' | 'sent' | 'error'
/** The exact args a single "Book next steps" push sends. `containerId` (when the user filled in a target,
 *  e.g. a Plane project id) rides in as `project_id` — the one container-scoping key name the design this
 *  feature was built against calls out as known (unlike the due-date argument name, which is NOT sent
 *  structured — see dueDateText's own doc comment in shared/ipc.ts). */
export type NextStepArgs = { title: string; description: string; project_id?: string }
const pushedNextSteps = new Set<string>()
const nextStepKey = (connectionId: string, args: NextStepArgs): string =>
  JSON.stringify([connectionId, args.title, args.description, args.project_id ?? ''])

/** Remember a next-step push that succeeded, so re-opening this meeting doesn't re-offer it. */
export function markNextStepPushed(connectionId: string, args: NextStepArgs): void {
  pushedNextSteps.add(nextStepKey(connectionId, args))
}

/** Whether THIS (connectionId, args) pair already landed — mirrors crmPushDone above. */
export function nextStepPushed(phase: NextStepPhase, connectionId: string, args: NextStepArgs): boolean {
  return phase === 'sent' || pushedNextSteps.has(nextStepKey(connectionId, args))
}
