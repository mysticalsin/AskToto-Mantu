# Métis Local AI Model Asset Record

Date: 2026-07-10

Status: Verified candidate metadata; production selection still requires native evaluation and packaged-size proof

This record preserves immutable repository revisions, exact file sizes, LFS SHA-256 values, license sources, and known provenance gaps for the Métis packaged-local-AI candidates. It is an input to `resources/local-ai/candidates.json`, not permission to ship a model that has not passed the frozen evaluation.

## Runtime decision

TheStageAI `edge-lm` is not a cross-platform application runtime. It is Python 3.10+/MLX-oriented and Apple Silicon-specific, with no Node/Electron or Windows backend. Métis uses `node-llama-cpp` 3.19.0 for GGUF text inference and Transformers.js 3.8.1 for packaged ONNX vision.

## Text candidates

### Official Qwen3-1.7B Q8

Repository: [Qwen/Qwen3-1.7B-GGUF](https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/tree/90862c4b9d2787eaed51d12237eafdfe7c5f6077)

Revision: `90862c4b9d2787eaed51d12237eafdfe7c5f6077`

| File | Bytes | SHA-256 |
|---|---:|---|
| `Qwen3-1.7B-Q8_0.gguf` | 1,834,426,016 | `061b54daade076b5d3362dac252678d17da8c68f07560be70818cace6590cb1a` |

The official repository publishes no Q4_K_M or IQ4_XS file. Q8 is too large to assume it fits the current installer budget.

### Compact Qwen3-1.7B conversions

Repository: [unsloth/Qwen3-1.7B-GGUF](https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/tree/d7f544eead698dbd1f15126ef60b45a1e1933222)

Revision: `d7f544eead698dbd1f15126ef60b45a1e1933222`

| File | Bytes | SHA-256 |
|---|---:|---|
| `Qwen3-1.7B-IQ4_XS.gguf` | 1,010,383,424 | `a02e41d3208e97a7cb224297e8d3abb22e5bb8d664362c6be4f48948a3797eec` |
| `Qwen3-1.7B-Q4_K_M.gguf` | 1,107,409,472 | `b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897` |

Provenance restriction: the repository declares `base_model: Qwen/Qwen3-1.7B` and Apache 2.0, but does not document the exact upstream weight revision, llama.cpp revision, or per-file conversion recipe. These files may be evaluated. They may be selected for production only with a reviewed provenance exception that does not invent missing conversion facts.

Pinned Qwen base-model license source: `Qwen/Qwen3-1.7B@70d244cc86ccca08cf5af4e1e306ecf908b1ad5e/LICENSE`, 11,343 bytes, SHA-256 `832dd9e00a68dd83b3c3fb9f5588dad7dcf337a0db50f7d9483f310cd292e92e`.

### Official Qwen3-0.6B Q8

Repository: [Qwen/Qwen3-0.6B-GGUF](https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/tree/23749fefcc72300e3a2ad315e1317431b06b590a)

Revision: `23749fefcc72300e3a2ad315e1317431b06b590a`

| File | Bytes | SHA-256 |
|---|---:|---|
| `Qwen3-0.6B-Q8_0.gguf` | 639,446,688 | `9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031` |

Official Apache 2.0 license: 11,544 bytes, SHA-256 `5de36594c10839788a8c589443a8ef9d8b8d17c65a1b5807206ae037fc36c6bd`.

This is the provenance/size fallback. It cannot be selected unless French meeting summaries, citations, Mantu Intelligence, and latency independently pass.

### Compact Qwen3-0.6B conversions

Repository: [unsloth/Qwen3-0.6B-GGUF](https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/tree/50968a4468ef4233ed78cd7c3de230dd1d61a56b)

Revision: `50968a4468ef4233ed78cd7c3de230dd1d61a56b`

