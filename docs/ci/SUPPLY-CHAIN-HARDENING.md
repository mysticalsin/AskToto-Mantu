# Supply-chain hardening (M2-0049)

Actions are pinned by commit SHA, workflows declare least-privilege `permissions:`, gitleaks scans `docs/**.md`,
Dependabot covers npm and actions weekly, and CODEOWNERS is in place. Two follow-ups need a repository admin
and cannot be done from a pull request. Each is recorded on its own line below.

LEAD_ACTION: request branch protection on main (required status checks: Quality checks ubuntu + windows; no force-push, no deletion, enforced for admins) via repo Settings -> Branches or `gh api -X PUT repos/{owner}/{repo}/branches/main/protection`; if HTTP 403 (plan tier), record it as BLOCKED_EXTERNAL

LEAD_ACTION: merge in queue order M2-0047 -> 0048 -> 0053 -> 0049 -> 0050 -> 0051 -> 0052 (the queue enforces ticket dependencies)
