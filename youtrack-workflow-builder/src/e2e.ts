/**
 * End-to-end: spawns the real MCP server over stdio and drives it like Claude would to build a NEW workflow
 * (customer-support SLA), then re-verifies the exported artefacts from disk. Exit code != 0 on any failure.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { compileWorkflow } from "./compiler.js";
import { runScenario, type Step } from "./scenario.js";
import { YouTrackSim } from "./sim/runtime.js";

const b = (block: string, params?: Record<string, unknown>) => ({ block, params });
const spec = {
  name: "support-sla", title: "Customer support SLA & escalation",
  rules: [
    { id: "vip-priority", title: "VIP customers get High priority and a 4-day SLA", when: b("trigger.issue_created"),
      if: [b("condition.summary_contains", { keywords: ["[vip]"] })], then: [b("action.set_field", { field: "Priority", value: "High" }), b("action.set_due_in_days", { days: 4 }), b("action.add_tag", { tag: "vip" })] },
    { id: "round-robin", title: "Round-robin new tickets across the support team", when: b("trigger.issue_created"), if: [],
      then: [b("action.assign", { mode: "round_robin", logins: ["ann", "ben", "cat"], onlyIfEmpty: true })] },
    { id: "waiting-needs-reason", title: "Gate: 'Waiting' requires a Customer field", when: b("trigger.field_changed", { field: "State", to: "Waiting" }), if: [],
      then: [b("action.require_field", { field: "Customer", message: "Fill in Customer before waiting on them." })] },
    { id: "reply-resumes", title: "Customer reply moves Waiting → Open and pings assignee", when: b("trigger.comment_added", { byReporter: true }),
      if: [b("condition.field_is", { field: "State", values: ["Waiting"] })], then: [b("action.set_field", { field: "State", value: "Open" }), b("action.notify", { to: "assignee", subject: "Reply on {{issue.id}}", body: "{{issue.reporter}} answered." })] },
    { id: "sla-breach", title: "SLA breach: escalate once and alert the lead", when: b("trigger.schedule_overdue"), if: [b("condition.has_tag", { tag: "breached", negate: true })],
      then: [b("action.add_tag", { tag: "breached" }), b("action.escalate_priority", { ladder: ["Low", "Normal", "High", "Urgent"] }), b("action.notify", { to: "lead", subject: "SLA breach {{issue.id}}", body: "{{issue.summary}} ({{issue.assignee}})" })] },
    { id: "auto-close-waiting", title: "Close tickets waiting on customer for 14 days", when: b("trigger.schedule_stale", { days: 14, states: ["Waiting"] }), if: [],
      then: [b("action.set_field", { field: "State", value: "Closed" }), b("action.add_comment", { text: "Closed automatically after 14 days without a reply." })] },
  ],
};
const project = {
  project: "SUP", resolvedStates: ["Closed"],
  schema: { State: { type: "state", values: ["Open", "Waiting", "Closed"] }, Priority: { type: "enum", values: ["Low", "Normal", "High", "Urgent"] }, Assignee: { type: "user" }, Customer: { type: "string" }, "Due Date": { type: "date" } },
  users: [{ login: "ann" }, { login: "ben" }, { login: "cat" }, { login: "lead" }, { login: "cust" }],
};
const scenario: Step[] = [
  { op: "create", as: "t1", summary: "[VIP] Cannot log in", reporter: "cust", expect: { fields: { Priority: "High", Assignee: "ben" }, tagsInclude: ["vip"], dueInDays: 4 } },
  { op: "create", as: "t2", summary: "Question about invoice", reporter: "cust", fields: { Priority: "Normal" }, expect: { fields: { Assignee: "cat" }, tagsExclude: ["vip"] } },
  { op: "update", issue: "t2", actor: "cat", fields: { State: "Waiting" }, expect: { blocked: "Fill in Customer before waiting on them.", fields: { State: "Open" } } },
  { op: "update", issue: "t2", actor: "cat", fields: { State: "Waiting", Customer: "ACME" }, expect: { blocked: false, fields: { State: "Waiting" } } },
  { op: "update", issue: "t2", actor: "ann", comment: "internal note", expect: { fields: { State: "Waiting" }, notifications: 0 } },
  { op: "update", issue: "t2", actor: "cust", comment: "here is the invoice", expect: { fields: { State: "Open" }, notifications: 1 } },
  { op: "update", issue: "t1", actor: "ben", fields: { "Due Date": 0 }, expect: {} },
  { op: "advance", days: 2 },
  { op: "schedule", rule: "sla-breach", expect: { notifications: 1, ruleRan: ["sla-breach"] } },
  { op: "schedule", rule: "sla-breach", expect: { notifications: 0 } },
  { op: "update", issue: "t2", actor: "cat", fields: { State: "Waiting" }, expect: { blocked: false } },
  { op: "advance", days: 15 },
  { op: "schedule", rule: "auto-close-waiting", expect: { fields: { State: "Closed" }, commentLast: "Closed automatically after 14 days without a reply." } },
];

let failures = 0;
const check = (name: string, ok: boolean, extra?: unknown) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) { failures++; if (extra) console.log("      ", JSON.stringify(extra).slice(0, 600)); } };

const client = new Client({ name: "e2e-claude", version: "1" });
await client.connect(new StdioClientTransport({ command: "npx", args: ["tsx", "src/mcp/server.ts"], cwd: process.cwd() }));
const call = async (name: string, args: Record<string, unknown>) => { const r: any = await client.callTool({ name, arguments: args }); let j: any = r.content[0].text; try { j = JSON.parse(j); } catch {} return { err: !!r.isError, j }; };

check("MCP stdio handshake lists 9 tools", (await client.listTools()).tools.length === 9);
check("catalog has ≥ 25 blocks", (await call("list_blocks", {})).j.length >= 25);

// 1. first draft contains a deliberate mistake (unknown value 'Blocker'); the loop must catch & recover.
const flawed = JSON.parse(JSON.stringify(spec)); flawed.rules[0].then[0].params.value = "Blocker";
const v1 = await call("validate_workflow", { spec: flawed });
check("validation passes structurally for the flawed draft", !v1.err);
const s1 = await call("simulate_workflow", { spec: flawed, scenario, project });
check("simulation REJECTS the flawed draft (project has no value 'Blocker')", s1.err && /no value 'Blocker'/.test(JSON.stringify(s1.j)), s1.j);

// 2. an invalid block is rejected by validate
const v2 = await call("validate_workflow", { spec: { ...spec, rules: [{ ...spec.rules[0], then: [b("action.teleport")] }] } });
check("validate rejects unknown block with helpful message", v2.err && /Unknown block 'action.teleport'/.test(JSON.stringify(v2.j)));

// 3. the corrected spec: validate + simulate full scenario
const v3 = await call("validate_workflow", { spec });
check("validate: corrected spec OK, no errors", !v3.err && v3.j.ok, v3.j);
const s3 = await call("simulate_workflow", { spec, scenario, project });
check(`simulate: all ${scenario.length} scenario steps pass`, !s3.err && s3.j.ok, s3.j.failedSteps ?? s3.j);

// 4. negative mutation: break an expectation, simulation must go red (guards against a vacuous harness)
const mutated = JSON.parse(JSON.stringify(scenario)); mutated[0].expect.fields.Assignee = "ann";
const s4 = await call("simulate_workflow", { spec, scenario: mutated, project });
check("mutation test: wrong expectation is detected", s4.err && s4.j.failedSteps[0].step === 1);

// 5. export, then re-verify from disk with a fresh simulator (verification AFTER assembly)
const out = mkdtempSync(join(process.cwd(), ".e2e-out-"));
const ex = await call("export_workflow", { spec, outDir: out.slice(process.cwd().length + 1) });
check("export wrote manifest + one file per rule", !ex.err && ex.j.files.length === spec.rules.length + 1, ex.j);
const dir = join(out, spec.name);
const disk: Record<string, string> = Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
const fresh = compileWorkflow(spec);
const h = (o: Record<string, string>) => createHash("sha256").update(JSON.stringify(Object.entries(o).sort())).digest("hex");
check("exported files are byte-identical to a fresh recompile (deterministic build)", h(disk) === h(fresh.files));
const rerun = runScenario(new YouTrackSim(project as any).load(disk), scenario);
check("re-run of the scenario against the EXPORTED files passes", rerun.ok, rerun.reports.filter((r) => !r.ok));
const man = JSON.parse(disk["manifest.json"]);
check("manifest lists required project fields (State, Priority, Assignee, Customer, Due Date)", ["State", "Priority", "Assignee", "Customer", "Due Date"].every((f) => man.requiredFields.some((x: any) => x.field === f)), man.requiredFields);

// 6. deploy plan only
const dp = await call("deploy_workflow", { spec, dryRun: true });
check("deploy dry-run yields request plan, nothing sent", !dp.err && dp.j.dryRun && dp.j.steps.length === spec.rules.length + 1);

await client.close();
import { rmSync } from "node:fs"; rmSync(out, { recursive: true, force: true });
console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL E2E CHECKS PASSED");
process.exit(failures ? 1 : 0);
