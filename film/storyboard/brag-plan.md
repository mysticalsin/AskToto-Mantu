# BRAG plan - Métis launch film (M2-0389)

Status: pre-production. Nothing here is a product-capability claim beyond what the claim register (`media/launch-film/CLAIMS.json`) allows; `release_claims_approved` stays false.

## Route

The full route is required: `/brag --full`. Without `--full`, `/brag` drops to the `brag-slim` route on Opus 5.5, which skips the plan, contact-sheet and animatic gates. `render-log.json` records the route and `preproduction.test.mjs` fails a slim-route render.

## Format

3840x2160, 30 fps, H.264 yuv420p, 34 seconds, rendered by the pinned Hyperframes toolchain in CI only (D-28).

## Hook

H1 Overlay first, from `hook-concepts.md`.

## Beats

| Beat | Shot | Scene | Seconds | Claim | State today |
|---|---|---|---|---|---|
| 1 | S01 | NP-01 Opening title | 4 | none | non-product |
| 2 | S02 | LF-01 Overlay appears | 6 | CL-01 | concept, label held |
| 3 | S03 | LF-02 Live capture and notes | 8 | CL-02 | reconstruction, label held |
| 4 | S04 | LF-03 Hindsight recall | 8 | CL-03 | concept, label held |
| 5 | S05 | NP-05 Render-path proof card | 4 | CL-06 | render-path proof only |
| 6 | S06 | NP-04 Closing card | 4 | none | non-product |

Cut and staying cut: the privacy scene (privacy line is cut, D-12), the comparison montage (no competitive qualification, D-27) and any Mac/Windows availability line (CL-07, D-29).

## Gates before the final render

1. `hook-concepts.md` selection recorded.
2. `composition-brief.md` complete for every shot.
3. Contact sheet and animatic drawn by the `Film toolchain` workflow (artifact `film-preproduction-review`).
4. Both signed off in `render-log.json`.
5. Render invoked as `/brag --full`.

## Reference clip

The X reference clip is to be viewed before the hook is locked. The attempt and its viewed/not-viewed result are recorded in `render-log.json`.
