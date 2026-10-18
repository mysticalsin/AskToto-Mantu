# Data protection impact assessment worksheet

Uncompleted public template. No controller, legal basis, deployment approval or residual-risk acceptance
is asserted. Retain completed assessments and organizational history privately.

## Processing and necessity

Record purpose, controller/processor roles, user population, participant categories, jurisdictions,
meeting types, capture/import modes, data categories (including incidental sensitive data), and intended
outputs. Compare manual notes, minimized transcripts and local processing; document why each retained
field and recipient is necessary. Assess employee/candidate power imbalance separately.

## Flow and recipients

Use the [data-flow inventory](data-flow-onepager.md) and [processing record](article-30-record.md).
Inventory configured cloud, CLI, proxy and custom endpoints, sync clients, connector identities and
subprocessors. Verify contractual terms, transfer mechanisms, location, logging and training/retention
settings per actual deployment; a provider label is insufficient evidence.

## Risks and evidence required

| Risk | Safeguard and verification questions |
|---|---|
| Unannounced capture or objection ignored | How are participants informed, required permissions obtained, capture stopped and notice evidence retained? |
| External disclosure | Verify routing, redaction limits, proxy logs, ACLs, publication controls and confidential-meeting handling. |
| Device loss or unauthorized access | Verify encryption/key protection, IPC boundaries, storage permissions and audit behavior. |
| Data loss or inaccessible encrypted profiles | Demonstrate existing-profile upgrade, backup restore, recovery and rollback without losing data or exposing plaintext. |
| Excessive retention or incomplete deletion | Define artifact-specific retention; verify deletion across files, indexes, sync, backups and connectors. |
| Incorrect or injected AI output | Treat meeting text as untrusted; verify source attribution and require human review before consequential use. |
| Expanded use or employee monitoring | Reassess purpose, applicable consultation, lawful basis and AI obligations before enabling the change. |

For each row record owner, source/configuration evidence, packaged test result, remaining gap and
residual-risk decision. A proposed safeguard is not a completed control. Do not assign retention periods,
assume anonymous data after secret redaction, or claim recovery from encryption alone.

## Approval record (private)

Record reviewer roles, unresolved questions, consultation requirements, suspension criteria and review
triggers. Link [recording policy](recording-policy.md), [LIA](legitimate-interest-assessment.md),
[AI review](ai-act-checklist.md) and [administrator evidence](tenant-checklist.md). Leave approval open
until the deployment's evidence and responsible reviewers support it.
