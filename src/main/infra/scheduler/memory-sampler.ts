import { READING_TTL_MS, refreshVmStatReading } from '../../llm/available-memory'

/** Boot: take the first vm_stat reading now and keep it fresh every READING_TTL_MS, so the local-model memory
 *  gate answers synchronously from a recent reading. darwin only (elsewhere the gate reads freemem()); returns a stop. */
export function startAvailableMemorySampler(platform: NodeJS.Platform = process.platform): () => void {
  if (platform !== 'darwin') return () => {}
  void refreshVmStatReading()
  const timer = setInterval(() => void refreshVmStatReading(), READING_TTL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
