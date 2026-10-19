import type { CaptureHealth } from './listen-capture-state'

export type ListenSpeaker = 'them' | 'you'

export interface ListenMicCapture {
  stream: MediaStream
  track: MediaStreamTrack
  health: CaptureHealth
  release?: () => void | Promise<void>
}

export interface ListenAudioChannel {
  admissionEpoch: number
  ctx: AudioContext
  src: MediaStreamAudioSourceNode
  worklet: AudioWorkletNode
  stream: MediaStream
  gain?: GainNode
  limiter?: DynamicsCompressorNode
  brokerSpeech?: boolean
  micCapture?: ListenMicCapture
}

export interface ListenAudioChannelsHost {
  isAdmissionOpen(epoch: number): boolean
  isLive(): boolean
  isStopping(): boolean
  isPaused(): boolean
  isBrokerCapture(): boolean
  currentEpoch(): number
  startedAt(): number | undefined
  updateCaptureTrack(epoch: number, speaker: ListenSpeaker, captured: boolean): boolean
  publishMicCapture(epoch: number, mic: ListenMicCapture): void
  armNoSpeechWarning(epoch: number): void
  clearNoSpeechWarning(): void
  clearThemProbation(): void
  onThemChannelOpened(): void
  themHeard(): boolean
  themWatchdogDelay(): number
  onThemWatchdogExpired(): void
  onFlushAck(speaker: ListenSpeaker, requestId: string): void
  onAudio(speaker: ListenSpeaker, audio: Float32Array, partial: boolean, startedAt: number | undefined): void
  onThemWindow(): void
  onUnexpectedTrackEnd(speaker: ListenSpeaker, track: MediaStreamTrack, channel: ListenAudioChannel): void
  onContextState(speaker: ListenSpeaker, channel: ListenAudioChannel): void
  whisperWorkletUrl(): string
  cloudWorkletUrl(): string
}

export interface ListenAudioChannels {
  current: Partial<Record<ListenSpeaker, ListenAudioChannel>>
  open(speaker: ListenSpeaker, stream: MediaStream, epoch: number, micCapture?: ListenMicCapture): Promise<boolean>
  close(
    speaker: ListenSpeaker,
    expected?: ListenAudioChannel,
    options?: { retainStream?: boolean; retainCaptureState?: boolean }
  ): void
  armThemWatchdog(): void
  clearThemWatchdog(): void
}

interface PendingAudioOpen {
  admissionEpoch: number
  stream: MediaStream
  micCapture?: ListenMicCapture
  ctx?: AudioContext
  src?: MediaStreamAudioSourceNode
  worklet?: AudioWorkletNode
  gain?: GainNode | null
  limiter?: DynamicsCompressorNode | null
  cancelled: boolean
  released: boolean
  cancelledWait: Promise<void>
  cancelWait(): void
}

