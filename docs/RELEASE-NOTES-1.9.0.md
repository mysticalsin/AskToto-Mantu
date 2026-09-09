# Métis 1.9.0 — transcript quality & multi-speaker

## Goals

- Better transcript quality options without forcing heavy Whisper models on weak devices
- Multi-person speaker labels beyond You/Them (`Speaker N` → named voiceprints)
- Keep CAM++ / Parakeet path light (lazy load, 1–2 CPU threads)

## What shipped

1. **Parakeet-first quality guidance** — Settings copy + `docs/asr/QUALITY.md` steer laptops to Parakeet; Whisper Best remains available for non-European speech with honest Fast fallback.
2. **Live finalize** — end-of-meeting cluster merge (already on import) now runs on live save + stop so over-split `Speaker N` labels collapse before disk.
3. **Name this speaker** — Review: click a `Speaker N` label to rename; remaps the transcript and promotes a voiceprint when session embeddings exist.
4. **Voiceprint manager** — Settings → Local AI lists/deletes on-device voiceprints.
5. **IPC** — `speaker:profiles:list|delete`, `speaker:promote`, `speaker:finalize`.

## Efficiency

- Embedding extractor stays lazy; disabled when Speaker ID is off
- Embeddings on turn cadence only; mergePass once per meeting end
- No new auto-download of Whisper large; Fast + Parakeet remain the constrained-device paths

## Verify

```bash
npx vitest run src/shared/speaker-names.test.ts src/main/speaker-id.test.ts src/main/speaker-cluster.test.ts
npx tsc -p tsconfig.node.json --noEmit && npx tsc -p tsconfig.web.json --noEmit
```

## Follow-up (efficiency + persistence)

- 8 GB RAM policy: Parakeet = Best; Whisper Best download/load gated; Parakeet released before Whisper fallback; 1 ASR thread on 8 GB class.
- Meetings folder heal on boot: lost settings pointers rebind to existing meeting folders — updates never erase prior meetings.
- `saveMeeting` sibling non-delete covered by regression tests.
