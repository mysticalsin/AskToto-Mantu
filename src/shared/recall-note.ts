/** Optional fields used by the explicit reader; title and mode are also returned for meeting reads. */
export interface RecallNoteReadFields {
  kind?: 'note'
  title?: string
  mode?: string
  question?: string
  answer?: string
}
