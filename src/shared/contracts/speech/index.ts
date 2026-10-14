import { z } from 'zod'
import { SpeechEngineIdSchema } from '../capability'

/**
 * Speech contract (TASK-005, M2-0064): what a capture asked for and what each recognized segment belongs to.
 *
 * Three counters order everything a speech engine emits, and each starts at 1:
 * - the capture generation increments every time capture starts, so a result from an earlier capture is stale;
 * - the stream epoch increments every time a track's stream to the engine is opened within one generation, so
 *   a late result from a closed stream (for example before a reconnect) is stale;
 * - the segment revision increments every time the engine re-recognizes a segment, and the highest one wins.
 *   A final segment is never revised again.
 *
 * Objects are strict: an unexpected key is a contract drift and fails loudly.
 */

/** The audio tracks a capture can request: the user's microphone and the meeting's system audio. */
export const TrackSchema = z.enum(['microphone', 'system'])
export type Track = z.infer<typeof TrackSchema>

const CounterSchema = z.number().int().positive()

export const CaptureGenerationSchema = CounterSchema
export const StreamEpochSchema = CounterSchema
export const SegmentRevisionSchema = CounterSchema

function addIssue(context: z.RefinementCtx, message: string, path: Array<string | number>): void {
  context.addIssue({ code: z.ZodIssueCode.custom, message, path })
}

/** Milliseconds from the start of the capture generation. */
const OffsetSchema = z.number().int().nonnegative()

/**
 * One capture generation. `capturedTracks` are the requested tracks that are actually being captured; a
 * requested track that is missing (for example when system audio permission is denied) is reported, not
 * replaced by another track.
 */
export const CaptureSchema = z
  .object({
    generation: CaptureGenerationSchema,
    engine: SpeechEngineIdSchema,
    requestedTracks: z.array(TrackSchema).min(1),
    capturedTracks: z.array(TrackSchema)
  })
  .strict()
  .superRefine((capture, context) => {
    capture.requestedTracks.forEach((track, index) => {
      if (capture.requestedTracks.indexOf(track) !== index) {
        addIssue(context, `${track} is requested twice.`, ['requestedTracks', index])
      }
    })
    capture.capturedTracks.forEach((track, index) => {
      if (capture.capturedTracks.indexOf(track) !== index) {
        addIssue(context, `${track} is captured twice.`, ['capturedTracks', index])
      } else if (!capture.requestedTracks.includes(track)) {
        addIssue(context, `${track} is captured but was not requested.`, ['capturedTracks', index])
      }
    })
  })
export type Capture = z.infer<typeof CaptureSchema>

/** The engine stream one track of one capture generation is recognized through. */
export const SpeechStreamRefSchema = z
  .object({ generation: CaptureGenerationSchema, track: TrackSchema, epoch: StreamEpochSchema })
  .strict()
export type SpeechStreamRef = z.infer<typeof SpeechStreamRefSchema>

/** One revision of a recognized segment. A segment is identified by its stream and its `index` in that stream. */
export const SpeechSegmentSchema = z
  .object({
    stream: SpeechStreamRefSchema,
    engine: SpeechEngineIdSchema,
    index: CounterSchema,
    revision: SegmentRevisionSchema,
    final: z.boolean(),
    text: z.string(),
    startMs: OffsetSchema,
    endMs: OffsetSchema
  })
  .strict()
  .superRefine((segment, context) => {
    if (segment.endMs < segment.startMs) {
      addIssue(context, 'A segment ends at or after its start.', ['endMs'])
    }
  })
export type SpeechSegment = z.infer<typeof SpeechSegmentSchema>
