/**
 * strings.ts — the right-edge copy (M2-0202, spec v3 §6, §10), English and French. Every visible label and
 * accessible name of the right-edge surfaces comes from here, so the FR captures and the pseudo-locale fit
 * checks see the same strings the app ships.
 *
 * Invariant: every key exists in every locale (RightEdgeStrings is the English table's shape).
 */

export type RightEdgeLocale = 'en' | 'fr'

const EN = {
  readerLabel: 'Métis Reader',
  backToIsland: '← Island',
  backToIslandName: 'Back to the island',
  hide: 'Hide',
  hideName: 'Hide Métis',
  openReader: 'Open ↗',
  openReaderName: 'Open in the Reader',
  openTranscriptName: 'Open the live transcript',
  openDetails: 'Details ↗',
  openDetailsName: 'Open the details',
  jumpToLive: 'Jump to live',
  meetingTimer: 'Meeting time',
  consentDot: 'Recording',
  statusReady: 'Ready',
  statusThinking: 'Thinking',
  statusListening: 'Listening',
  statusPaused: 'Paused',
  statusAttention: 'Action waiting',
  statusAttentionName: 'Action waiting, show the details',
  titleAnswer: 'Answer',
  titleTranscript: 'Live transcript',
  titleHistory: 'History',
  titleReview: 'Meeting review',
  titleAgenda: 'Agenda',
  titleBrain: 'Intelligence',
  titleDetails: 'Details',
  transcriptEmpty: 'Nothing transcribed yet.',
  detailsEmpty: 'Nothing needs your attention.',
  detailsApproval: 'Pending action',
  detailsApprovalBody: 'A pending external action has no verified summary. It cannot be approved here.',
  detailsCancel: 'Cancel pending action',
  detailsCancelling: 'Cancelling…',
  detailsError: 'Error'
}

export type RightEdgeStrings = typeof EN

const FR: RightEdgeStrings = {
  readerLabel: 'Lecteur Métis',
  backToIsland: '← Îlot',
  backToIslandName: 'Revenir à l’îlot',
  hide: 'Masquer',
  hideName: 'Masquer Métis',
  openReader: 'Ouvrir ↗',
  openReaderName: 'Ouvrir dans le lecteur',
  openTranscriptName: 'Ouvrir la transcription en direct',
  openDetails: 'Détails ↗',
  openDetailsName: 'Ouvrir les détails',
  jumpToLive: 'Revenir au direct',
  meetingTimer: 'Durée de la réunion',
  consentDot: 'Enregistrement en cours',
  statusReady: 'Prêt',
  statusThinking: 'Réflexion',
  statusListening: 'Écoute',
  statusPaused: 'En pause',
  statusAttention: 'Action en attente',
  statusAttentionName: 'Action en attente, afficher les détails',
  titleAnswer: 'Réponse',
  titleTranscript: 'Transcription en direct',
  titleHistory: 'Historique',
  titleReview: 'Bilan de réunion',
  titleAgenda: 'Agenda',
  titleBrain: 'Intelligence',
  titleDetails: 'Détails',
  transcriptEmpty: 'Rien n’a encore été transcrit.',
  detailsEmpty: 'Rien ne demande votre attention.',
  detailsApproval: 'Action en attente',
  detailsApprovalBody: 'Une action externe en attente n’a pas de résumé vérifié. Elle ne peut pas être approuvée ici.',
  detailsCancel: 'Annuler l’action en attente',
  detailsCancelling: 'Annulation…',
  detailsError: 'Erreur'
}

export const RIGHT_EDGE_STRINGS: Record<RightEdgeLocale, RightEdgeStrings> = { en: EN, fr: FR }

/** The table for a BCP 47 tag: French for any `fr` tag, English otherwise. */
export function rightEdgeStrings(locale?: string | null): RightEdgeStrings {
  return /^fr\b/i.test(locale ?? '') ? FR : EN
}
