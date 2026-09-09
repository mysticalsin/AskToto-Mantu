# Métis live transcript quality

Product contract for live and import ASR. Overlay chrome, island geometry, onboarding, identity card, Intelligence dashboards, and time-saved accounting are out of scope.

Default engine is **Parakeet** (efficient CPU path for European languages). Default quality request is **Best**. Fast is a Settings power option, not a silent floor.

## Engines (resource cost)

| Engine | Role | Cost |
| --- | --- | --- |
| **Parakeet** (default) | NVIDIA NeMo TDT 0.6b int8 via sherpa-onnx — 25 European languages, auto-detect | Bundled; modest CPU (2 threads); prefer on laptops |
| **Whisper** | ~99 languages | Best ≈ large-v3-turbo (WebGPU / heavy); Fast ≈ base WASM (floor) |
| **Apple Speech** | macOS SFSpeechRecognizer | No extra ONNX download |

Pick Whisper when meetings are not European-language; keep Parakeet otherwise so weaker devices stay responsive.

## Default quality path

- `asrQuality` defaults to `best` in the settings schema, `DEFAULT_SETTINGS`, and every listen/App fallback.
- For Whisper, Best uses large multilingual (`whisper-large-v3-turbo` on WebGPU) unless the user opts into Fast.
- Fast is an explicit power option for constrained machines. The Settings control must say so.
- If Best cannot load (model missing, no WebGPU, load failure), degrade honestly: report `qualityDegraded`, persist a Settings → Speech note, and keep the user's requested label as Best-requested / Fast-running. Never present Fast as Best.

## Multi-speaker (1.9.0)

- Channel still sets `speaker`: mic → `you`, loopback → `them`, import → `unknown`.
- On-device CAM++ embeddings (lazy, 1 thread, ~30 MB) assign `name` (`Speaker N` or enrolled profile).
- End-of-meeting finalize merges over-split clusters before save (live + import).
- Review: click `Speaker N` to rename; remaps the transcript and promotes a voiceprint when embeddings exist.
- Settings → Local AI lists/removes saved voiceprints. Nothing leaves the device.

## Languages

- Auto-detect from speech. The Settings picker is a pin, not the only way a language is known.
- The language list is 60+ spoken languages. Every display name lowercased is a valid Whisper language token.
- Add a language in `src/shared/lang-id.ts` (names + detection), Settings (consumes that list), and Apple Speech locales — or not at all.
- Detection is conservative: `null` means "don't know." A wrong guess steers the decoder for the rest of the call.

## First pin and code-switching

- Live first-pin requires `SWITCH_AFTER` consecutive confirming probes — the same bar as a mid-meeting switch. A wrong-language greeting must not latch the call.
- After a pin lands, keep probing. When `SWITCH_AFTER` confirms a *new* language, re-pin. The first pin is not forever.
- Mid-sentence / mid-meeting switches must be noticed quickly. Mixed-language windows (two confident languages in one utterance) count as strong evidence of the new language.
- Whisper stays pinned while decoding (transformers.js defaults an un-pinned call to English). Language-agnostic Parakeet probes plus script/stopword ID are how a switch is seen.

## Latency

- Live captions must not wait on a 6 s monologue cap. Stream a first partial once enough speech is in the buffer; replace it when the turn ends.
- Time-to-first-caption (TTFC) is speech-onset → first non-empty caption. Best quality must not feel stuck. Measure the scheduling budget in tests / `scripts/bench-asr-ttfc.mjs` (decode time is hardware-bound and is not faked).
- Prewarm the quality the user will start with (default Best). Do not prewarm Fast and then swap to Best on first Listen.

## Echo and empty stalls

- Parakeet / Apple return `{ text: '', echo: true }` when operator loopback bleed is dropped.
- Empty-run stall counters ignore echo silence. A healthy session must not silent-downgrade to Whisper.
- Whisper `speakerEmbed` returns `echo: true` so the renderer drops already-committed THEM bleed.

## Meaning (recap / notes)

- Recap and notes stay in the spoken language(s). Do not translate away unless the user set a summary language.
- Import recap keeps diarization names (`Jane Doe` / `Speaker N`), not a flattened `SPEAKER:`.
- Mixed-language transcripts keep `[conversation switches to …]` markers so the LLM can see the switch.

## How to try

1. Fresh settings (or delete `asrQuality`) → Listen. Engine default Parakeet; quality Best.
2. Settings → Audio → Speech: Fast is the power option. Best stays the request even if this device degrades.
3. Multi-person call with Speaker ID on → Review shows Speaker 1 / Speaker 2; click to name; Settings lists voiceprints.
4. Auto language, bilingual call (e.g. French greeting then English). First pin needs two confirming probes; a later switch re-pins after the same bar.
5. End meeting → recap stays in the spoken language(s) unless Summary language is set.
