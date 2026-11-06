import type { WorkflowSpec } from "../types.js";
import type { SimConfig } from "../sim/runtime.js";

/** Realistic simulated project: used by tests, the e2e run and as a prompt example for Claude. */
export const SIM_CONFIG: SimConfig = {
  project: "SD",
  schema: {
    State: { type: "state", values: ["Open", "In Progress", "In Review", "Blocked", "Done", "Wontfix"] },
    Priority: { type: "enum", values: ["Minor", "Normal", "Major", "Critical"] },
    Subsystem: { type: "enum", values: ["Backend", "UI", "Infra"] },
    Assignee: { type: "user" },
    "Due Date": { type: "date" },
  },
  resolvedStates: ["Done", "Wontfix"],
  users: [
    { login: "alice" }, { login: "bob" }, { login: "carol" }, { login: "dave", groups: ["QA"] }, { login: "erin" },
  ],
};

const when = (block: string, params?: Record<string, unknown>) => ({ block, params });

export const SOFTWARE_DELIVERY: WorkflowSpec = {
  name: "software-delivery",
  title: "Software delivery lifecycle",
  description: "Triage, SLA, WIP-limited Kanban flow, quality gates, parent roll-up, stale/overdue housekeeping.",
  rules: [
    { id: "triage-route", title: "Triage: route new issues to subsystem owner", when: when("trigger.issue_created"),
      if: [{ block: "condition.field_empty", params: { field: "Assignee", empty: true } }],
      then: [when("action.route_by_field", { field: "Subsystem", map: { Backend: "alice", UI: "bob", Infra: "erin" }, fallback: "carol" }), when("action.add_tag", { tag: "needs-triage" })] },
    { id: "incident-keywords", title: "Incident: crash/outage keywords → Critical", when: when("trigger.issue_created"),
      if: [{ block: "condition.summary_contains", params: { keywords: ["crash", "outage", "data loss"] } }],
      then: [when("action.set_field", { field: "Priority", value: "Critical" }), when("action.add_tag", { tag: "incident" }), when("action.notify", { to: "carol", subject: "Incident {{issue.id}}", body: "{{issue.summary}} reported by {{issue.reporter}}" })] },
    { id: "sla-critical", title: "SLA: critical issues due in 1 day", when: when("trigger.issue_created"),
      if: [{ block: "condition.field_is", params: { field: "Priority", values: ["Critical"] } }], then: [when("action.set_due_in_days", { days: 1 })] },
    { id: "sla-major", title: "SLA: major issues due in 3 days", when: when("trigger.issue_created"),
      if: [{ block: "condition.field_is", params: { field: "Priority", values: ["Major"] } }], then: [when("action.set_due_in_days", { days: 3 })] },
    { id: "start-self-assign", title: "Starting work assigns the actor if unassigned", when: when("trigger.field_changed", { field: "State", to: "In Progress" }),
      if: [{ block: "condition.field_empty", params: { field: "Assignee", empty: true } }], then: [when("action.assign", { mode: "current_user" })] },
    { id: "wip-limit", title: "Kanban: max 2 issues In Progress per assignee", when: when("trigger.field_changed", { field: "State", to: "In Progress" }),
      then: [when("action.wip_limit", { state: "In Progress", limit: 2, message: "WIP limit (2) reached for {{issue.assignee}}." })] },
    { id: "done-gate", title: "Gate: Done needs assignee and resolved subtasks", when: when("trigger.field_changed", { field: "State", to: "Done" }),
      then: [when("action.require_field", { field: "Assignee", message: "Assign the issue before closing." }), when("action.require_subtasks_resolved", { message: "Resolve all subtasks first." })] },
    { id: "critical-qa-only", title: "Gate: only QA may close Critical issues", when: when("trigger.field_changed", { field: "State", to: "Done" }),
      if: [{ block: "condition.field_is", params: { field: "Priority", values: ["Critical"] } }, { block: "condition.current_user_in_group", params: { group: "QA", negate: true } }],
      then: [when("action.block", { message: "Only QA can close Critical issues." })] },
    { id: "rollup-parent", title: "Roll-up: resolve parent when all subtasks done", when: when("trigger.issue_resolved"),
      then: [when("action.close_parent_when_children_done", { doneState: "Done" })] },
    { id: "blocked-on", title: "Blocked: tag and ask for the reason", when: when("trigger.field_changed", { field: "State", to: "Blocked" }),
      then: [when("action.add_tag", { tag: "blocked" }), when("action.add_comment", { text: "Blocked by {{currentUser}}. Please describe the blocker." })] },
    { id: "blocked-off", title: "Unblocked: remove tag", when: when("trigger.field_changed", { field: "State", from: "Blocked" }),
      then: [when("action.remove_tag", { tag: "blocked" })] },
    { id: "customer-reply-reopen", title: "Reporter replies on a Done issue → reopen", when: when("trigger.comment_added", { byReporter: true }),
      if: [{ block: "condition.field_is", params: { field: "State", values: ["Done"] } }],
      then: [when("action.set_field", { field: "State", value: "Open" }), when("action.notify", { to: "assignee", subject: "{{issue.id}} reopened", body: "Reporter {{issue.reporter}} replied." })] },
    { id: "stale-nudge", title: "Housekeeping: nudge In Progress issues idle for 7 days", when: when("trigger.schedule_stale", { days: 7, states: ["In Progress"] }),
      if: [{ block: "condition.has_tag", params: { tag: "stale", negate: true } }],
      then: [when("action.add_tag", { tag: "stale" }), when("action.notify", { to: "assignee", subject: "{{issue.id}} looks stale", body: "No update on {{issue.summary}} for 7 days." })] },
    { id: "stale-autoclose", title: "Housekeeping: close untouched Open issues after 30 days", when: when("trigger.schedule_stale", { days: 30, states: ["Open"] }),
      then: [when("action.set_field", { field: "State", value: "Wontfix" }), when("action.add_comment", { text: "Auto-closed: no activity for 30 days." })] },
    { id: "due-soon", title: "Reminder: due within 2 days", when: when("trigger.schedule_due", { withinDays: 2 }),
      if: [{ block: "condition.field_empty", params: { field: "Assignee", empty: false } }],
      then: [when("action.notify", { to: "assignee", subject: "{{issue.id}} due soon", body: "{{issue.summary}} is due within 2 days." })] },
    { id: "overdue-escalate", title: "Escalation: overdue issues gain a priority step (once)", when: when("trigger.schedule_overdue"),
      if: [{ block: "condition.has_tag", params: { tag: "overdue", negate: true } }],
      then: [when("action.add_tag", { tag: "overdue" }), when("action.escalate_priority", { ladder: ["Minor", "Normal", "Major", "Critical"] })] },
    { id: "resolved-cleanup", title: "On resolve: clear transient tags", when: when("trigger.issue_resolved"),
      then: [when("action.remove_tag", { tag: "blocked" }), when("action.remove_tag", { tag: "stale" }), when("action.remove_tag", { tag: "overdue" })] },
  ],
};
