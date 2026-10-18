# Data-flow inventory and source contracts

Public assessment input, not a deployed-system attestation. For each selected source commit and
installer, record enabled features, settings, endpoints and observed traffic. A local-first design or
selected local model does not establish that every capture, storage or integration path stays local.

## Capture, storage and egress boundaries

| Boundary | Evidence to collect |
|---|---|
| Live/local ASR and imported media | Trace selected mic/system/import path, native helpers, transient buffers, any persisted media and cleanup. Review cloud speech separately if enabled. |
| Meeting storage | Resolve actual `meetingsFolder`, transcript/recap/entity paths and any sync client. Local files may be copied by sync software. |
| Encryption and recovery | Verify configured encryption, key wrapping and OS protections. Test existing-profile upgrade, backup recovery and rollback; do not assume cross-device recovery. |
| Model/provider calls | Inventory prompts, transcript excerpts, screenshots and metadata sent to each selected API, CLI or custom endpoint. Redaction of secret patterns does not anonymize meeting content. |
| Proxy routing | For Cloudflare, record the operator Worker, upstream model route and logging settings; see [CLOUDFLARE.md](../CLOUDFLARE.md). |
| Publication/connectors | Inspect actual publication gates, plaintext outputs, confidential flags and ACLs; inventory what any Dust or other connector can read. Provider Q&A access and folder connector access are separate. |
| External integrations | Graphify is separately installed and opt-in; inspect its backend and network configuration rather than counting it as part of the packaged offline path. |

Provider IDs and protocol kinds are maintained in [providers.ts](../../src/shared/providers.ts).
Use the [processing record](article-30-record.md) for the recipient inventory and
[administrator checklist](tenant-checklist.md) for deployment evidence.

## Version-specific local-model inputs

The Qwen3.5 0.8B default is bundled with its GGUF/projector pair (763,759,712 bytes).
Optional Qwen3.5 4B requires explicit selection and a first-use download (3,584,533,344 bytes)
into the profile. Local AI is off by default and existing selections are preserved; hardware capacity
does not automatically select a larger model. Model downloads use commit-pinned upstream revisions
and byte-size/SHA-256 checks to validate the payload. The compact default is available offline on supported hardware; optional
4B offline use requires pre-placing verified files. A corrupt packaged default requires installer repair.
These source contracts do not qualify any historical release bytes or rewritten source.
