import { beforeEach, describe, expect, it } from "vitest";
import { compileWorkflow } from "../src/compiler.js";
import { YouTrackSim } from "../src/sim/runtime.js";
import { SIM_CONFIG, SOFTWARE_DELIVERY } from "../src/examples/software-delivery.js";

const DAY = 86400000;
let sim: YouTrackSim;
const mk = (summary: string, fields: Record<string, unknown> = {}, reporter = "dave") => sim.createIssue({ summary, reporter, fields });
const ids = (r: { result: { ran: string[] } }) => r.result.ran.map((x) => x.split("@")[0]);

beforeEach(() => {
  const c = compileWorkflow(SOFTWARE_DELIVERY);
  expect(c.issues.filter((i) => i.level === "error")).toEqual([]);
  sim = new YouTrackSim(structuredClone(SIM_CONFIG)).load(c.files);
});

describe("software-delivery workflow (simulated YouTrack runtime)", () => {
  it("loads every rule and satisfies all field requirements of the project", () => {
    expect(sim.ruleIds()).toHaveLength(SOFTWARE_DELIVERY.rules.length);
  });

  it("triage: routes by subsystem and tags needs-triage", () => {
    const a = mk("Slow query", { Subsystem: "Backend", Priority: "Normal" });
    const i = sim.get(a.id);
    expect(i.fields.Assignee).toBe("alice");
    expect(i.tags).toContain("needs-triage");
    expect(i.fields["Due Date"]).toBeNull();
  });

  it("triage: falls back to carol when subsystem is unknown", () => {
    expect(sim.get(mk("Mystery").id).fields.Assignee).toBe("carol");
  });

  it("incident keywords escalate to Critical, set 1-day SLA, tag and notify", () => {
    const a = mk("Login page CRASHES on submit", { Subsystem: "UI" });
    const i = sim.get(a.id);
    expect(i.fields.Priority).toBe("Critical");
    expect(i.tags).toEqual(expect.arrayContaining(["incident", "needs-triage"]));
    expect(i.fields["Due Date"]).toBe(sim.now + DAY);
    expect(a.result.notifications).toEqual([{ to: "carol", subject: "Incident SD-1", body: "Login page CRASHES on submit reported by dave" }]);
    expect(ids(a)).toEqual(expect.arrayContaining(["incident-keywords", "sla-critical"]));
  });

  it("SLA for Major is 3 days and a manual Due Date is preserved", () => {
    expect(sim.get(mk("Typo", { Priority: "Major" }).id).fields["Due Date"]).toBe(sim.now + 3 * DAY);
    const manual = sim.now + 10 * DAY;
    expect(sim.get(mk("Typo 2", { Priority: "Major", "Due Date": manual }).id).fields["Due Date"]).toBe(manual);
  });

  it("starting work self-assigns when nobody owns the issue", () => {
    const a = mk("X", { Subsystem: "UI" });
    sim.update(a.id, { fields: { Assignee: null }, actor: "dave" });
    const r = sim.update(a.id, { fields: { State: "In Progress" }, actor: "erin" });
    expect(r.blocked).toBeUndefined();
    expect(sim.get(a.id).fields.Assignee).toBe("erin");
  });

  it("WIP limit blocks the 3rd In Progress issue and rolls the whole change back", () => {
    const [a, b, c] = ["A", "B", "C"].map((s) => mk(s, { Subsystem: "Backend" }).id); // all alice
    expect(sim.update(a, { fields: { State: "In Progress" }, actor: "alice" }).blocked).toBeUndefined();
    expect(sim.update(b, { fields: { State: "In Progress" }, actor: "alice" }).blocked).toBeUndefined();
    const r = sim.update(c, { fields: { State: "In Progress" }, actor: "alice", addTags: ["tried"] });
    expect(r.blocked).toBe("WIP limit (2) reached for alice.");
    expect(sim.get(c).fields.State).toBe("Open");
    expect(sim.get(c).tags).not.toContain("tried");
  });

  it("Done gate: blocked while subtasks are open; roll-up closes the parent when the last child is done", () => {
    const parent = mk("Epic", { Subsystem: "Infra" }).id;
    const c1 = mk("Child 1", { Subsystem: "Infra" }).id, c2 = mk("Child 2", { Subsystem: "Infra" }).id;
    sim.link(parent, c1); sim.link(parent, c2);
    expect(sim.update(parent, { fields: { State: "Done" }, actor: "erin" }).blocked).toBe("Resolve all subtasks first.");
    expect(sim.update(c1, { fields: { State: "Done" }, actor: "erin" }).blocked).toBeUndefined();
    expect(sim.get(parent).fields.State).toBe("Open");
    expect(sim.update(c2, { fields: { State: "Done" }, actor: "erin" }).blocked).toBeUndefined();
    expect(sim.get(parent).fields.State).toBe("Done");
  });

  it("Done gate: requires an assignee", () => {
    const a = mk("Orphan", { Subsystem: "UI" }).id;
    sim.update(a, { fields: { Assignee: null }, actor: "dave" });
    expect(sim.update(a, { fields: { State: "Done" }, actor: "dave" }).blocked).toBe("Assign the issue before closing.");
  });

  it("only QA may close Critical issues", () => {
    const a = mk("Data loss in export", { Subsystem: "Backend" }).id; // Critical via keywords
    expect(sim.update(a, { fields: { State: "Done" }, actor: "alice" }).blocked).toBe("Only QA can close Critical issues.");
    expect(sim.update(a, { fields: { State: "Done" }, actor: "dave" }).blocked).toBeUndefined();
    expect(sim.get(a).fields.State).toBe("Done");
  });

  it("Blocked adds tag + comment, leaving Blocked removes the tag", () => {
    const a = mk("B", { Subsystem: "UI" }).id;
    sim.update(a, { fields: { State: "Blocked" }, actor: "bob" });
    expect(sim.get(a).tags).toContain("blocked");
    expect(sim.get(a).comments.at(-1)?.text).toBe("Blocked by bob. Please describe the blocker.");
    sim.update(a, { fields: { State: "In Progress" }, actor: "bob" });
    expect(sim.get(a).tags).not.toContain("blocked");
  });

  it("resolve clears transient tags", () => {
    const a = mk("T", { Subsystem: "UI" }).id;
    sim.update(a, { fields: { State: "Blocked" }, actor: "bob" });
    sim.update(a, { fields: { State: "Done" }, actor: "bob" });
    expect(sim.get(a).tags).not.toContain("blocked");
  });

  it("reporter reply on a Done issue reopens it and notifies the assignee; other users' replies do not", () => {
    const a = mk("R", { Subsystem: "UI" }).id;
    sim.update(a, { fields: { State: "Done" }, actor: "bob" });
    sim.update(a, { comment: "thanks", actor: "erin" });
    expect(sim.get(a).fields.State).toBe("Done");
    const r = sim.update(a, { comment: "still broken", actor: "dave" });
    expect(sim.get(a).fields.State).toBe("Open");
    expect(r.notifications).toEqual([{ to: "bob", subject: "SD-1 reopened", body: "Reporter dave replied." }]);
  });

  it("scheduler: stale nudge once, then auto-close of untouched Open issues", () => {
    const wip = mk("W", { Subsystem: "Backend" }).id, idle = mk("I", { Subsystem: "UI" }).id;
    sim.update(wip, { fields: { State: "In Progress" }, actor: "alice" });
    sim.advance(6); expect(sim.runSchedules().notifications).toHaveLength(0);
    sim.advance(2);
    const r1 = sim.runSchedules();
    expect(r1.notifications).toEqual([{ to: "alice", subject: `${wip} looks stale`, body: "No update on W for 7 days." }]);
    expect(sim.get(wip).tags).toContain("stale");
    expect(sim.runSchedules().notifications).toHaveLength(0); // idempotent: tag guard
    sim.advance(25);
    sim.runSchedules();
    expect(sim.get(idle).fields.State).toBe("Wontfix");
    expect(sim.get(idle).comments.at(-1)?.text).toBe("Auto-closed: no activity for 30 days.");
    expect(sim.get(wip).fields.State).toBe("In Progress");
  });

  it("scheduler: due-soon reminder and one-time overdue escalation", () => {
    const a = mk("D", { Subsystem: "UI", Priority: "Normal", "Due Date": sim.now + 2 * DAY }).id;
    sim.advance(1);
    expect(sim.runSchedules("due-soon").notifications).toEqual([{ to: "bob", subject: `${a} due soon`, body: "D is due within 2 days." }]);
    sim.advance(3);
    sim.runSchedules("overdue-escalate");
    expect(sim.get(a).fields.Priority).toBe("Major");
    expect(sim.get(a).tags).toContain("overdue");
    sim.advance(1); sim.runSchedules("overdue-escalate");
    expect(sim.get(a).fields.Priority).toBe("Major");
  });

  it("does not loop forever: cascades stabilise", () => {
    const r = mk("Outage in checkout", { Subsystem: "Backend" });
    expect(r.result.ran.length).toBeLessThan(20);
  });
});
