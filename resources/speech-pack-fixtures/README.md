# Speech recognition self-test fixture

`en.wav` is the existing Parakeet smoke fixture, kept separately so an optional-model installer can test a requested pack without bundling its weights.

Source: [sherpa-onnx release asset](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/en.wav).
Reviewed asset ID: 270602525. Size: 184,608 bytes.
SHA-256: `148b936b43ce7c546a866e64da059f0458aee2d65e617f16e9d94f06e8d99ed6`.

The same pin appears in the application's reviewed runtime-assets manifest and speech-pack manifest. Packaging checks the separate installed copy against that pin. This is public test audio; user recordings are never used for activation tests.
