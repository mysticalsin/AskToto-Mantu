# Server intelligence plane — local compose profile

`compose.yml` brings up the two services the server-side intelligence plane
needs for engineering and tests: Postgres with the `vector` extension and the
pinned Hindsight API. There is no Neo4j, no second canonical database and no
queue broker. Hosted Vectorize Cloud is not used; that needs a separate
commercial decision.

## Decision status (ADR-014)

| Item | Status |
|---|---|
| Shape: self-hosted private Hindsight on one container platform with managed Postgres | Decided (D-5) |
| Hosting platform, region, managed Postgres product, operational owner | PENDING owner approval. Gates only live deployment (M2-0138, M2-0381) |
| Local profile in this directory | Available; test credentials only |

Until the platform is approved, work proceeds against this profile. Nothing in
it is deployed.

## Use

```
docker compose -f services/compose.yml up -d --wait
docker compose -f services/compose.yml down -v
```

Ports bind to loopback only (`METIS_PG_PORT`, default 54329;
`METIS_HINDSIGHT_PORT`, default 8888). Postgres data lives on tmpfs and is
discarded on `down`.

## Pinning

Image refs default to version tags and are overridable with
`METIS_PGVECTOR_IMAGE` and `METIS_HINDSIGHT_IMAGE`. The CI job
(`.github/workflows/m2-0119-services.yml`) resolves and records the digests it
ran in its artifact; pin `name@sha256:...` in the overrides from that record.
The Hindsight tag and its `mock` LLM provider are ASSUMED until that job passes.

## Verification

`m2-0119-services.yml` runs on `ubuntu-latest` only (D-28): it brings the
profile up, checks the `vector` extension, a round-trip vector query, and the
Hindsight `/health` endpoint, then uploads logs and digests.
