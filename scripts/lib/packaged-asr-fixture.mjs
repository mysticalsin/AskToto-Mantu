// M2-0445: the packaged-ASR gate's fixture checks and its content-free failure report. Pure functions over
// bytes and plain records, so the gate's Windows-only script and its tests share one implementation.

/** The fixture phrase spoken at SAPI's default rate lasts about 3 s; under this it was cut short. */
export const MIN_FIXTURE_DURATION_MS = 1_500
/** Full-scale RMS of real synthesized speech is around 0.1; under this (about -46 dBFS) it is silence. */
export const MIN_FIXTURE_RMS = 0.005

/** A RIFF/WAVE file's format, the bytes its data chunk declares and holds, duration and RMS energy.
 *  Throws on anything that is not a PCM (8/16-bit integer) or 32-bit float WAVE file. */
export function inspectWav(bytes) {
  const buf = Buffer.from(bytes)
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  let format
  let data
  for (let at = 12; at + 8 <= buf.length; ) {
    const id = buf.toString('ascii', at, at + 4)
    const size = buf.readUInt32LE(at + 4)
    const body = at + 8
    if (id === 'fmt ' && body + 16 <= buf.length) {
      format = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14)
      }
    } else if (id === 'data') {
      data = { declaredBytes: size, bytes: buf.subarray(body, Math.min(buf.length, body + size)) }
      break
    }
    at = body + size + (size % 2)
  }
  if (!format) throw new Error('no fmt chunk')
  if (!data) throw new Error('no data chunk')
  const { audioFormat, channels, sampleRate, bitsPerSample } = format
  const sampleBytes = bitsPerSample / 8
  const read =
    audioFormat === 1 && bitsPerSample === 16 ? (at) => data.bytes.readInt16LE(at) / 32768
      : audioFormat === 1 && bitsPerSample === 8 ? (at) => (data.bytes.readUInt8(at) - 128) / 128
        : audioFormat === 3 && bitsPerSample === 32 ? (at) => data.bytes.readFloatLE(at)
          : null
  if (!read || channels < 1 || sampleRate < 1) {
    throw new Error(`unsupported WAVE format ${audioFormat}/${bitsPerSample}-bit/${channels}ch/${sampleRate}Hz`)
  }
  const samples = Math.floor(data.bytes.length / sampleBytes)
  let energy = 0
  for (let i = 0; i < samples; i += 1) energy += read(i * sampleBytes) ** 2
  return {
    fileBytes: buf.length,
    sampleRate,
    channels,
    bitsPerSample,
    dataBytes: data.bytes.length,
    declaredDataBytes: data.declaredBytes,
    durationMs: Math.round((samples / channels / sampleRate) * 1000),
    rms: samples ? Math.sqrt(energy / samples) : 0
  }
}

/** Why a synthesized fixture cannot prove a decode (truncated, too short, or silent), or null. */
export function fixtureProblem(bytes) {
  let info
  try {
    info = inspectWav(bytes)
  } catch (error) {
    return `unreadable WAV: ${error instanceof Error ? error.message : String(error)}`
  }
  if (info.dataBytes < info.declaredDataBytes) return `truncated: ${info.dataBytes} of ${info.declaredDataBytes} data bytes`
  if (info.durationMs < MIN_FIXTURE_DURATION_MS) return `too short: ${info.durationMs} ms < ${MIN_FIXTURE_DURATION_MS} ms`
  if (info.rms < MIN_FIXTURE_RMS) return `silent: RMS ${info.rms.toFixed(5)} < ${MIN_FIXTURE_RMS}`
  return null
}

/** The fixture's size, format, duration and energy as plain numbers, or its size and why it is unreadable. */
export function fixtureFacts(bytes) {
  try {
    const { fileBytes, sampleRate, channels, bitsPerSample, dataBytes, declaredDataBytes, durationMs, rms } = inspectWav(bytes)
    return { fileBytes, sampleRate, channels, bitsPerSample, dataBytes, declaredDataBytes, durationMs, rms: Number(rms.toFixed(4)) }
  } catch (error) {
    return { fileBytes: Buffer.byteLength(bytes), error: error instanceof Error ? error.message : String(error) }
  }
}

