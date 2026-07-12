# Third-Party Notices

Métis bundles the following third-party machine-learning models and runtime binaries directly
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
- **Distribution**: optional benchmark asset; excluded from the standard installer to keep release
  artifacts within the deployment safety limit.

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

### FFmpeg 7.1.1
- **Publisher**: FFmpeg project
- **License**: GNU Lesser General Public License v2.1 or later (LGPL-2.1-or-later). The bundled binary
  is self-built with `--disable-gpl --disable-nonfree`; its `ffmpeg -L` output confirms LGPL terms.
- **Used for**: streaming, bounded-memory decode/resample of imported recordings to 16 kHz mono PCM.
- **Bundled at**: `resources/ffmpeg/<platform>-<arch>/`; complete license text is included at
  `resources/ffmpeg/LICENSE.LGPL-2.1.txt`.

### ONNX Runtime Web (onnxruntime-web / @huggingface/transformers)
- **Publisher**: Microsoft (ONNX Runtime), Hugging Face (transformers.js bundling)
- **License**: MIT License
- **Used for**: running the Whisper models above on-device (WASM/WebGPU execution)
- **Bundled at**: `resources/ort/`

### node-llama-cpp 3.19.0

- **Publisher**: Gilad S. / withcatai.
- **License**: MIT License; `node_modules/node-llama-cpp/LICENSE` contains the complete terms and
  `Copyright (c) 2023 Gilad S.`
- **Used for**: loading and running the selected GGUF text model entirely on-device.
- **Bundled at**: JavaScript runtime under `app.asar/node_modules/node-llama-cpp/`.

### @node-llama-cpp platform binaries 3.19.0

- **Publisher**: Gilad S. / withcatai; the installed build metadata records
  ggml-org/llama.cpp release `b9842`.
- **License**: MIT License; every platform package includes its complete `LICENSE` with
  `Copyright (c) 2024 Gilad S.`
- **Used for**: the reviewed native CPU, Metal, or Vulkan backend selected for the target installer.
- **Bundled at**: target-specific binaries under
  `app.asar.unpacked/node_modules/@node-llama-cpp/<target>/bins/`.

### ggml-org/llama.cpp b9842

The native packages above embed ggml-org/llama.cpp release `b9842`.

MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Packaged local text and vision models

Each build contains exactly the text and vision variants recorded in its packaged
`local-ai/manifest.json`. The tracked candidate catalog is an evaluation inventory, not a statement
that every candidate is bundled. Model files are fetched only at build time from immutable commits,
verified by size and SHA-256, and copied into the installer. Métis never downloads them after install.

### Qwen3 text candidates

- **Publisher**: Qwen / Alibaba Cloud; compact evaluation conversions may be sourced from Unsloth.
- **License**: Apache License 2.0.
- **Used for**: lightweight on-device text tasks when the selected variant passes release gates.
- **Provenance**: compact third-party conversions remain evaluation-only unless the packaged manifest
  references a separately reviewed release-exception notice. See
  `resources/local-ai/licenses/model-conversion-notices.md`.

### SmolVLM-256M-Instruct vision candidate

- **Publisher**: Hugging Face.
- **License**: Apache License 2.0.
- **Used for**: on-device screenshot captioning and text extraction when selected.

### Florence-2-base-ft vision candidate

- **Publisher**: Microsoft; ONNX conversion published by onnx-community.
- **License**: MIT License.
- **Used for**: the evaluated structured OCR/region alternative when selected.

---

This file accompanies the packaged app and must stay in sync with `scripts/fetch-models.mjs`,
`resources/local-ai/candidates.json`, and the packaged local-AI runtime manifest. Exact model license
bytes are included under `resources/local-ai/licenses/`.
