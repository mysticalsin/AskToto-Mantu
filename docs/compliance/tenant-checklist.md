# Administrator deployment evidence checklist

Uncompleted public template. Keep tenant identities, private configuration, agreements, findings and
approval records outside the public repository. No tenant controls or agreements are assumed in place.

- [ ] Identify storage roots and sync behavior; verify user, service identity and group ACLs.
- [ ] Verify sharing, labels, DLP and connector scope against actual files and plaintext publication paths.
- [ ] Inventory configured API, CLI, custom and proxy recipients from [providers.ts](../../src/shared/providers.ts).
      For Cloudflare record Worker ownership, upstream model route and prompt logging.
- [ ] Review processor terms, subprocessors, regions, transfer mechanisms, retention and training settings
      per actual service configuration; do not infer these from an EU workspace option or provider name.
- [ ] Verify encryption/key custody, endpoint security, recovery/rollback and incident responsibilities.
- [ ] Complete recording notice, objection handling, permitted-use and retention decisions privately.
- [ ] Verify packaged capture, confidentiality, publication gates, deletion and audit behavior before approval.
- [ ] If calendar sign-in is used, review registration, scopes and tenant/domain restrictions using the
      [deployment prerequisites](../MANTU-IT-REQUEST.md).
- [ ] Record source commit, artifact hashes, verification results, unresolved gaps and review owners.

Recheck when folders, sharing, recipients, models, capture modes or user population change. App settings
alone do not establish tenant ACLs, legal approval or protection against a separately configured connector.
See [DPIA](dpia.md), [processing record](article-30-record.md) and
[data-flow inventory](data-flow-onepager.md).
