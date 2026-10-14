const FORBIDDEN_PATTERNS = [
  /(?:^|\/)node_modules\/(?:@huggingface\/transformers|@xenova\/transformers|onnxruntime-(?:common|node|web)|sherpa-onnx-[^/]+|sharp|@img)(?:\/|$)/i,
  /(?:^|\/)out\/main\/(?:whisper-asr-host|parakeet-asr-host|parakeet-extract-host|speaker-embedding-host)\.(?:js|jsc)$/i,
  /(?:^|\/)out\/renderer\/assets\/(?:whisper\.worker-|ort-wasm-|[^/]*onnxruntime)/i,
  /(?:^|\/)out\/renderer\/.*whisper\.worker/i,
  /\.(?:onnx|gguf|ggml|safetensors|tflite|pt|pth|npy|npz)$/i,
  /(?:^|\/)(?:pytorch_model|model|weights|encoder|decoder|joiner)\.(?:bin|pt|pth)$/i
]

export function isForbiddenInferencePath(path) {
  const normalized = String(path).replace(/\\/g, '/').replace(/^\/+/, '')
  return FORBIDDEN_PATTERNS.some((pattern) => pattern.test(normalized))
}
