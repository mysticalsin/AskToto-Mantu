# Privacy and AI deployment assessment templates

These public templates contain no completed organizational assessment, adopted policy or legal approval.
Complete deployment-specific records privately with the responsible privacy, security and legal reviewers.
Do not infer lawful basis, AI risk classification, provider geography or compliance from product design.
Use the exact source commit, installed artifacts, configured features and observed deployment evidence.

| Template | Purpose |
|---|---|
| [DPIA](dpia.md) | Processing scope, risks, safeguards and residual-risk decisions |
| [Legitimate-interest assessment](legitimate-interest-assessment.md) | Purpose, necessity and balancing questions if that basis is proposed |
| [Processing record](article-30-record.md) | Controller, recipients, transfers and retention inventory |
| [Recording policy](recording-policy.md) | Notice, objections, permitted uses and retention decisions |
| [AI assessment checklist](ai-act-checklist.md) | Classification and obligation review without a predetermined conclusion |
| [Data-flow inventory](data-flow-onepager.md) | Local, network, synced-storage and integration boundaries |
| [Administrator checklist](tenant-checklist.md) | Deployment configuration and evidence collection |

The provider inventory is [src/shared/providers.ts](../../src/shared/providers.ts); counts and routing can
change. A local provider selection does not establish that every other feature is offline. Distinguish
implemented controls from configured controls and from controls verified in a packaged installation.
Reassess on changes to recipients, capture mode, publication, storage, retention, models or user population.