/** Owns one Web Audio channel per speaker and serializes replacement opens for that speaker. */
export function createListenAudioChannels(
  host: () => ListenAudioChannelsHost,
  current: ListenAudioChannels['current'] = {}
): ListenAudioChannels {
  const openSequence: Partial<Record<ListenSpeaker, Promise<unknown>>> = {}
  const pendingOpen: Partial<Record<ListenSpeaker, Set<PendingAudioOpen>>> = {}
  let themWatchdog: ReturnType<typeof setTimeout> | null = null

  const rememberPending = (speaker: ListenSpeaker, pending: PendingAudioOpen): void => {
    const entries = pendingOpen[speaker] ?? new Set<PendingAudioOpen>()
    entries.add(pending)
    pendingOpen[speaker] = entries
  }

  const forgetPending = (speaker: ListenSpeaker, pending: PendingAudioOpen): void => {
    const entries = pendingOpen[speaker]
    entries?.delete(pending)
    if (entries?.size === 0) delete pendingOpen[speaker]
  }

  const releasePending = (speaker: ListenSpeaker, pending: PendingAudioOpen, notifyCancellation = true): void => {
    pending.cancelled = true
    if (notifyCancellation) pending.cancelWait()
    forgetPending(speaker, pending)
    if (pending.released) return
    pending.released = true
    const tracks = pending.stream.getTracks()
    tracks.forEach((track) => (track.onended = null))
    if (pending.micCapture?.release) void pending.micCapture.release()
    else tracks.forEach((track) => track.stop())
    try {
      pending.worklet?.port.close()
      pending.worklet?.disconnect()
    } catch {
      /* continue releasing the remaining nodes */
    }
    try {
      pending.limiter?.disconnect()
      pending.gain?.disconnect()
      pending.src?.disconnect()
    } catch {
      /* continue closing the context */
    }
    if (pending.ctx) {
      pending.ctx.onstatechange = null
      void pending.ctx.close().catch(() => {})
    }
  }

  const clearThemWatchdog = (): void => {
    if (themWatchdog) clearTimeout(themWatchdog)
    themWatchdog = null
  }

  const armThemWatchdog = (): void => {
    clearThemWatchdog()
    const deps = host()
    if (deps.themHeard()) return
    const epoch = deps.currentEpoch()
    themWatchdog = setTimeout(() => {
      themWatchdog = null
      const latest = host()
      if (latest.isAdmissionOpen(epoch) && !latest.isPaused() && current.them) latest.onThemWatchdogExpired()
    }, deps.themWatchdogDelay())
  }

  const close = (
    speaker: ListenSpeaker,
    expected?: ListenAudioChannel,
    options: { retainStream?: boolean; retainCaptureState?: boolean } = {},
    cancelPending = true
  ): void => {
    const channel = current[speaker]
    if (expected && channel !== expected) return
    if (cancelPending) {
      for (const pending of pendingOpen[speaker] ?? []) releasePending(speaker, pending)
      openSequence[speaker] = Promise.resolve()
    }
    if (!channel) return
    delete current[speaker]
    if (speaker === 'them') {
      clearThemWatchdog()
      try {
        host().clearThemProbation()
      } catch {
        /* continue releasing channel resources */
      }
    }
    if (speaker === 'you') {
      try {
        host().clearNoSpeechWarning()
      } catch {
        /* continue releasing channel resources */
      }
    }
    if (!options.retainStream) channel.stream.getTracks().forEach((track) => (track.onended = null))
    try {
      channel.worklet.port.onmessage = null
      channel.worklet.port.close()
      channel.worklet.disconnect()
    } catch {
      /* continue disconnecting the remaining nodes */
    }
    try {
      channel.gain?.disconnect()
      channel.limiter?.disconnect()
      channel.src.disconnect()
    } catch {
      /* continue releasing stream and context */
    }
    if (!options.retainStream) {
      if (channel.micCapture?.release) void channel.micCapture.release()
      else channel.stream.getTracks().forEach((track) => track.stop())
    }
    void channel.ctx.close().catch(() => {})
    if (!options.retainCaptureState) {
      try {
        host().updateCaptureTrack(channel.admissionEpoch, speaker, false)
      } catch {
        /* resource ownership has still been released */
      }
    }
  }

  const openNow = async (
    speaker: ListenSpeaker,
    pending: PendingAudioOpen,
    micCapture?: ListenMicCapture
  ): Promise<boolean> => {
    const { stream, admissionEpoch } = pending
    let deps = host()
    if (pending.cancelled || !deps.isAdmissionOpen(admissionEpoch)) {
      releasePending(speaker, pending)
      return false
    }
    const channelStartedAt = deps.startedAt()
    const brokerCapture = deps.isBrokerCapture()
    close(speaker, undefined, {}, false)
    let ctx: AudioContext | undefined
    let src: MediaStreamAudioSourceNode | undefined
    let worklet: AudioWorkletNode | undefined
    let gain: GainNode | null = null
    let limiter: DynamicsCompressorNode | null = null
    let channel: ListenAudioChannel | undefined
    try {
      ctx = new AudioContext({ sampleRate: 16000 })
      const context = ctx
      pending.ctx = context
      src = context.createMediaStreamSource(stream)
      pending.src = src
      const source = src
      if (brokerCapture) await ctx.suspend()
      await context.audioWorklet.addModule(brokerCapture ? deps.cloudWorkletUrl() : deps.whisperWorkletUrl())
      deps = host()
      if (pending.cancelled || !pendingOpen[speaker]?.has(pending) || !deps.isAdmissionOpen(admissionEpoch)) {
        releasePending(speaker, pending)
        return false
      }
      const processor = new AudioWorkletNode(context, brokerCapture ? 'cloud-capture-worklet' : 'whisper-worklet', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { sourceSampleRate: context.sampleRate }
      })
      worklet = processor
      pending.worklet = processor
      gain = speaker === 'them' ? context.createGain() : null
      pending.gain = gain
      if (gain) gain.gain.value = 3.0
      limiter = gain ? context.createDynamicsCompressor() : null
      pending.limiter = limiter
      if (limiter) {
        limiter.threshold.value = -6
        limiter.knee.value = 6
        limiter.ratio.value = 20
        limiter.attack.value = 0.001
        limiter.release.value = 0.1
      }

      if (!brokerCapture) {
        processor.port.onmessage = (event: MessageEvent): void => {
          if (admissionEpoch !== host().currentEpoch()) return
          const data = event.data as {
            type?: string
            requestId?: string
            audio?: Float32Array
            sampleRate?: number
            partial?: boolean
          }
          if (data.type === 'flush-ack' && typeof data.requestId === 'string') {
            host().onFlushAck(speaker, data.requestId)
            return
          }
          if (!data.audio || data.sampleRate !== 16000) return
          if (speaker === 'them') {
            clearThemWatchdog()
            host().onThemWindow()
          }
          host().onAudio(speaker, data.audio, !!data.partial, channelStartedAt)
        }
      }

      channel = {
        admissionEpoch,
        ctx: context,
        src: source,
        worklet: processor,
        stream,
        gain: gain ?? undefined,
        limiter: limiter ?? undefined,
        brokerSpeech: brokerCapture,
        micCapture
      }
      forgetPending(speaker, pending)
      current[speaker] = channel
      if (!host().updateCaptureTrack(admissionEpoch, speaker, true)) {
        close(speaker, channel)
        return false
      }
      if (speaker === 'you' && micCapture) {
        host().publishMicCapture(admissionEpoch, micCapture)
        if (!brokerCapture) host().armNoSpeechWarning(admissionEpoch)
      }
      if (gain && limiter) {
        source.connect(gain)
        gain.connect(limiter)
        limiter.connect(processor)
      } else {
        source.connect(processor)
      }
      processor.connect(context.destination)
      if (host().isPaused()) void context.suspend().catch(() => {})

      stream.getAudioTracks().forEach((track) => {
        track.onended = (): void => {
          const latest = host()
          if (!latest.isLive() || latest.isStopping() || current[speaker] !== channel) return
          latest.onUnexpectedTrackEnd(speaker, track, channel!)
        }
      })
      context.onstatechange = (): void => {
        const latest = host()
        if (
          latest.isLive() &&
          !latest.isStopping() &&
          !latest.isPaused() &&
          !channel!.brokerSpeech &&
          current[speaker] === channel &&
          context.state === 'suspended'
        )
          latest.onContextState(speaker, channel!)
      }
      if (speaker === 'them' && !brokerCapture) {
        host().onThemChannelOpened()
        armThemWatchdog()
      }
      return true
    } catch (error) {
      const cancelled = pending.cancelled
      if (channel && current[speaker] === channel) {
        close(speaker, channel)
      } else {
        // Error cleanup must preserve run's rejection rather than win the outer cancellation race.
        releasePending(speaker, pending, false)
      }
      if (cancelled) return false
      throw error
    }
  }

  const open = (
    speaker: ListenSpeaker,
    stream: MediaStream,
    epoch: number,
    micCapture?: ListenMicCapture
  ): Promise<boolean> => {
    const previous = openSequence[speaker] ?? Promise.resolve()
    let cancelWait!: () => void
    const cancelledWait = new Promise<void>((resolve) => (cancelWait = resolve))
    const pending: PendingAudioOpen = {
      admissionEpoch: epoch,
      stream,
      micCapture,
      cancelled: false,
      released: false,
      cancelledWait,
      cancelWait
    }
    rememberPending(speaker, pending)
    const run = previous.catch(() => {}).then(() => (pending.cancelled ? false : openNow(speaker, pending, micCapture)))
    openSequence[speaker] = run.catch(() => {})
    return Promise.race([run, cancelledWait.then(() => false)])
  }

  return { current, open, close, armThemWatchdog, clearThemWatchdog }
}

/** Soft audible chime generated in-browser (no asset file). */
export function playListenChime(): void {
  try {
    const AudioCtx =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioCtx) return
    const ctx = new AudioCtx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(523.25, ctx.currentTime) // C5
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.08)
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.28)
    setTimeout(() => void ctx.close(), 350)
  } catch {
    /* ignore */
  }
}
