---
project: Métis
type: design-system-contract
surface: Review post-meeting ClickUp push
date: 2026-09-02
owner: Tony
status: active contract — implement only what this file states
workspace: "90141511178"
ready-to-merge: no
---

# ClickUp post-meeting push

Tony cannot push a meeting into ClickUp. The current path calls the wrong MCP tool (`attach_task_file`) with `{title, description, project_id}` and ClickUp answers **invalid parameters**. Destination is a blank "project ID" paste. That is the bug.

This file is the gate. Write it before UI. Overlay, Operator, Listen, appearance, pack, and Aria stay out.

## Outcome

After a meeting, Review shows **Push to ClickUp** when ClickUp is connected. Confirm creates a **task** in the last (or connected) list in workspace `90141511178`. The list name is on screen before Confirm. Nothing sends itself. A ClickUp failure is ClickUp's own sentence, not "unknown reason" and not a JSON blob.

Book next steps, when ClickUp is checked, creates one task per action item in that same list. Same tool. Same destination. Same confirm.

## QUALITY hats (fail closed)

| Hat | Ships only if | Rejects |
|---|---|---|
| Product | Confirm creates a task in a named list. Destination is automatic. | Attaching a file. Asking Tony to paste a list/project ID as the common path. A tool dropdown that includes `attach_task_file`. |
| Destination | Screen says `Task in {list name}` (space › folder › list when known) before Confirm. | Empty destination. Silent first-list. "Project ID (optional)". |
| Tool | Wire tool is create-task (`clickup_create_task` / `create_task`). Args: `name`, `list_id`, optional `markdown_description`, `workspace_id`. | `attach_task_file`, comment, update, delete. Args `title` / `project_id` / `description` as the ClickUp wire names. |
| Trust | Confirm click only. Confidential still blocked. | `useEffect` / mount / timer / Intelligence index / import calling `mcpPush`. |
| Failure | Review shows ClickUp's error text (capped). OAuth mismatch uses PR 73's human sentence. | Swallowed MCP `isError`. Generic "unknown reason". Raw `{"error":"invalid_client",…}` blob. |
| Scope | Review ClickUp push + ClickUp OAuth redirect (PR 73) + write-tool pick. Polo, Plane paste field, overlay, Operator, Listen, appearance, pack, Aria untouched. | Overlay chrome. Operator Worker. Pack. Merge. READY TO MERGE: yes. |

Would Apple ship this? Only if every hat passes.

## Destination (automatic)

Workspace is pinned: `90141511178`. Never a renderer-supplied workspace.

Main (not Review) resolves the list, in this order:

1. **Last successful list** on this seat (`clickupListId` / `clickupListName` on the ClickUp `mcpConnections` row). Written only after ClickUp accepted a create-task. Renderer cannot patch it (`mcpConnections` stays stripped on `settings:set`).
2. Else **last-updated list** in that workspace: MCP `filter_tasks` (or the vendor's equivalent) ordered by `updated` descending. The list of the first task is the destination.
3. Else fail loud: `ClickUp has no list in this workspace. Create a list in ClickUp, then Reconnect.`

Do not invent a Métis Inbox. Do not default to "Get Started with ClickUp" unless that list actually won (1) or (2).

Review copies the resolved name. If name is still empty after connect, show `ClickUp could not name the destination.` and disable Confirm — never a silent push.

## Wire

ClickUp MCP is `https://mcp.clickup.com/mcp` (already pinned). OAuth is PR 73: bind loopback first, DCR-register **this run's** `http://127.0.0.1:<port>/callback`, never reuse a portless cached `client_id` for `/authorize`. Humanize `invalid_client` / `redirect_uri`. Do not re-invent Connect.

On Confirm, main:

1. Ignores a renderer tool named attach / file / comment.
2. Picks create-task from the saved `tools` list. Missing → `ClickUp did not offer a create-task tool. Reconnect ClickUp in Settings.`
3. Resolves `list_id` as above. Missing → the destination failure above.
4. Calls the tool with `{ name, list_id, markdown_description?, workspace_id: "90141511178" }`.
5. On MCP `isError` or thrown error, return ClickUp's text (slice 500). Do not map a tool error into `classifyError`'s "unknown reason".
6. On success, persist that list as last, return `{ ok: true, destinationName, taskUrl? }`.

`pickWriteTool(..., 'next-steps')` must never return a name matching `attach` or `file`. Prefer `/create_task/`. `isWriteToolName('clickup_attach_task_file')` is false.

## Review chrome

When ClickUp is connected and the recap is ready:

- Chip **Push to ClickUp** (not Polo's "Push to CRM"). Polo stays BidStack-only.
- Open panel: destination line, payload preview (task name = meeting title, body = recap), Confirm / Cancel.
- No MCP tool `<select>`. No list-id input.
- Error in danger type, with ClickUp's sentence.
- Success: `Created in {list name}.` plus URL if ClickUp returned one.

Book next steps: ClickUp card has no tool dropdown and no project-ID paste. Destination line is the same named list. Plane's optional project id stays as it is.

Disconnected ClickUp: Settings copy already says Connect. Review does not pretend a send happened.

## Never auto-send

No `useEffect`, timer, mount, Intelligence pass, or import job may call `mcpPush` or ClickUp connect. Recap generation is not a push.

## Out of scope

- Overlay hide / island / bar, onboarding, starfield, Jarvis pill, thinking-orbs, Goldberg Aria.
- Operator Worker, Listen ASR, appearance / Other-providers logos.
- Pack, version bump, merge. **READY TO MERGE: no.**
- Polo payload shape. Plane OAuth.

## Tests (required)

1. `pickWriteTool` / `pickClickupCreateTask`: `clickup_attach_task_file` is never chosen; `clickup_create_task` is.
2. ClickUp push args are `name` + `list_id` (+ markdown_description, workspace_id). Never `title`/`project_id` as the wire keys.
3. Destination order: saved last list, else last-updated task list, else loud error.
4. MCP `isError` text reaches the result. Unknown-reason classify does not eat a ClickUp tool error.
5. Review source: ClickUp panel has no `attach_task_file` select and no `project ID` placeholder; shows `Task in`.
6. No `useEffect` in Review calls `mcpPush`.
7. PR 73 OAuth: DCR body is this run's ported URI; cached portless client_id is not reused; `invalid_client` maps to a human sentence.
8. Overlay / Operator / Listen / appearance / Aria files are not in the diff.
