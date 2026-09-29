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

Recommended defaults, recorded until the owner decides:

| Item | PROPOSED default | Label |
|---|---|---|
| Hosting platform | One managed container platform (Azure Container Apps, matching the Entra tenant) | PROPOSED |
| Region | An EU region (West Europe), matching the data residency of the Operator backend | ASSUMED |
| Managed Postgres | Managed PostgreSQL 16 with the `vector` extension (Azure Database for PostgreSQL Flexible Server) | PROPOSED |
| Operational owner | The platform engineering lead for the Operator backend | ASSUMED |

LEAD_ACTION: write private ADR-014 recording platform/region/managed Postgres/operational owner as PENDING with the PROPOSED default above

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
The Hindsight tag and its `mock` LLM provider ran green in CI run 36502756798
(LOCALLY_TESTED for the health contract). The defaults are still version tags:
replacing them with `name@sha256:...` from that run's `digests.txt` artifact is
open, because the digests are only available to the lead from the artifact.

## Verification

`m2-0119-services.yml` runs on `ubuntu-latest` only (D-28): it brings the
profile up, checks the `vector` extension, a round-trip vector query, and the
Hindsight `/health` endpoint, then creates a memory bank through the Hindsight
API and confirms the row landed in Postgres (proves the database wiring beyond
liveness; the bank route and `banks` table are ASSUMED until the job runs), then uploads logs and digests.
