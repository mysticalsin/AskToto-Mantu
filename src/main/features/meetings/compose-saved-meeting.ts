import type { SaveMeeting, Settings } from '@shared/ipc'
import { refuseIfDemoTagged } from '@shared/demo-guard'
import { isSummaryOnlyProfile, resolveEnterpriseLiveProfile } from '@shared/enterprise-live-profile'
import { meetingDurationMinutes } from '@shared/meeting-duration'
import { recapStatusValidationError } from '@shared/recap-status'
import { parseRecapMarkdown } from '../../transcripts-recap'
import { buildMeetingSaveDocument } from './meeting-save-document'
import { renderMeetingTranscriptAsync } from './meeting-speech'
import { refuseReservedSpeechProse } from './speech-provenance'
import { speakerLabel } from './transcript-format'
import { cleanTitle } from './transcript-document-format'

/** Everything saveMeeting and rewriteSavedMeeting share: validate the payload, then build the document. */
export async function composeSavedMeeting(
  settings: Settings,
  m: SaveMeeting
): Promise<{ started: number; title: string; durMin: number; document: string }> {
  const statusError = recapStatusValidationError(m.recap, m.recapStatus)
  if (statusError) throw new Error(statusError)
  // MQA-278 — refuses Act 2 onboarding-demo-tagged data before touching disk. See @shared/demo-guard.
  refuseIfDemoTagged('saveMeeting', m.title, m.mode)

  // Guard against non-finite/out-of-range values (e.g. Infinity), not just falsy ones: Date's valid
  // range is +/-8.64e15ms from epoch, and anything outside it throws RangeError from toISOString()
  // below with no surrounding try/catch, losing the whole meeting.
  const started =
    m.startedAt && Number.isFinite(m.startedAt) && Math.abs(m.startedAt) <= 8.64e15 ? m.startedAt : Date.now()
  const heuristicTitle = cleanTitle(m.title) || `${m.mode} meeting`

  // Main is the single source of truth for the final title: when a recap was generated, prefer its
  // "## Title" (2-4 real words naming the topic) over the renderer's "first sentence of theirs" heuristic.
  // Falls back to the renderer-provided title when there's no recap yet, or the model left Title empty.
  const recapParsed = m.recap ? parseRecapMarkdown(m.recap) : null
  const title = cleanTitle(recapParsed?.title24 || '') || heuristicTitle
  const tags = recapParsed?.tags || []
  refuseReservedSpeechProse(title, m.mode, ...tags)

  const durMin = meetingDurationMinutes(m)
  const participants = Array.from(new Set(m.lines.map((l) => speakerLabel(l.speaker))))

  // Enterprise-live SUMMARY_ONLY: omit fresh Full transcript section. Never rewrite/delete older files.
  const summaryOnly = isSummaryOnlyProfile(resolveEnterpriseLiveProfile(settings.enterpriseLive ?? settings))
  const transcript = summaryOnly ? '' : await renderMeetingTranscriptAsync(m.lines)

  const document = buildMeetingSaveDocument({
    meeting: m,
    title,
    mode: cleanTitle(m.mode),
    started,
    durationMin: durMin,
    participants,
    tags,
    summaryOnly,
    transcript
  })
  return { started, title, durMin, document }
}
