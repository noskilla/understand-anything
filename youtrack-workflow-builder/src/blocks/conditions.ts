import { z } from "zod";
import type { Block, CondOut } from "../types.js";
import { BlockInstanceSchema } from "../types.js";
import { FieldName, Login, Value, q } from "./util.js";

type C = Block<"condition", CondOut>;
const fieldType = (f: string) => (f === "State" ? "state" : f === "Assignee" ? "user" : "enum") as "state" | "user" | "enum";

export const conditions: C[] = [
  {
    id: "condition.field_is", kind: "condition", title: "Field is one of",
    description: "True when the field's current value is one of `values` (use negate for 'is none of').",
    inspiredBy: ["Jira Automation: Issue fields condition", "Asana: Task has custom field value", "ClickUp: If field equals"],
    params: z.object({ field: FieldName, values: z.array(Value).min(1).max(20), negate: z.boolean().default(false) }).strict(),
    example: { field: "Priority", values: ["Critical", "Major"] },
    render: (p, _c) => ({
      expr: `${p.negate ? "!" : ""}[${p.values.map(q).join(", ")}].indexOf(fv(issue, ${q(p.field)})) >= 0`,
      needs: [{ field: p.field, type: fieldType(p.field), values: p.values }],
    }),
  },
  {
    id: "condition.field_empty", kind: "condition", title: "Field is empty / set",
    description: "empty=true → field has no value; empty=false → field has a value.",
    inspiredBy: ["Jira Automation: field is empty", "Asana: Task is unassigned", "Linear: no assignee/estimate"],
    params: z.object({ field: FieldName, empty: z.boolean().default(true) }).strict(), example: { field: "Assignee", empty: true },
    render: (p) => ({ expr: `${p.empty ? "" : "!"}isEmptyField(issue, ${q(p.field)})`, needs: [{ field: p.field, type: "any" }] }),
  },
  {
    id: "condition.has_tag", kind: "condition", title: "Has tag",
    description: "True when the issue carries (or lacks, with negate) the given tag.",
    inspiredBy: ["Trello Butler: card has label", "Jira: labels condition", "GitHub: has label"],
    params: z.object({ tag: Value, negate: z.boolean().default(false) }).strict(), example: { tag: "blocked" },
    render: (p) => ({ expr: `${p.negate ? "!" : ""}hasTag(issue, ${q(p.tag)})`, needs: [] }),
  },
  {
    id: "condition.summary_contains", kind: "condition", title: "Summary contains keyword",
    description: "Case-insensitive match of any keyword in the summary (keyword triage, e.g. 'crash', 'outage').",
    inspiredBy: ["Zendesk triggers: subject contains", "Jira Automation: smart value contains", "Linear: triage rules"],
    params: z.object({ keywords: z.array(z.string().regex(/^[\w \-\[\]]{1,40}$/, "keyword: letters, digits, space, - [ ] only (max 40)")).min(1).max(20) }).strict(), example: { keywords: ["crash", "outage"] },
    render: (p) => ({ expr: `containsAny(issue.summary, ${JSON.stringify(p.keywords)})`, needs: [] }),
  },
  {
    id: "condition.current_user_in_group", kind: "condition", title: "Acting user is in group",
    description: "True when the user making the change belongs to the YouTrack group (role gate).",
    inspiredBy: ["Jira Automation: User condition", "Jira: Transition permissions", "ClickUp: permissions on automation"],
    params: z.object({ group: Value, negate: z.boolean().default(false) }).strict(), example: { group: "QA" },
    render: (p) => ({ expr: `${p.negate ? "!" : ""}ctx.currentUser.isInGroup(${q(p.group)})`, needs: [] }),
  },
  {
    id: "condition.all_subtasks_resolved", kind: "condition", title: "All subtasks resolved",
    description: "True when the issue has subtasks and every one of them is resolved.",
    inspiredBy: ["Jira Automation: Related issues condition", "Asana: all subtasks complete", "ClickUp: all subtasks done"],
    params: z.object({}).strict(), example: {},
    render: () => ({ expr: "(issue.links['parent for'].isNotEmpty() && every(issue.links['parent for'], function (c) { return c.isResolved; }))", needs: [] }),
  },
  {
    id: "condition.has_subtasks", kind: "condition", title: "Has subtasks",
    description: "True when the issue is a parent of at least one subtask.",
    inspiredBy: ["Jira: issue has subtasks", "Asana: task has subtasks"],
    params: z.object({ negate: z.boolean().default(false) }).strict(), example: {},
    render: (p) => ({ expr: `${p.negate ? "!" : ""}issue.links['parent for'].isNotEmpty()`, needs: [] }),
  },
  {
    id: "condition.all_of", kind: "condition", title: "All of (AND)",
    description: "Nested group: true when every inner condition is true.",
    inspiredBy: ["Jira Automation: condition blocks / AND", "Zendesk: Meet ALL conditions"],
    params: z.object({ conditions: z.array(BlockInstanceSchema).min(1) }).strict(), example: {},
    render: (p, c) => { const r = p.conditions.map((i: any) => c.renderCondition(i)); return { expr: "(" + r.map((x: any) => x.expr).join(" && ") + ")", needs: r.flatMap((x: any) => x.needs) }; },
  },
  {
    id: "condition.any_of", kind: "condition", title: "Any of (OR)",
    description: "Nested group: true when at least one inner condition is true.",
    inspiredBy: ["Jira Automation: if/else, OR", "Zendesk: Meet ANY condition"],
    params: z.object({ conditions: z.array(BlockInstanceSchema).min(1) }).strict(), example: {},
    render: (p, c) => { const r = p.conditions.map((i: any) => c.renderCondition(i)); return { expr: "(" + r.map((x: any) => x.expr).join(" || ") + ")", needs: r.flatMap((x: any) => x.needs) }; },
  },
  {
    id: "condition.not", kind: "condition", title: "Not",
    description: "Negates a single inner condition.",
    inspiredBy: ["Jira Automation: NOT", "Boolean logic in every rule builder"],
    params: z.object({ condition: BlockInstanceSchema }).strict(), example: {},
    render: (p, c) => { const r = c.renderCondition(p.condition); return { expr: `!(${r.expr})`, needs: r.needs }; },
  },
];
void Login;
