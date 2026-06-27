# PLAN v2 — AskToto "Interview Copilot" (the whole experience)

Builds on v1 (overlay + Ask + Capture + Listen + Fact-check, all working). Flagship use case:
**live interview/meeting copilot**. Verified: Electron 33 supports system-audio loopback.

## New capabilities
1. **Dual audio** — system loopback (`setDisplayMediaRequestHandler` audio:'loopback') + mic →
   two Whisper streams → labeled transcript lines {speaker: them|you, text, t}.
2. **Modes / personas** — interview | meeting | sales | general. Each = tuned system prompt.
   Interview copilot speaks AS the candidate, first person.
3. **Profile context** — resume + role + company + jobDescription + notes (stored encrypted-ish in
   settings). Injected into interview/sales prompts so answers are tailored.
4. **Auto-answer on question** — detect a question from THEM (ends with ? / interrogative) →
   auto-generate the suggested answer (debounced). Manual "Answer this" too.
5. **Onboarding** — first run: welcome → mic perm → screen perm → API key → profile → done.
6. **Session summary** — end listening → generate recap + key Q&A + follow-ups from transcript.
7. **Syntax highlighting** — custom shiki CodeBlock via streamdown `components` override (fixes v1 gap).
8. **Settings v2** — mode default, per-mode model, profile editor, audio source (mic/system/both),
   auto-suggest toggle, hotkey reference, undetectable.
9. **Copilot panel** — labeled live transcript (Them/You bubbles) + streamed suggested-answer cards.

## Contract changes (src/shared/ipc.ts)
- Mode, Profile, TranscriptLine types. Settings += {mode, profile, autoSuggest, perModeModel?, onboardingDone}.
- AskMode += 'summary'. suggest/answer prompts become mode+profile aware (built in main/personas.ts).

## Files
- main: personas.ts (system prompts), index.ts (display-media handler, persona wiring, summary).
- renderer: lib/listen.ts (dual capture + question detect), components/{Onboarding,Copilot,Summary,
  ModePicker,CodeBlock}.tsx, Settings.tsx (profile editor), App.tsx (modes/onboarding/copilot wiring).

## DoD
typecheck+build green · launch + screenshot onboarding/copilot/settings · loopback handler wired ·
personas tailored · honest gaps (live audio output needs Tony's key + perms).
