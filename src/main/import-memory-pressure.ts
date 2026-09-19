/**
 * Speculative local work is optional. A whole-recording VAD import or a reserved high-memory Whisper
 * import tier takes precedence; user-requested local work is deliberately outside this gate.
 */
export function allowsSpeculativeLocalWork(vadPcmOwned: boolean, highMemoryWhisperReserved: boolean): boolean {
  return !vadPcmOwned && !highMemoryWhisperReserved
}