| File | Bytes | SHA-256 |
|---|---:|---|
| `Qwen3-0.6B-IQ4_XS.gguf` | 367,804,096 | `dacc1fe1dc6f4799f366ac3385299f71c7e02c58b8702448a174f14d91b1c64d` |
| `Qwen3-0.6B-Q4_K_M.gguf` | 396,705,472 | `ac2d97712095a558e31573f62f466a3f9d93990898b0ec79d7c974c1780d524a` |

These have the same undocumented-conversion restriction as the compact 1.7B files.

## Vision candidates

### SmolVLM-256M-Instruct Q8

Repository: [HuggingFaceTB/SmolVLM-256M-Instruct](https://huggingface.co/HuggingFaceTB/SmolVLM-256M-Instruct/tree/7e3e67edbbed1bf9888184d9df282b700a323964)

Revision: `7e3e67edbbed1bf9888184d9df282b700a323964`

| File | Bytes | SHA-256 |
|---|---:|---|
| `onnx/embed_tokens_quantized.onnx` | 28,385,824 | `4b919b829fe2bf225e42431230c56891116f0149e5170e36c99bcc0cfae0d2ef` |
| `onnx/vision_encoder_quantized.onnx` | 94,247,969 | `f82adc84246fbfe8651038470166385452682cc889538f5106544e622e5f1595` |
| `onnx/decoder_model_merged_quantized.onnx` | 137,221,644 | `33f14f3bca52699d733d86fcc9c5a0ec6f57afffa1dc9596abde53cde9df81aa` |
| `config.json` | 7,353 | `b70fb4bfde88df9eeebc9d8ff523733b8bf70d6c9b06c610325960e06ae9db52` |
| `generation_config.json` | 136 | `067a2a54e5f87162ecac6e0e911cc4665fc8f7f3324794ecbac0f76badb56636` |
| `preprocessor_config.json` | 486 | `6cb6e36d6fcb88ca1502c4a26750715dc3e7dedddc9a8f17b27d8d167d1457e7` |
| `processor_config.json` | 68 | `e7bff42da73ae9eec9042ef20e066e11f1ee20f025358ff79131e3c0fb549b46` |
| `tokenizer.json` | 3,548,256 | `5ece781dc8d2b2f3e2f289ca0ae50b17cfc27dd27bfe7971bb8241e0b964331a` |
| `tokenizer_config.json` | 28,249 | `36c6fd44d07d10fd8180ee6b46dcccf69fb7c06753968ff0d7e17b8bfe17b777` |

Model/metadata/license total: 263,451,342 bytes. With existing ORT sidecars: 285,091,845 bytes.

License source: `huggingface/smollm@a041759883ec7152d18fb985ea49be641a0bceef/LICENSE`, 11,357 bytes, SHA-256 `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`.

SmolVLM is the preferred package-margin candidate if it passes. It supports semantic captioning, visual Q&A, and text transcription. It does not supply Florence-style OCR boxes/regions. Published language metadata is English, so French screenshot performance is unknown until tested.

### Florence-2-base-ft Q4

Repository: [onnx-community/Florence-2-base-ft](https://huggingface.co/onnx-community/Florence-2-base-ft/tree/e88a44eaf3791a35eae0c5a47b3dbcd36e67eb6f)

Revision: `e88a44eaf3791a35eae0c5a47b3dbcd36e67eb6f`

| File | Bytes | SHA-256 |
|---|---:|---|
| `onnx/embed_tokens_q4.onnx` | 157,560,063 | `f972f338dedea6b67e10e87aacc0dfd4e247f1e18c60d3911af9e6b9edb68f32` |
| `onnx/vision_encoder_q4.onnx` | 81,236,858 | `8f211dfc176996d14e24d551f8e02530de781dd8b30d9e7d35b69b7c2d0340ce` |
| `onnx/encoder_model_q4.onnx` | 30,058,778 | `34b17bcf191dacb79bd482b94bad5cf1ba39bc770f6a4c9ae26f28b89c235e4b` |
| `onnx/decoder_model_merged_q4.onnx` | 64,393,474 | `be7a2f33e65f8d65538024772fda4d1c5a7752d60a7159aadf53f9f4798b90fa` |

Required metadata:

| File | Bytes | SHA-256 |
|---|---:|---|
| `config.json` | 5,432 | `d90c22ed72eb55291f183fcd9b98ebd3bd3d92bfcffb6c7f6e1606085e793525` |
| `generation_config.json` | 292 | `7b8eb17bbd6cf8a07f619ad83ae03881eff05b6b9237bab89005b40e77783c29` |
| `preprocessor_config.json` | 2,673 | `c892857e34a7082284983a7717717d39c9bf7e574f1f41d80d4c918c97502efa` |
| `tokenizer.json` | 2,297,961 | `d69dcdb2323e124ac4f800cb9863ddccea0d7bb11e16125e8df3bd60f2f8aeac` |
| `tokenizer_config.json` | 197,658 | `d8e64607233cb53b619fb46664f6cad08176c26e0e8735b2d30d888364f19600` |

Q4 weights total 333,249,173 bytes. Including metadata, pinned Microsoft license, and current ORT sidecars: 357,394,833 bytes.

Pinned Microsoft license: `microsoft/Florence-2-base-ft@f6c1a25888ffc1d945ee8a1a77ac833c7303d46e/LICENSE`, 1,141 bytes, SHA-256 `c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383`.

Compatibility restriction: generic Q4 is supported by Transformers.js 3.8.1 on WASM and WebGPU, but there is no primary Florence-specific proof that all four Q4 sessions work correctly and fast on both. Forced native WASM and WebGPU smokes are mandatory. The proven WebGPU-q4f16 plus WASM-q8 dual set totals about 522,558,457 bytes including metadata/license/ORT and puts the installer budget at greater risk.

## Existing ORT sidecars

Locked runtime: `onnxruntime-web@1.22.0-dev.20250409-89f8206ba4`.

| File | Bytes | SHA-256 |
|---|---:|---|
| `ort-wasm-simd-threaded.jsep.mjs` | 44,484 | `08fb86ec433c78bfb032c5d84a68b8e5a8d81268fa39e24314179a5767a5b9` |
| `ort-wasm-simd-threaded.jsep.wasm` | 21,596,019 | `c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39` |

## Planning size comparison

These are uncompressed payload totals, not installer proof:

| Text | Vision | Local-AI payload |
|---|---|---:|
| Qwen3-0.6B IQ4_XS | SmolVLM Q8 | 652,907,485 bytes |
| Qwen3-0.6B Q4_K_M | SmolVLM Q8 | 681,808,861 bytes |
| Official Qwen3-0.6B Q8 | SmolVLM Q8 | 924,550,077 bytes |
| Qwen3-1.7B IQ4_XS | SmolVLM Q8 | 1,295,486,813 bytes |
| Qwen3-1.7B Q4_K_M | SmolVLM Q8 | 1,392,512,861 bytes |

Using the stale 611.8 MiB Windows installer only as a planning baseline and avoiding double-counting ORT, Qwen3-1.7B IQ4_XS plus SmolVLM Q8 estimates to about 1,826.7 MiB, roughly 119 MiB below the 1.9 GiB gate. Qwen3-1.7B IQ4_XS plus Florence Q4 estimates to about 1,895.6 MiB, roughly 50 MiB below it. Real DMG/ZIP/EXE measurement decides; estimates do not.

## Selection rule

1. Prefer Qwen3-1.7B IQ4_XS only if its provenance exception, quality, French, citation, latency, memory, and package gates all pass.
2. Prefer upstream SmolVLM Q8 if semantic screenshot text/captioning passes EN/FR cases.
3. Select Florence Q4 only if native forced-WASM/WebGPU tests pass and structured OCR/regions materially improve the fixed cases.
4. Use official Qwen3-0.6B Q8 as the provenance/size fallback only if it independently passes every text gate.
5. Stage exactly one text and one vision variant. Never solve size by downloading a model after installation.
