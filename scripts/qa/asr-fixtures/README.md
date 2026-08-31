# ASR golden fixtures

Offline ground-truth clips for Wave 0+ WER / language-pin contracts.

## Layout

```
asr-fixtures/
  manifest.json          # index of clips + expected text + language
  en/numbers.txt         # ground truth (audio optional; synthetic PCM in tests)
  fr/greeting.txt
  mixed/names.txt
```

Real `.wav` assets are optional in CI (large). Contract tests assert:

1. Manifest integrity (every entry has `id`, `lang`, `expected`, `tags`).
2. Language-pin helpers treat these texts as non-English when `lang !== 'en'`.
3. Number/name tokens survive `transcript-filter` / correction pipelines.

To add a clip: drop `id.txt` (+ optional `id.wav` 16 kHz mono), register in `manifest.json`, extend the contract test.

## Measurement

Offline WER against a live engine is gated behind `ASKTOTO_ASR_EVAL=1` and a provisioned Parakeet/Whisper host — not part of default `npm test`.
