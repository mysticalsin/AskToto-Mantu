# Métis live transcript quality

Product contract for live and import ASR. Overlay chrome, island geometry, onboarding, identity card, Intelligence dashboards, and time-saved accounting are out of scope.

The packaged model and the model actually running must be described accurately. A stored quality preference is not proof that a larger model is installed or running.

## Default path

- Fresh setup measures total RAM: 8 GiB or less selects Parakeet; more than 8 GiB selects Whisper. Invalid or unavailable RAM information falls back to Parakeet. Existing user and managed preferences are preserved. See `preferredFreshAsrEngine` and the onboarding preference tests.
- Packaged live Whisper uses Whisper base. The packaged Speech screen does not offer a Best/Fast switch that leaves this model unchanged.
- The optional larger Whisper model (`whisper-large-v3-turbo`) applies to imported recordings only; it does not replace the packaged live model. Its availability and download state are shown separately.
- `asrQuality` still defaults to `best` in the schema and listener for compatibility with existing profiles. The large-live preference is development-only in unbundled builds; it is not a customer-package model guarantee.
- If a requested development live model cannot load, report `qualityDegraded` and a Settings → Speech note. Do not describe the running fallback as the requested larger model, and do not imply that downloading the import model changes live transcription.

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
- Time-to-first-caption (TTFC) is speech-onset → first non-empty caption. Measure the scheduling budget in tests / `scripts/bench-asr-ttfc.mjs`; decode time is hardware-bound and must also be measured on the actual packaged engine.
- Prewarm the selected engine and available model. A stored `best` preference must not be presented as proof of a large live model in a package that uses Whisper base.

## Echo and empty stalls

- Parakeet / Apple return `{ text: '', echo: true }` when operator loopback bleed is dropped.
- Empty-run stall counters ignore echo silence. A healthy session must not silent-downgrade to Whisper.
- Whisper `speakerEmbed` returns `echo: true` so the renderer drops already-committed THEM bleed.

## Meaning (recap / notes)

- Recap and notes stay in the spoken language(s). Do not translate away unless the user set a summary language.
- Import recap keeps diarization names (`Jane Doe` / `Speaker N`), not a flattened `SPEAKER:`.
- Mixed-language transcripts keep `[conversation switches to …]` markers so the LLM can see the switch.

## How to try

1. Use isolated fresh profiles at the 8 GiB boundary and above it; confirm Parakeet and Whisper respectively. Reopen an existing profile and confirm its choice is preserved.
2. Settings → Audio → Speech: confirm the packaged live model is named accurately and the optional larger model is marked for imports only. There must be no no-op packaged Best/Fast toggle.
3. Auto language, bilingual call (e.g. French greeting then English). First pin needs two confirming probes; a later switch re-pins after the same bar.
4. End meeting → recap stays in the spoken language(s) unless Summary language is set.
5. Verify real packaged imports with both engines and no silent fallback. Separately test bilingual live capture on Mac and Windows; automated import success does not prove live microphone, loopback, or speaker-identification quality.
