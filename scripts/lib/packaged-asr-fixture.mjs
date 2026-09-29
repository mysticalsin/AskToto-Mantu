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

/** One line describing the fixture: size, format, duration and energy. Content-free. */
export function describeFixture(bytes) {
  try {
    const info = inspectWav(bytes)
    return `${info.fileBytes} bytes, ${info.sampleRate} Hz ${info.bitsPerSample}-bit ${info.channels}ch, ` +
      `${info.durationMs} ms, RMS ${info.rms.toFixed(4)}`
  } catch (error) {
    return `${Buffer.byteLength(bytes)} bytes, unreadable WAV (${error instanceof Error ? error.message : String(error)})`
  }
}

/** Main-log tags that record the import pipeline, its ASR helpers and its storage reads. */
const PIPELINE_LOG = /\[(?:import|import-jobs|import-decoder|whisper-host|whisper-import|parakeet|parakeet-host|asr-assets|asr-model|dataless|storage)\]/

/**
 * What the gate saw of one import, for the failure report: the job's state and error, the recall read's
 * ok/error and line count, the fixture, every native ASR request and result after `afterSequence`, and the
 * pipeline's main-log lines. Transcript text is reported only as a character count.
 */
export function importDiagnostics({ engine, job, meeting, fixture, observed, afterSequence, mainLog }) {
  const out = [
    `${engine} job: state=${job?.state ?? 'missing'} error=${JSON.stringify(job?.error ?? null)} file=${job?.file ? 'yes' : 'no'}`,
    `${engine} recallRead: ${meeting === undefined ? 'not called' : `ok=${meeting?.ok === true} error=${JSON.stringify(meeting?.error ?? null)} lines=${meeting?.lines?.length ?? 0}`}`,
    `fixture: ${fixture}`
  ]
  const requests = (observed?.hosts ?? []).flatMap((host) =>
    (host.requests ?? [])
      .filter((request) => request.sequence > afterSequence)
      .map((request) => ({ host, request }))
  )
  if (!requests.length) out.push('asr requests: none observed')
  for (const { host, request } of requests) {
    const outcome = request.error ? `error=${JSON.stringify(request.error)}`
      : request.complete ? `result chars=${String(request.text ?? '').length}` : 'pending'
    out.push(`asr request: host=${host.serviceName ?? 'unknown'} pid=${host.pid ?? 'unknown'} id=${request.id} seq=${request.sequence} pcmBytes=${request.pcmBytes ?? 'none'} ${outcome}`)
  }
  const logLines = String(mainLog ?? '').split(/\r?\n/).filter((line) => PIPELINE_LOG.test(line))
  if (!logLines.length) out.push('main log: no import/ASR/storage lines')
  for (const line of logLines) out.push(`main log: ${line}`)
  return out
}
