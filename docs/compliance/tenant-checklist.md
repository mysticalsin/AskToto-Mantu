DRAFT — for DPO review, not yet adopted. Prepared 2026-07-11.

# Tenant-Side Checklist (IT / M365 Admin — outside the app)

None of these items can be implemented by AskToto itself; they are Microsoft 365 / Dust.tt tenant
configuration, owned by IT, and are prerequisites for (or ongoing controls around) the data flow described
in [`data-flow-onepager.md`](./data-flow-onepager.md) and the risks in [`dpia.md`](./dpia.md).

| # | Action | Owner | Trigger | Status |
|---|---|---|---|---|
| 1 | Apply a Microsoft Purview sensitivity auto-label (e.g. `Confidential\Meeting-AI`) to the `Métis Meetings` OneDrive folder | IT / M365 admin | Before any Phase 5 publishing is enabled; recommended now regardless | Not started |
| 2 | Restrict the folder's ACL to the Chief of Staff + the Dust service identity only (no broader tenant read access) | IT / M365 admin | Before Phase 5 `publishBrainPages` is ever turned on | Not started |
| 3 | Run a Purview oversharing data-risk assessment on the folder (confirm no unintended broad sharing exists today) | IT / Information Security | Now — this is a check on current state, not a Phase 5 dependency | Not started |
| 4 | Add a DLP policy so Microsoft Copilot cannot summarize/surface the labeled meeting-intelligence files outside the intended AskToto/Dust flow | IT / M365 admin | Before Phase 5 publishing | Not started |
| 5 | Verify Dust.tt's Article 28 DPA is in place, confirm EU hosting (workspace pinned to `eu.dust.tt`, not the default `dust.tt`), and confirm a contractual no-training clause on this content | IT / Legal | Before Phase 5 publishing; also relevant to today's existing Dust Q&A usage | Not started — see open question in [`README.md`](./README.md) |
| 6 | Confirm Mantu's existing Microsoft 365 DPA explicitly covers this content class (AI-derived personal-data profiles of business contacts), not just generic file storage | Legal | Now | Not started |
| 7 | Inventory the cloud LLM providers actually enabled in Settings (of the 17 remote ones in `src/shared/providers.ts`) and confirm SCC/adequacy coverage for each, or restrict by policy to EU-hosted/adequate providers only (Mistral; Dust via `eu.dust.tt`). If Cloudflare is enabled, also record **which Cloudflare account hosts the operator's Worker**, whether that account's AI Gateway logs prompts, and which upstream labs the configured model ids resolve to | IT / Legal | Now — this is a live gap, not a Phase 5 dependency | Not started — see [`article-30-record.md`](./article-30-record.md) |
| 8 | Record the M365 DPA reference and the Dust DPA reference in Mantu's Art 30 register, cross-linked to [`article-30-record.md`](./article-30-record.md) | Legal | Alongside DPIA sign-off | Not started |

## Notes

- Items 1, 2, 4, 5 are specifically **pre-conditions for Phase 5** (`publishBrainPages`) — the app-level
  consent gate and confidential flag (Phase 5, planned) are necessary but not sufficient; without these
  tenant controls, a plaintext folder read by a Dust service identity is only as safe as the surrounding
  OneDrive ACLs.
- Items 3, 6, 7 apply **today**, independent of Phase 5, because encrypted transcripts and cloud-LLM
  provider selection are already live features.
- This checklist should be re-verified whenever the meetings folder path changes (user-configurable via
  `meetingsFolder` setting) since the ACL/label work is folder-specific, not app-specific.
