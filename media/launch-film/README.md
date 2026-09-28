# Launch-film claim register

M2-0178 keeps the launch film honest: every storyboard scene in `CLAIMS.json` is either backed by a verified evidence record or visibly labelled as `Concept UI sequence`, `Reconstruction`, or `Concept memory sequence`. Cut scenes stay in the register so they cannot quietly reappear in script or caption copy.

Run in CI:

```bash
node media/launch-film/check-claims.mjs
```

The checker writes `media/launch-film/out/claim-readiness.json` by default. Pass `--out <directory>` to send the report somewhere else for artifact upload.

Rules enforced by the gate:

- `release_claims_approved` must remain `false` until the owner approves.
- Forbidden phrases are scanned across every scene script and caption.
- The hindsight scene can be `live` only when its evidence record is `LIVE_VERIFIED`; otherwise it must carry a visible concept label or be cut.
- Comparative, superiority, affiliation and infallibility claims stay cut unless M2-0185 lists the exact slice and both final signed Windows and native Mac QA receipts.
- Every scene carries `live`, `concept` and `cut` storyboard variants, and T2, T3 and rc1 re-evaluations are registered. The rc1 report is filed as M2-0210 evidence.

REF-09 and REF-10 are presentation references only. They do not prove product behavior and must not be used as claim evidence.
