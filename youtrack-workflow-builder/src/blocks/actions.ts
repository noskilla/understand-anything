import { z } from "zod";
import type { Block, ActionOut, FieldType } from "../types.js";
import { FieldName, Login, Template, Value, q, tpl } from "./util.js";

type A = Block<"action", ActionOut>;
const defKind = (f: string): FieldType => (f === "State" ? "state" : "enum");
const userExpr = (to: string) =>
  to === "assignee" ? "issue.fields.Assignee" : to === "reporter" ? "issue.reporter" : to === "current_user" ? "ctx.currentUser" : `entities.User.findByLogin(${q(to)})`;

export const actions: A[] = [
  {
    id: "action.set_field", kind: "action", title: "Set field",
    description: "Set a field to a value. Enum/state fields use declared values; string/integer set literals. onlyIfEmpty avoids overwriting.",
    inspiredBy: ["Jira Automation: Edit issue", "Asana: Set custom field", "ClickUp: Change status/priority", "Monday.com: Change column"],
    params: z.object({ field: FieldName, value: z.union([Value, z.number()]), kind: z.enum(["state", "enum", "string", "integer"]).optional(), onlyIfEmpty: z.boolean().default(false) }).strict(),
    example: { field: "State", value: "In Progress" },
    render: (p) => {
      const kind: FieldType = p.kind ?? (typeof p.value === "number" ? "integer" : defKind(p.field));
      const rhs = kind === "state" || kind === "enum" ? `ctx[${q(p.field)}][${q(String(p.value))}]` : kind === "integer" ? String(Number(p.value)) : q(String(p.value));
      const set = `issue.fields[${q(p.field)}] = ${rhs};`;
      return { code: p.onlyIfEmpty ? `if (isEmptyField(issue, ${q(p.field)})) { ${set} }` : set, needs: [{ field: p.field, type: kind, values: kind === "state" || kind === "enum" ? [String(p.value)] : undefined }] };
    },
  },
  {
    id: "action.assign", kind: "action", title: "Assign",
    description: "Set Assignee: a fixed login, the reporter, the acting user, unassigned, or deterministic round-robin over `logins` (by issue number).",
    inspiredBy: ["Jira Automation: Assign issue", "Linear: triage auto-assign / round-robin", "Asana: Assign to", "GitHub: CODEOWNERS-style routing"],
    params: z.object({ mode: z.enum(["login", "reporter", "current_user", "unassigned", "round_robin"]), login: Login.optional(), logins: z.array(Login).min(1).max(30).optional(), onlyIfEmpty: z.boolean().default(false) })
      .strict().refine((p) => (p.mode === "login" ? !!p.login : p.mode === "round_robin" ? !!p.logins : true), "mode needs login / logins"),
    example: { mode: "round_robin", logins: ["alice", "bob"], onlyIfEmpty: true },
    render: (p) => {
      const rhs = p.mode === "login" ? `entities.User.findByLogin(${q(p.login)})` : p.mode === "reporter" ? "issue.reporter" : p.mode === "current_user" ? "ctx.currentUser"
        : p.mode === "unassigned" ? "null" : `entities.User.findByLogin(${JSON.stringify(p.logins)}[issue.numberInProject % ${p.logins?.length}])`;
      const set = `issue.fields.Assignee = ${rhs};`;
      return { code: p.onlyIfEmpty ? `if (isEmptyField(issue, 'Assignee')) { ${set} }` : set, needs: [{ field: "Assignee", type: "user" }] };
    },
  },
  {
    id: "action.route_by_field", kind: "action", title: "Route to owner by field value",
    description: "Assign by lookup table, e.g. Subsystem → owning engineer; optional fallback login.",
    inspiredBy: ["Jira: component lead auto-assign", "Zendesk: group routing", "GitHub: CODEOWNERS"],
    params: z.object({ field: FieldName, map: z.record(Login).refine((m) => Object.keys(m).length > 0 && Object.keys(m).length <= 50), fallback: Login.optional() }).strict(),
    example: { field: "Subsystem", map: { Backend: "alice", UI: "bob" }, fallback: "carol" },
    render: (p) => ({
      code: `{ var owners = ${JSON.stringify(p.map)}; var o = owners[fv(issue, ${q(p.field)})]${p.fallback ? ` || ${q(p.fallback)}` : ""}; if (o) { issue.fields.Assignee = entities.User.findByLogin(o); } }`,
      needs: [{ field: "Assignee", type: "user" }, { field: p.field, type: "enum", values: Object.keys(p.map) }],
    }),
  },
  {
    id: "action.add_tag", kind: "action", title: "Add tag", description: "Attach a tag to the issue.",
    inspiredBy: ["Trello: add label", "Jira: add labels", "GitHub: add label"],
    params: z.object({ tag: Value }).strict(), example: { tag: "needs-triage" },
    render: (p) => ({ code: `issue.addTag(${q(p.tag)});`, needs: [] }),
  },
  {
    id: "action.remove_tag", kind: "action", title: "Remove tag", description: "Detach a tag from the issue.",
    inspiredBy: ["Trello: remove label", "Jira: remove labels"],
    params: z.object({ tag: Value }).strict(), example: { tag: "blocked" },
    render: (p) => ({ code: `issue.removeTag(${q(p.tag)});`, needs: [] }),
  },
  {
    id: "action.add_comment", kind: "action", title: "Add comment",
    description: "Post a comment. Placeholders: {{issue.id}} {{issue.summary}} {{issue.reporter}} {{issue.assignee}} {{issue.project}} {{currentUser}} {{field:Name}}.",
    inspiredBy: ["Jira Automation: Add comment", "Asana: Add comment", "Zendesk: auto-reply"],
    params: z.object({ text: Template }).strict(), example: { text: "Moved to {{field:State}} by {{currentUser}}." },
    render: (p) => ({ code: `issue.addComment(${tpl(p.text)});`, needs: [] }),
  },
  {
    id: "action.notify", kind: "action", title: "Notify user",
    description: "Send an email/in-app notification to assignee, reporter, acting user, or a login.",
    inspiredBy: ["Jira Automation: Send email", "Asana: Add follower / notify", "Monday.com: Notify someone", "Trello Butler: mention member"],
    params: z.object({ to: z.union([z.enum(["assignee", "reporter", "current_user"]), Login]), subject: Template, body: Template }).strict(),
    example: { to: "assignee", subject: "{{issue.id}} is overdue", body: "{{issue.summary}} passed its due date." },
    render: (p) => ({ code: `{ var u = ${userExpr(p.to)}; if (u) { u.notify(${tpl(p.subject)}, ${tpl(p.body)}); } }`, needs: [] }),
  },
  {
    id: "action.message", kind: "action", title: "Show message to user", description: "Show a transient message in the UI of the user who made the change.",
    inspiredBy: ["Jira: validators with feedback", "ClickUp: toast on automation"],
    params: z.object({ text: Template }).strict(), example: { text: "Assigned automatically." },
    render: (p) => ({ code: `workflow.message(${tpl(p.text)});`, needs: [] }),
  },
  {
    id: "action.require_field", kind: "action", title: "Gate: require field",
    description: "Block the change (with message) unless the field has a value — a Definition-of-Done / entry-criteria gate. Pair with trigger.field_changed.",
    inspiredBy: ["Jira: workflow validators / required fields on transition", "Linear: required estimate", "ClickUp: required custom fields in status"],
    params: z.object({ field: FieldName, message: Template }).strict(), example: { field: "Assignee", message: "Assign someone first." },
    render: (p) => ({ code: `workflow.check(!isEmptyField(issue, ${q(p.field)}), ${tpl(p.message)});`, needs: [{ field: p.field, type: "any" }] }),
  },
  {
    id: "action.require_subtasks_resolved", kind: "action", title: "Gate: subtasks must be resolved",
    description: "Block the change unless all subtasks are resolved.",
    inspiredBy: ["Jira: 'Sub-task blocker' validator", "Asana: dependencies must finish", "ClickUp: block close with open subtasks"],
    params: z.object({ message: Template }).strict(), example: { message: "Resolve all subtasks first." },
    render: (p) => ({ code: `workflow.check(every(issue.links['parent for'], function (c) { return c.isResolved; }), ${tpl(p.message)});`, needs: [] }),
  },
  {
    id: "action.wip_limit", kind: "action", title: "Gate: WIP limit per assignee",
    description: "Block moving into `state` if the assignee already has `limit` issues there (Kanban WIP limit).",
    inspiredBy: ["Jira Kanban: column constraints", "Trello Power-Up: list limits", "Linear: cycle capacity"],
    params: z.object({ state: Value, limit: z.number().int().min(1).max(50), message: Template }).strict(),
    example: { state: "In Progress", limit: 3, message: "WIP limit reached." },
    render: (p) => ({
      code: `{ var a = fv(issue, 'Assignee'); if (a) { var n = 0; search.search(issue.project, 'State: ${p.state.includes(" ") ? `{${p.state}}` : p.state} Assignee: ' + a).forEach(function (x) { if (x.id !== issue.id) { n++; } }); workflow.check(n < ${p.limit}, ${tpl(p.message)}); } }`,
      needs: [{ field: "State", type: "state", values: [p.state] }, { field: "Assignee", type: "user" }], requires: ["search"],
    }),
  },
  {
    id: "action.set_due_in_days", kind: "action", title: "Set due date relative to now",
    description: "Set Due Date to now + N days (SLA/target dates). onlyIfEmpty keeps manual dates.",
    inspiredBy: ["Asana Rules: Set due date relative", "Jira SLA goals", "Zendesk SLA policies"],
    params: z.object({ days: z.number().int().min(0).max(365), onlyIfEmpty: z.boolean().default(true) }).strict(), example: { days: 3 },
    render: (p) => { const set = `issue.fields['Due Date'] = Date.now() + ${p.days} * 86400000;`; return { code: p.onlyIfEmpty ? `if (isEmptyField(issue, 'Due Date')) { ${set} }` : set, needs: [{ field: "Due Date", type: "date" }] }; },
  },
  {
    id: "action.escalate_priority", kind: "action", title: "Escalate priority one step",
    description: "Move a field up an ordered ladder (lowest→highest); stays at top.",
    inspiredBy: ["Zendesk: escalation", "Jira Service Mgmt: SLA breach escalation", "PagerDuty: escalation policy"],
    params: z.object({ ladder: z.array(Value).min(2).max(10), field: FieldName.default("Priority") }).strict(), example: { ladder: ["Minor", "Normal", "Major", "Critical"] },
    render: (p) => ({
      code: `{ var ladder = ${JSON.stringify(p.ladder)}; var i = ladder.indexOf(fv(issue, ${q(p.field)})); if (i >= 0 && i < ladder.length - 1) { issue.fields[${q(p.field)}] = ctx[${q(p.field)}][ladder[i + 1]]; } }`,
      needs: [{ field: p.field, type: "enum", values: p.ladder }],
    }),
  },
  {
    id: "action.close_parent_when_children_done", kind: "action", title: "Resolve parent when all subtasks done",
    description: "For each parent of this issue: if all its subtasks are resolved, move parent State to `doneState`.",
    inspiredBy: ["Jira Automation: close parent when all sub-tasks done (most popular recipe)", "Asana: auto-complete parent", "GitHub Projects: tracked-by rollup"],
    params: z.object({ doneState: Value }).strict(), example: { doneState: "Done" },
    render: (p) => ({
      code: `issue.links['subtask of'].forEach(function (parent) { if (!parent.isResolved && every(parent.links['parent for'], function (c) { return c.isResolved; })) { parent.fields.State = ctx.State[${q(p.doneState)}]; } });`,
      needs: [{ field: "State", type: "state", values: [p.doneState] }],
    }),
  },
  {
    id: "action.block", kind: "action", title: "Gate: block the change",
    description: "Unconditionally reject the change with a message. Use with conditions (e.g. 'not in group QA') to build permission gates.",
    inspiredBy: ["Jira: transition conditions by role/group", "ClickUp: restricted status changes", "GitHub: branch protection"],
    params: z.object({ message: Template }).strict(), example: { message: "Only QA may close critical issues." },
    render: (p) => ({ code: `workflow.check(false, ${tpl(p.message)});`, needs: [] }),
  },
];
