# YouTrack Workflow Builder (Claude + MCP)

Claude composes **YouTrack workflows from tested building blocks** through an MCP server, verifies them in a runtime simulator, and only then exports/deploys.

```
 plain-language process ──Claude──▶ WorkflowSpec (JSON of blocks)
                                        │ validate_workflow   schema · block params · field-type consistency · gate lint · JS syntax
                                        │ compile_workflow    ──▶ one YouTrack JS module per rule + manifest.json
                                        │ simulate_workflow   ──▶ executes the generated JS in a sandboxed YouTrack runtime model
                                        │ export_workflow     ──▶ out/<name>/*.js  (re-verifiable from disk)
                                        ▼ deploy_workflow     ──▶ REST plan (dry-run default) / real deploy (confirm + env creds)
```

* `src/blocks/` — 9 triggers, 10 conditions, 15 actions ([catalogue](docs/BLOCKS.md)); every block records which popular PM tool recipe it was distilled from (Jira Automation, Asana Rules, Linear, ClickUp, Monday.com, Trello Butler, GitHub Projects, Zendesk).
* `src/compiler.ts` — spec → YouTrack JS (`entities.Issue.onChange` / `onSchedule`, generated `requirements`). All user strings go through `JSON.stringify`; names/queries/templates are whitelisted, so a spec cannot inject code.
* `src/sim/` — runtime model: transactions with rollback on `workflow.check`, `isChanged/oldValue/becomes*`, tags, comments, subtask links, `search.search`, cron-style schedule runs with a controllable clock, project-schema `requirements` check (unknown field/value ⇒ load error).
* `src/scenario.ts` — scenario DSL with assertions (fields, tags, blocked message, notifications, due date, rule ran/not ran).
* `src/mcp/server.ts` — tools `list_blocks, describe_block, get_spec_schema, get_example_workflow, validate_workflow, compile_workflow, simulate_workflow, export_workflow, deploy_workflow`; prompt `build_youtrack_workflow` (the procedure Claude follows); resource `yt://blocks/catalog`.
* `src/examples/software-delivery.ts` — a 17-rule workflow (triage routing, incident keywords, SLA, self-assign, WIP limit, Done gates, QA-only close, parent roll-up, blocked tagging, reopen on customer reply, stale/auto-close, due-soon, overdue escalation, cleanup).

## Use
```bash
cd youtrack-workflow-builder && npm install
cp .mcp.json.example ../.mcp.json    # or add the server to your Claude config; then ask Claude:
#   /mcp__youtrack-workflow-builder__build_youtrack_workflow goal="…"
npm test          # 29 unit/integration tests (incl. the 17-rule workflow, MCP in-memory, mock REST deploy)
npm run e2e       # real stdio MCP server driven by a client; builds a 2nd workflow, mutation check, re-verifies exported files
```

## What is and is not verified
Verified automatically (tests + e2e): block rendering, JS syntax, injection resistance, rule behaviour in the **simulator** (happy paths, gates + rollback, idempotent schedulers, cascades), MCP protocol, determinism of export, deploy request sequence against a **mock** HTTP server.

**Not verified against a live YouTrack** (no instance was reachable from the build sandbox; JetBrains hosts are blocked):
* The simulator is a model of the workflow JS API as documented/remembered — API details (e.g. `issue.hasTag`, `links['parent for']`, `search.search`, value `requirements` syntax, re-trigger semantics: here each rule fires at most once per issue per transaction) must be confirmed once on a sandbox project.
* `deploy_workflow`'s REST contract (`/api/admin/workflows`, `…/rules`, project attach) is unconfirmed; use `export_workflow` and import the folder, or run `deploy_workflow` with `dryRun:true` and compare with your server's REST docs first.
