# License service source reference

Public source-version worksheet; no service is started, configured, deployed or approved by this document. Inspect this version's service entry point and configuration before relying on any API or storage behavior.

MQA-068: `LICENSE_ENFORCEMENT = false` and `LICENSE_UI_ENABLED = false`; the device license gate is compiled off. A setting or separately deployed service does not activate these compiled-out paths. Do not advertise activation, seats or revocation as installed-app controls.

Keep signing/admin keys, account records, licence stores, audit/export files and backups outside public source history. Use least privilege, authenticated administrative endpoints, persistence and verified backups. Before any migration preserve originals and demonstrate restore, record compatibility and guarded rollback; never assume old/new formats interchangeable. Verify exact-version authentication, concurrency, error handling, expiry/revocation and data-preservation evidence. No paid, production, infrastructure or permission action is authorized here.
