import type { WriteupSpan, WriteupSpanPayload } from '@shared/ipc'

/**
 * Post-meeting latency spans (M2-0430), measured from the Stop click: transcript saved, first recap token,
 * recap done. Content-free by construction — a span name and a millisecond count. Each span reports at
 * most once per Stop, and nothing reports before a Stop or after reset() (a new meeting).
 */
export class WriteupSpans {
  private stoppedAt: number | null = null
  private readonly reported = new Set<WriteupSpan>()

  constructor(
    private readonly report: (payload: WriteupSpanPayload) => void,
    private readonly now: () => number = () => Date.now()
  ) {}

  stop(): void {
    this.stoppedAt = this.now()
    this.reported.clear()
  }

  mark(span: WriteupSpan): void {
    if (this.stoppedAt === null || this.reported.has(span)) return
    this.reported.add(span)
    this.report({ span, ms: Math.max(0, Math.round(this.now() - this.stoppedAt)) })
  }

  reset(): void {
    this.stoppedAt = null
  }
}
