# Third-Party Notices

AskToto bundles the following third-party machine-learning models and runtime binaries directly
inside the packaged app (see `scripts/fetch-models.mjs` and `electron-builder.yml`'s `extraResources`
block) so speech transcription works fully offline, with no first-run download. This file lists them
and their licenses, as required by the models' own license terms.

## Speech-to-text models

### Whisper base (Xenova/whisper-base)
- **Publisher**: OpenAI (original Whisper model), converted to ONNX by Xenova
- **License**: Apache License 2.0
- **Used for**: the default/fallback (WASM) transcription engine
- **Bundled at**: `resources/models/Xenova/whisper-base/`

### Whisper large-v3-turbo (onnx-community/whisper-large-v3-turbo)
- **Publisher**: OpenAI (original Whisper model), converted to ONNX by the onnx-community
- **License**: Apache License 2.0
- **Used for**: the higher-quality (WebGPU) transcription engine
- **Bundled at**: `resources/models/onnx-community/whisper-large-v3-turbo/`

### Parakeet TDT 0.6B v3 (nvidia/parakeet-tdt-0.6b-v3)
- **Publisher**: NVIDIA
- **License**: Creative Commons Attribution 4.0 International (CC-BY-4.0)
- **Attribution**: This app includes the Parakeet TDT 0.6B v3 speech recognition model
  (`sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`), created by NVIDIA and licensed under
  [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/), converted to ONNX/int8 format by the
  [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) project. No modifications were made to
  the model weights beyond that upstream conversion.
- **Used for**: the optional Parakeet transcription engine (Settings → AI)
- **Bundled at**: `resources/asr/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/`

## Runtime binaries

### ONNX Runtime Web (onnxruntime-web / @huggingface/transformers)
- **Publisher**: Microsoft (ONNX Runtime), Hugging Face (transformers.js bundling)
- **License**: MIT License
- **Used for**: running the Whisper models above on-device (WASM/WebGPU execution)
- **Bundled at**: `resources/ort/`

---

This file is generated to accompany the packaged app and should be kept in sync with
`scripts/fetch-models.mjs` if the bundled models ever change. See each model's own license text at
the links above for the full terms.
