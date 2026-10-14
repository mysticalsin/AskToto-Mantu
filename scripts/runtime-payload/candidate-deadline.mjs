export function assertBeforeDeadline(deadline, now = performance.now()) {
  if (!Number.isFinite(deadline) || !Number.isFinite(now) || now >= deadline)
    throw new Error('RUNTIME_LLAMA_INFERENCE_TIMEOUT')
}

/** Exercise the same bounded HTTP/JSON inference response path in hosted deadline checks. */
export async function readInferenceResponse(fetchImpl, url, init, deadline) {
  assertBeforeDeadline(deadline)
  const response = await fetchImpl(url, init)
  assertBeforeDeadline(deadline)
  if (!response.ok) throw new Error('RUNTIME_LLAMA_INFERENCE_HTTP_FAILED')
  const result = await response.json()
  assertBeforeDeadline(deadline)
  const content = result.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) throw new Error('RUNTIME_LLAMA_INFERENCE_EMPTY')
  return result
}
