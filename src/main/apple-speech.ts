/**
 * Apple Speech ASR engine (SFSpeechRecognizer, fully on-device) — the opt-in THIRD live-transcription
 * engine alongside Parakeet (default) and Whisper. Unlike Parakeet/Whisper, it needs no bundled model:
 * it runs through the metis-mac-helper Swift sidecar (native/mac-helper/main.swift's `transcribe`
 * subcommand), which forces requiresOnDeviceRecognition — audio never leaves the Mac, and no Apple
 * Intelligence toggle is required (SFSpeechRecognizer has shipped on-device dictation since macOS 13).
 *
 * Same batch-per-window contract as Parakeet: one mono 16kHz Float32 window in, one text result out.
 * Unlike parakeetTranscribe, this NEVER throws — any failure (non-mac, helper missing, authorization
 * denied, timeout, bad audio) resolves to '' so the renderer's engine-agnostic fallback path treats it
 * exactly like genuine silence and Listen never breaks because this engine had a bad moment.
 */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { macHelperPath, macHelperPresent } from './mac-helper'
import { mainLog } from './logger'

const SAMPLE_RATE = 16000
const TRANSCRIBE_TIMEOUT_MS = 15_000

/** True when this platform + build can even attempt Apple Speech (darwin + the mac-helper sidecar is
 *  present). Does NOT mean authorization has been granted — that's resolved lazily per call, same as
 *  Parakeet's model-readiness check is separate from whether decoding actually succeeds. */
export function appleSpeechAvailable(): boolean {
  return process.platform === 'darwin' && macHelperPresent()
}

/** Encode one mono Float32 PCM window as a 44-byte-header 16-bit PCM WAV buffer (16kHz, matching the
 *  ASR pipeline's fixed sample rate throughout). Pure — unit-tested directly. */
export function encodeWav16kMono(samples: Float32Array): Buffer {
  const bytesPerSample = 2
  const blockAlign = bytesPerSample // mono
  const byteRate = SAMPLE_RATE * blockAlign
  const dataSize = samples.length * bytesPerSample
  const buffer = Buffer.alloc(44 + dataSize)

  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16) // fmt chunk size (PCM)
  buffer.writeUInt16LE(1, 20) // audio format: 1 = PCM
  buffer.writeUInt16LE(1, 22) // channels: mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(16, 34) // bits per sample
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    // Clamp before scaling so out-of-range input (shouldn't happen from the AudioWorklet, but a bad
    // sample must never wrap around into noise) never produces int16 overflow.
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    const int16 = Math.round(clamped * (clamped < 0 ? 0x8000 : 0x7fff))
    buffer.writeInt16LE(int16, offset)
    offset += 2
  }
  return buffer
}

/**
 * Transcribe one mono 16kHz Float32 PCM window → text, via the mac-helper `transcribe` subcommand.
 * NEVER throws: unavailable engine, spawn failure, timeout, non-zero exit, or a helper that prints
 * nothing all resolve to '' — the renderer cannot tell an unavailable Apple Speech engine apart from
 * genuine silence, which is exactly the same contract Parakeet's THROWN errors give it a chance to
 * distinguish (Apple Speech has no bundled-model gate to fail loudly on, so there is no separate
 * "broken vs silent" signal to preserve here).
 */
export async function appleSpeechTranscribe(samples: Float32Array): Promise<string> {
  if (!appleSpeechAvailable()) return ''

  const tmpPath = join(tmpdir(), `metis-apple-speech-${randomUUID()}.wav`)
  try {
    writeFileSync(tmpPath, encodeWav16kMono(samples))
  } catch (e) {
    mainLog.warn('[apple-speech] wav write failed', e instanceof Error ? e.message : String(e))
    return ''
  }

  try {
    return await new Promise<string>((resolve) => {
      let proc: ReturnType<typeof spawn>
      try {
        proc = spawn(macHelperPath(), ['transcribe', tmpPath], { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (e) {
        mainLog.warn('[apple-speech] spawn failed', e instanceof Error ? e.message : String(e))
        resolve('')
        return
      }
      let settled = false
      const settle = (value: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        proc.kill('SIGKILL')
        settle('')
      }, TRANSCRIBE_TIMEOUT_MS)
      let stdout = ''
      let stderr = ''
      proc.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
      proc.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
      proc.once('error', (e) => {
        mainLog.warn('[apple-speech] process error', e instanceof Error ? e.message : String(e))
        settle('')
      })
      // 'close', never 'exit' (same reasoning as mac-helper.ts's OCR path): 'exit' can fire while piped
      // stdout still has undelivered chunks in flight, truncating the transcript on exactly the longer
      // utterances this engine exists to transcribe.
      proc.once('close', (code) => {
        if (code !== 0) {
          if (stderr.trim()) mainLog.warn(`[apple-speech] exited ${code}: ${stderr.trim().slice(0, 300)}`)
          settle('')
          return
        }
        settle(stdout.trim())
      })
    })
  } finally {
    try {
      unlinkSync(tmpPath)
    } catch {
      /* best-effort cleanup */
    }
  }
}
