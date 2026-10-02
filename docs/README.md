# Métis docs map

What each part of `docs/` is for, and which documents describe what ships today. A document that no longer does carries a
**Superseded**, **Historical** or **Point-in-time** banner at the top with a pointer to its replacement; such documents are kept,
never deleted.

Two checks keep this page honest, both run by the `docs-verify.yml` workflow against the release commit: a link check over
`docs/`, `README.md` and `AGENTS.md` (`scripts/docs/check-links.mjs`), and `scripts/docs/verify-commands.mjs`, which resolves or
runs every command block marked `verify` or `verify-dry`. A block is marked by writing the word after the language, for example
`bash verify-dry` on the opening fence.

## Start here

| Need | Read |
|---|---|
| Install Métis | [`INSTALL.md`](INSTALL.md), [`ENTERPRISE-DEPLOY-WINDOWS.md`](ENTERPRISE-DEPLOY-WINDOWS.md) |
| Set up a dev environment | [`DEVELOPMENT.md`](DEVELOPMENT.md), and `AGENTS.md` at the repository root for the rules every agent follows |
| How the app is built | [`asktoto-architecture.md`](asktoto-architecture.md): the 2.0 modular-monolith shape first, then the core loop |
| Where each platform's code lives and how a fix reaches users | [`PLATFORM-MAP.md`](PLATFORM-MAP.md) |
| The product target (the north star) | [`design/METIS-PLATFORM-NORTH-STAR.md`](design/METIS-PLATFORM-NORTH-STAR.md) (draft) |
| What the app may contact | [`NETWORK-EGRESS.md`](NETWORK-EGRESS.md), [`PROVIDER-ROUTING-POLICY.md`](PROVIDER-ROUTING-POLICY.md) |

## Runbooks

| Runbook | For |
|---|---|
| [`runbooks/qa.md`](runbooks/qa.md) | The gates a change passes and the hosted physical QA lanes |
| [`runbooks/staging.md`](runbooks/staging.md) | Operator staging before production |
| [`runbooks/operations.md`](runbooks/operations.md) | Operating the Operator, the Cloudflare proxy and the license service |
| [`runbooks/update.md`](runbooks/update.md) | How a release reaches installed apps, and how to check it |
| [`runbooks/diagnostics.md`](runbooks/diagnostics.md) | What an installed app leaves behind, and how to read it without touching content |

Deeper procedures these link to: [`operator/RUNBOOKS.md`](operator/RUNBOOKS.md) (deploy, migrate, backup, secrets, Access),
[`ENTERPRISE_RELEASE.md`](ENTERPRISE_RELEASE.md), [`SIGNING.md`](SIGNING.md).

## Compliance tracks

- **Single-user deployment** (one executive, personal use): the GDPR and EU AI Act pack in [`compliance/`](compliance/README.md).
  Every document in it is a draft for DPO review and none is adopted.
- **Multi-seat, Teams-integrated deployment**: a different processing activity that needs its own LIA and DPIA. That track is
  owned by M2-0150 and does not exist in this repository yet; the pointer is in the compliance README.

## Design

[`design/DESIGN.md`](design/DESIGN.md) is the index of the interface contracts: the design system, onboarding, the Bar, the
Operator console, the Cloudflare LLM gateway and the 2.0 command and capability designs.

## Superseded, historical and point-in-time

| Document | Status | Read instead |
|---|---|---|
| [`design/DESIGN-SPEC.md`](design/DESIGN-SPEC.md) | Historical reference | [`design/DESIGN.md`](design/DESIGN.md) |
| [`design/ONBOARDING-STARFIELD.md`](design/ONBOARDING-STARFIELD.md) | Superseded | [`design/ONBOARDING-KINETIC-GRID.md`](design/ONBOARDING-KINETIC-GRID.md) |
| [`design/2026-07-10-packaged-local-ai-design.md`](design/2026-07-10-packaged-local-ai-design.md), [`plans/2026-07-10-packaged-local-ai-implementation-plan.md`](plans/2026-07-10-packaged-local-ai-implementation-plan.md) | Superseded | The banners name the shipped source files |
| [`design/METIS-2.0-CAP1-DEPLOY-WIRE.md`](design/METIS-2.0-CAP1-DEPLOY-WIRE.md) | Historical | [`operator/RUNBOOKS.md`](operator/RUNBOOKS.md), [`runbooks/staging.md`](runbooks/staging.md) |
| [`asktoto-hardening-backlog.md`](asktoto-hardening-backlog.md) | Historical record | [`qa/BUG-LEDGER.md`](qa/BUG-LEDGER.md) for open defects |
| [`plans/time-saved-and-summaries.md`](plans/time-saved-and-summaries.md) | Historical | [`design/TIME-SAVED.md`](design/TIME-SAVED.md) |
| [`MAC-BUILD-RUNBOOK.md`](MAC-BUILD-RUNBOOK.md) | Historical for version claims | [`runbooks/update.md`](runbooks/update.md), [`ENTERPRISE_RELEASE.md`](ENTERPRISE_RELEASE.md) |
| [`qa/2026-07-13-full-app-qa.md`](qa/2026-07-13-full-app-qa.md), [`qa/audit-2026-08-10.md`](qa/audit-2026-08-10.md), [`qa/audit-2026-08-29-product-review.md`](qa/audit-2026-08-29-product-review.md) | Point-in-time | [`qa/BUG-LEDGER.md`](qa/BUG-LEDGER.md), [`runbooks/qa.md`](runbooks/qa.md) |
| [`security/AUDIT-10.md`](security/AUDIT-10.md), [`security/AUDIT-20.md`](security/AUDIT-20.md) | Point-in-time (1.8.1) | [`runbooks/operations.md`](runbooks/operations.md) |
