export function assertBeforeDeadline(deadline, now = performance.now()) {
  if (!Number.isFinite(deadline) || !Number.isFinite(now) || now >= deadline)
    throw new Error('RUNTIME_LLAMA_INFERENCE_TIMEOUT')
}
