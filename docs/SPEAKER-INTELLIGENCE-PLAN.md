# Métis Speaker Intelligence — Dual-Platform Design

**Date:** 2026-07-16 · **Status:** design approved for build (research verified, 107-agent adversarial pass)
**Goal:** live "who's speaking" in every meeting — Teams-grade attribution without platform audio access — plus a voice memory that trains itself. One source tree, macOS + Windows identical (all sherpa-onnx CPU).

---

## 1. Why this design wins

Teams knows the speaker because each participant is a separate audio stream. Métis gets two: mic (**ME**) and mixed loopback (**THEM**). So THEM must be separated by **voiceprint**. Everything below is fully on-device; no audio or embedding ever leaves the machine.

**The self-training loop (the "push further"):** Métis already backfills real names onto transcript lines from the Teams VTT after every meeting (`applySpeakerNames`, Jaccard-matched, `name` field). Live diarization gives every line a voiceprint. Join the two after each meeting → automatic, zero-effort voice profiles per real person. The system gets smarter every meeting; nobody ever records an enrollment sample unless they want to. Next meeting, "Jane Doe" is named from her first sentence even when Teams transcription is off.

## 2. Verified foundations (research, July 2026)

- `sherpa-onnx-node` **v1.13.3 — already shipped in Métis** — exports `SpeakerEmbeddingExtractor` (audio → embedding) and `SpeakerEmbeddingManager` (`addMulti({name, v})`, `search({v, threshold})` → name or `<Unknown>`, `verify`) — the exact enrollment/ID primitives. Also `OfflineSpeakerDiarization` (pyannote segmentation-3.0 + AHC clustering) for the post-meeting refinement pass.
- **No streaming diarization exists in sherpa-onnx** (verified against source) — the live layer is app-side. Métis' shape makes that easy: audio already arrives as **≤6 s single-speaker-ish VAD turns** per channel, so per-window embedding + incremental matching ≈ live diarization (diart's rolling-buffer architecture, collapsed onto our natural turn boundaries).
- **Models** (all ONNX, laptop-CPU): embedding — **3D-Speaker CAM++ en_voxceleb, 29.6 MB** (primary; Apache-2) or NeMo TitaNet-small 40.3 MB; segmentation — **pyannote segmentation-3.0, 1.5 MB int8, MIT** (commercial-safe; the Rev alternative is non-commercial — never ship it). The sherpa demo default embedding is Chinese-trained — swap for English.
- Cosine threshold starting point 0.5–0.6 (sherpa demo default 0.6); **unknowns to calibrate on real VoIP audio**: threshold drift under Teams/Zoom codecs, CPU cost alongside ASR — Phase-0 measurement, not assumption.

## 3. Architecture (per capability, both platforms — identical code)

```
renderer (listen.ts)                          main
mic  ──worklet──► VAD turns ─┐
                             ├─ parakeetFeed(samples, speaker) ──► parakeet.ts (ASR, unchanged)
loopback ─worklet─► VAD turns┘        │ (speaker tag currently DROPPED — forward it)
                                      └─► speaker-id.ts (NEW)
                                            ├─ SpeakerEmbeddingExtractor (CAM++ en, 30MB)
                                            ├─ session clusters (rolling centroids, cosine)
                                            ├─ SpeakerEmbeddingManager (persistent voiceprints)
                                            └─ line.name ◄─ "Jane Doe" | "Speaker 2"
after meeting: Teams VTT names ⋈ line voiceprints ──► voiceprint store (auto-enrollment)
```

1. **Tap:** `parakeet:feed` handler forwards `{samples, speaker}` (today it drops `speaker`). THEM windows → embedding; ME windows → embedding only for echo-defense + profile upkeep of the operator. Whisper-engine users: renderer forwards the same turns through a new `speaker:embed` IPC (same payload cap) — the tap is engine-independent at the chokepoint.
2. **Live labeling (speaker-id.ts):** embedding → (a) match against **persistent voiceprints** (Manager.search, threshold θ_id) → real name; (b) else match session centroids (cosine ≥ θ_cluster) → "Speaker N" + centroid EMA update; (c) else new session cluster. Label lands on the transcript line via the existing optional `name` field — **zero schema change** (`'them'`/`'you'` enum untouched; render/save/parse-back already handle `name`).
3. **Echo defense:** THEM window matching the operator's own voiceprint above θ_echo = mic bleed → relabel/suppress (kills the "I hear myself in the loopback" mislabels).
4. **Auto-enrollment (the flywheel):** in `backfillSpeakerNames` (already runs after every save): for each line the VTT names AND live clustering labeled, accumulate that cluster's embeddings into the named person's voiceprint (quality gates: single-speaker windows, high VTT match confidence, N≥3 windows; EMA update, cap K embeddings/person). Manual enrollment (Settings, ~20 s read-aloud) stays as the optional fast path.
5. **Post-meeting refinement:** optional `OfflineSpeakerDiarization` pass over the saved meeting's THEM turns re-clusters with full context and corrects live labels + splits multi-speaker windows (the ≤6 s windows are mostly single-speaker; the offline pass mops up the rest).
6. **Privacy:** voiceprints = local JSON under userData (encrypted with the existing store key if present), per-person delete in Settings, hard off-switch; excluded from any cloud path by construction. Confidential-meeting flag (`setConfidential` exists) skips auto-enrollment.
7. **Live UI:** transcript rows show `name` when present (Review.tsx already prefers it); pill shows active-speaker chip. "Name this speaker" affordance on an unknown cluster propagates the name backward across the meeting.

## 4. Packaging

- Models via the established pattern: `fetch-models.mjs`-style pinned download + checksum, `resources/models/speaker/` → extraResources both platforms (~31 MB total: CAM++ en + segmentation int8). Guard script + contract test like every other sidecar asset.
- Runtime: same `sherpa-onnx-node` addon instance as Parakeet (`probeSherpa` handle reused); embeddings run on the existing `parakeet:feed` cadence (one ≤6 s window per turn) — no new processes.

## 5. Phases

- **P0 measure:** embed 100 real windows, measure ms/window + threshold separation ME-vs-recordings. Gate: <80 ms/window on this machine's CPU.
- **P1 live labeling:** tap + speaker-id.ts + session clusters + `name` injection + tests (fake embeddings, no models in CI).
- **P2 flywheel:** VTT⋈cluster auto-enrollment + voiceprint store + echo defense + Settings (list/delete/off, manual enroll).
- **P3 polish:** offline refinement pass, active-speaker chip, backward name propagation, per-speaker summary attribution in recaps/brain.

## 6. Open risks (tracked, not assumed away)

- VoIP codec compression may squeeze embedding separation — P0 measures on REAL Teams loopback audio, thresholds configurable.
- Multi-speaker-within-window: accepted in P1 (VAD turns are short); P3 offline pass corrects history.
- Cross-talk/overlap: out of scope for live labels (even Teams mislabels overlap); offline pass handles.
- CPU on old Windows laptops: embedding is per-turn not per-frame; if P0 misses the gate on reference hardware, fall to int8 embedding model.
