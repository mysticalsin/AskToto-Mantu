/**
 * How much live transcript the spoken suggest line carries. Main only ever reads the last 6 000 chars
 * (llm/shared.ts, mode 'suggest'), so the renderer sends a slightly larger tail instead of the whole
 * meeting: one structured-clone across IPC, one zod parse, and ~20 redaction regex passes per 8 s tick
 * used to scale with meeting length. Recap and summary still receive the full transcript.
 */
export const SUGGEST_TRANSCRIPT_TAIL_CHARS = 8000