/** One line for fixtureFacts(): size, format, duration and energy. Content-free. */
function formatFixture(facts) {
  if (facts.error !== undefined) return `${facts.fileBytes} bytes, unreadable WAV (${facts.error})`
  return `${facts.fileBytes} bytes, ${facts.sampleRate} Hz ${facts.bitsPerSample}-bit ${facts.channels}ch, ` +
    `${facts.durationMs} ms, RMS ${facts.rms.toFixed(4)}`
}

/** One line describing the fixture: size, format, duration and energy. Content-free. */
export function describeFixture(bytes) {
  return formatFixture(fixtureFacts(bytes))
}

/** Main-log tags that record the import pipeline, its ASR helpers and its storage reads. */
const PIPELINE_LOG = /\[(?:import|import-jobs|import-decoder|whisper-host|whisper-import|parakeet|parakeet-host|asr-assets|asr-model|dataless|storage)\]/

/**
 * What the gate saw of one import, as a plain JSON-serializable record (the shape a content-free JSON
 * report copies): the job's state and error, the recall read's ok/error and line count (null when it never
 * ran), the fixture (fixtureFacts() or a one-line summary), every native ASR request and result after
 * `afterSequence`, and the pipeline's main-log lines. Transcript text is reported only as a character count.
 */
export function importReport({ engine, job, meeting, fixture, observed, afterSequence, mainLog }) {
  const asrRequests = (observed?.hosts ?? []).flatMap((host) =>
    (host.requests ?? [])
      .filter((request) => request.sequence > afterSequence)
      .map((request) => ({
        host: host.serviceName ?? null,
        pid: host.pid ?? null,
        id: request.id,
        sequence: request.sequence,
        pcmBytes: request.pcmBytes ?? null,
        ...(request.error ? { outcome: 'error', error: request.error }
          : request.complete ? { outcome: 'result', resultChars: String(request.text ?? '').length } : { outcome: 'pending' })
      }))
  )
  return {
    engine,
    job: { state: job?.state ?? 'missing', error: job?.error ?? null, file: !!job?.file },
    recallRead: meeting === undefined ? null : { ok: meeting?.ok === true, error: meeting?.error ?? null, lines: meeting?.lines?.length ?? 0 },
    fixture,
    asrRequests,
    mainLog: String(mainLog ?? '').split(/\r?\n/).filter((line) => PIPELINE_LOG.test(line))
  }
}

/** importReport() as the gate's failure lines, one fact per line. */
export function importDiagnostics(input) {
  const { engine, job, recallRead, fixture, asrRequests, mainLog } = importReport(input)
  const out = [
    `${engine} job: state=${job.state} error=${JSON.stringify(job.error)} file=${job.file ? 'yes' : 'no'}`,
    `${engine} recallRead: ${recallRead === null ? 'not called' : `ok=${recallRead.ok} error=${JSON.stringify(recallRead.error)} lines=${recallRead.lines}`}`,
    `fixture: ${typeof fixture === 'string' ? fixture : formatFixture(fixture)}`
  ]
  if (!asrRequests.length) out.push('asr requests: none observed')
  for (const request of asrRequests) {
    const outcome = request.outcome === 'error' ? `error=${JSON.stringify(request.error)}`
      : request.outcome === 'result' ? `result chars=${request.resultChars}` : 'pending'
    out.push(`asr request: host=${request.host ?? 'unknown'} pid=${request.pid ?? 'unknown'} id=${request.id} seq=${request.sequence} pcmBytes=${request.pcmBytes ?? 'none'} ${outcome}`)
  }
  if (!mainLog.length) out.push('main log: no import/ASR/storage lines')
  for (const line of mainLog) out.push(`main log: ${line}`)
  return out
}
