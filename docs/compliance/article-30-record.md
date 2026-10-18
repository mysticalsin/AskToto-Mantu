# Processing-record worksheet

Uncompleted public template. Complete and retain controller identities, contacts and approvals privately.
This document does not register a particular organization's processing or establish a lawful basis.

| Field | Deployment evidence to record |
|---|---|
| Controller / processors / contacts | Exact legal roles and private contact record |
| Purposes and lawful basis | Assessment per use case; link completed LIA/DPIA where applicable |
| Participants and data | Meeting participants, transcript, recap, extracted entities, calendar metadata, logs and incidental sensitive data |
| Recipients | Enabled provider routes, CLI backends, sync storage, publication connectors and support access |
| Transfers | Actual endpoints, subprocessors, contractual mechanisms, regions, logging and training settings |
| Retention and deletion | Period and justification per artifact; tested deletion including indexes, sync and backups |
| Security measures | Verified encryption/key custody, access controls, IPC boundaries, audit and recovery evidence |
| Human review | Review before relying on AI-generated claims or consequential actions |
| Ownership and review | Responsible reviewers, unresolved gaps and change triggers |

## Version-specific provider inventory input

Read [providers.ts](../../src/shared/providers.ts) for the exact source register. Provider IDs in this
source version: `anthropic`, `openai`, `nvidia`, `deepseek`, `qwen`, `minimax`, `kimi`, `openrouter`, `groq`, `mistral`, `grok`, `dust`, `claude-cli`, `codex-cli`, `gemini`, `cloudflare`, `local`, `custom`.
API/custom routes can disclose meeting prompts and content. Local CLI subprocesses can invoke remote
services; inventory their authentication and service configuration too. A local provider does not prove
all app traffic is local. For `cloudflare`, inspect the operator Worker and upstream routing separately;
see [Cloudflare guide](../CLOUDFLARE.md) where present. Inventory sync clients and connectors independently.
Do not infer a DPA, location, training restriction or transfer mechanism from a provider name.
Secret-pattern redaction does not anonymize meeting content.
