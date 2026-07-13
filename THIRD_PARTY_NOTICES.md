# Third-Party Notices

Métis bundles the following third-party machine-learning models and runtime binaries directly
inside each packaged app. Release builds provision and verify those assets before packaging; the
installed app never downloads a model or inference runtime. This file lists the bundled components
and their licenses.

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

### ggml-org/llama.cpp `llama-server` b9957

- **Publisher**: ggml-org / the llama.cpp contributors.
- **License**: MIT License.
- **Used for**: serving the bundled Qwen3.5 model to Métis over an authenticated loopback-only
  endpoint for on-device text and vision inference.
- **Bundled at**: `resources/llama/mac/` in the macOS arm64 app and
  `resources/llama/win/{vulkan,cpu}/` in the Windows x64 app. Windows includes a Vulkan build and a
  CPU fallback; macOS uses the Metal-capable arm64 build.
- **Pinned release**: llama.cpp `b9957`. The release archive is fetched and hash-verified during the
  build, never by the installed app.

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

## Packaged local text and vision model

### Qwen3.5 0.8B (UD-Q4_K_XL GGUF + mmproj-F16)

- **Publisher**: Qwen / Alibaba Cloud; GGUF conversion published by Unsloth.
- **License**: Apache License 2.0.
- **Used for**: supported on-device suggestions, summaries, and visual-input tasks through the bundled
  llama.cpp runtime.
- **Distribution**: the text weights and multimodal projector are pinned by byte size and SHA-256,
  fetched only during the release build, and copied into both the macOS arm64 and Windows x64
  packages. Métis does not acquire or replace them after installation.

---

This file accompanies the packaged app and must stay in sync with the build-time asset pins,
provisioning checks, and platform-specific `electron-builder.yml` resource mappings.
