# Licensing implementation status

Public technical assessment input; no commercial plan, customer account, hosted-service status or deployment approval.

MQA-068: `LICENSE_ENFORCEMENT = false` and `LICENSE_UI_ENABLED = false`; the device license gate is compiled off. A setting or separately deployed service does not activate these compiled-out paths. Do not advertise activation, seats or revocation as installed-app controls.

Preserve issuer/verifier contracts, signature checks, expiry/revocation checks and negative tests. A separate service capability does not establish desktop enforcement. Do not invent accepted licence lifetimes from unrelated issuance defaults. Keep keys, stores, activation records, logs and backups private. Qualification requires exact-version retained evidence.
