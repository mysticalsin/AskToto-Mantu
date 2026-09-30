# Launch-film claim register

M2-0178 keeps the launch film honest: every storyboard scene in `CLAIMS.json` is either backed by a verified evidence record or visibly labelled as `Concept UI sequence`, `Reconstruction`, or `Concept memory sequence`. Cut scenes stay in the register so they cannot quietly reappear in script or caption copy.

Run in CI:

```bash
node media/launch-film/check-claims.mjs
```

The checker writes `media/launch-film/out/claim-readiness.json` by default. Pass `--out <directory>` to send the report somewhere else for artifact upload.

Rules enforced by the gate:

- `release_claims_approved` must remain `false` until the owner approves.
- Forbidden phrases are scanned across every scene script, every caption and the top-level privacy line.
- A non-cut privacy line must use the exact M2-0149 verified sentence and evidence record; broad privacy wording is rejected.
- The hindsight scene can be `live` only when its evidence record is `LIVE_VERIFIED`; otherwise it must carry a visible concept label or be cut.
- Comparative, superiority, affiliation and infallibility claims stay cut unless M2-0185 lists the exact claim/scene slice and both final signed Windows and native Mac QA receipts.
- Every scene and claim carries `live`, `concept` and `cut` storyboard variants, and T2, T3 and rc1 re-evaluations are registered. The rc1 report is filed as M2-0210 evidence.

M2-0349 re-keys the register to the eight storyboard beats and adds:

- `storyboard_scenes` must be exactly `LF-01`..`LF-08` with the titles and `start_s`/`end_s` timings in `KIT_BEATS` (LEAD_ACTION: diff KIT_BEATS (ids, titles, start_s/end_s) against the kit STORYBOARD.json and correct any mismatch before M2-0213 consumes CLAIMS.json; the kit file is not in this repository, so these values are unverified against it. Update KIT_BEATS and CLAIMS.json together). A missing, extra, retitled or retimed beat fails.
- Each claim carries a `capability_class` (`verified`, `implemented-unverified`, `planned`, `unavailable`), a `build_hash` (null until a build exists) and an `evidence_record_id`. `verified` needs a build hash and LIVE_VERIFIED, ACCEPTED or MEASURED evidence; a `live` scene needs a verified claim.
- `film_status` is computed: `verified product preview` only when every shown scene is live on a verified claim, otherwise `concept preview`, where each concept scene must show its label as a caption. The declared value must match.
- A shown `platform-availability` claim fails unless `release_evidence` has an `AVAILABLE`, signed entry whose evidence record is LIVE_VERIFIED, ACCEPTED or MEASURED for each listed platform. `LF-07` must always carry a `platform-availability` claim. An unsigned BLOCKED Windows candidate (D-29) is not available.

REF-09 and REF-10 are presentation references only. They do not prove product behavior and must not be used as claim evidence.
