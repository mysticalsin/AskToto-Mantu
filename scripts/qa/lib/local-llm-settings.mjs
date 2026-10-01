// The settings.json a packaged proof seeds into a fresh profile so window.toto.localPrewarm can start the
// bundled local model. One copy, shared by sidecar-boot-reaper.mjs and the candidate-scenarios lane, so the
// two proofs always start the same model.
export const LOCAL_LLM_SETTINGS = Object.freeze({
  localLlm: Object.freeze({
    enabled: true,
    modelId: 'qwen3.5-0.8b',
    useFor: Object.freeze({ suggest: true, summary: false, vision: false }),
    fallback: true
  })
})
