import { z } from "zod";
import type { Block, TriggerOut } from "../types.js";
import { Cron, FieldName, Value, q, qv, qf } from "./util.js";

type T = Block<"trigger", TriggerOut>;
const DAILY = "0 0 9 * * ?";
const STATEISH = (f: string) => (f === "State" ? "state" : "enum") as "state" | "enum";

export const triggers: T[] = [
  {
    id: "trigger.issue_created", kind: "trigger", title: "Issue created",
    description: "Fires once, when an issue is first reported.",
    inspiredBy: ["Jira Automation: Issue created", "Linear: new issue → triage", "Asana: Task added to project", "Trello Butler: card created"],
    params: z.object({}).strict(), example: {},
    render: () => ({ kind: "change", guard: "issue.becomesReported", needs: [] }),
  },
  {
    id: "trigger.field_changed", kind: "trigger", title: "Field changed",
    description: "Fires when a field changes, optionally only to/from a specific value (status moves, priority bumps, reassignments).",
    inspiredBy: ["Jira Automation: Field value changed", "ClickUp: When status changes", "Monday.com: When column changes to", "Asana: Custom field changes"],
    params: z.object({ field: FieldName, to: Value.optional(), from: Value.optional() }).strict(),
    example: { field: "State", to: "In Progress" },
    render: (p) => ({
      kind: "change",
      guard: [`issue.fields.isChanged(${q(p.field)})`, p.to && `fv(issue, ${q(p.field)}) === ${q(p.to)}`, p.from && `ov(issue, ${q(p.field)}) === ${q(p.from)}`].filter(Boolean).join(" && "),
      needs: [{ field: p.field, type: p.field === "Assignee" ? "user" : STATEISH(p.field), values: [p.to, p.from].filter(Boolean) as string[] }],
    }),
  },
  {
    id: "trigger.issue_resolved", kind: "trigger", title: "Issue resolved",
    description: "Fires when an issue moves into a resolved state.",
    inspiredBy: ["Jira Automation: Issue transitioned (Done)", "GitHub Projects: Item closed → Done", "Linear: issue completed"],
    params: z.object({}).strict(), example: {},
    render: () => ({ kind: "change", guard: "issue.becomesResolved", needs: [] }),
  },
  {
    id: "trigger.issue_reopened", kind: "trigger", title: "Issue reopened",
    description: "Fires when a resolved issue becomes unresolved again.",
    inspiredBy: ["GitHub Projects: Item reopened", "Jira Automation: Issue reopened", "Zendesk: ticket reopened"],
    params: z.object({}).strict(), example: {},
    render: () => ({ kind: "change", guard: "issue.becomesUnresolved", needs: [] }),
  },
  {
    id: "trigger.comment_added", kind: "trigger", title: "Comment added",
    description: "Fires when a comment is added; optionally only when written by the reporter (customer reply).",
    inspiredBy: ["Jira Automation: Issue commented", "Zendesk: requester replied", "Linear: comment added"],
    params: z.object({ byReporter: z.boolean().default(false) }).strict(), example: { byReporter: true },
    render: (p) => ({ kind: "change", guard: p.byReporter ? "addedByReporter(issue)" : "issue.comments.added.isNotEmpty()", needs: [] }),
  },
  {
    id: "trigger.schedule_stale", kind: "trigger", title: "Stale issue (scheduled)",
    description: "Daily sweep over unresolved issues untouched for N days, optionally restricted to certain states.",
    inspiredBy: ["Linear: auto-close stale issues", "GitHub: stale bot", "Jira Automation: Scheduled JQL 'updated <= -14d'"],
    params: z.object({ days: z.number().int().min(1).max(365), states: z.array(Value).max(10).optional(), cron: Cron.default(DAILY) }).strict(),
    example: { days: 14, states: ["In Progress"] },
    render: (p) => ({
      kind: "schedule", cron: p.cron, guard: "true",
      search: `#Unresolved updated: *..{minus ${p.days}d}` + (p.states?.length ? ` State: ${p.states.map(qv).join(",")}` : ""),
      needs: p.states?.length ? [{ field: "State", type: "state", values: p.states }] : [],
    }),
  },
  {
    id: "trigger.schedule_due", kind: "trigger", title: "Due date approaching (scheduled)",
    description: "Daily sweep over unresolved issues whose Due Date falls within the next N days (today inclusive).",
    inspiredBy: ["Asana Rules: Due date approaches", "Monday.com: When date arrives", "Trello Butler: due date commands", "ClickUp: Due date arrives"],
    params: z.object({ withinDays: z.number().int().min(0).max(90), cron: Cron.default(DAILY) }).strict(),
    example: { withinDays: 2 },
    render: (p) => ({ kind: "schedule", cron: p.cron, guard: "true", search: `#Unresolved ${qf("Due Date")}: {Today}..{plus ${p.withinDays}d}`, needs: [{ field: "Due Date", type: "date" }] }),
  },
  {
    id: "trigger.schedule_overdue", kind: "trigger", title: "Overdue (scheduled)",
    description: "Daily sweep over unresolved issues whose Due Date is in the past.",
    inspiredBy: ["Jira: overdue filter", "Asana: overdue tasks", "ClickUp: overdue automations"],
    params: z.object({ cron: Cron.default(DAILY) }).strict(), example: {},
    render: (p) => ({ kind: "schedule", cron: p.cron, guard: "true", search: `#Unresolved ${qf("Due Date")}: *..{minus 1d}`, needs: [{ field: "Due Date", type: "date" }] }),
  },
  {
    id: "trigger.schedule_search", kind: "trigger", title: "Custom scheduled search",
    description: "Run on a cron schedule over any YouTrack search query (advanced escape hatch; query charset is restricted).",
    inspiredBy: ["Jira Automation: Scheduled trigger with JQL", "Monday.com: Every time period"],
    params: z.object({ search: z.string().min(2).max(200).regex(/^[\w #:{}.,*\-+ ]+$/, "unsupported characters in query"), cron: Cron }).strict(),
    example: { search: "#Unresolved Priority: Critical", cron: "0 0 8 * * ?" },
    render: (p) => ({ kind: "schedule", cron: p.cron, guard: "true", search: p.search, needs: [] }),
  },
];
