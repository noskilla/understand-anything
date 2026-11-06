import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { BLOCKS } from "../src/blocks/index.js";
import { tpl } from "../src/blocks/util.js";
import { compileWorkflow } from "../src/compiler.js";
import { YouTrackSim } from "../src/sim/runtime.js";
import { SIM_CONFIG } from "../src/examples/software-delivery.js";

const wf = (rule: Record<string, unknown>) => ({ name: "t", title: "Test wf", rules: [{ id: "r1", title: "Test rule", if: [], ...rule }] });
const created = { block: "trigger.issue_created" };

describe("block catalogue", () => {
  it("has triggers, conditions and actions, each with inspiration and a valid example", () => {
    for (const k of ["trigger", "condition", "action"] as const) expect(BLOCKS.filter((b) => b.kind === k).length).toBeGreaterThanOrEqual(5);
    for (const b of BLOCKS) {
      expect(b.inspiredBy.length, b.id).toBeGreaterThan(0);
      if (b.kind === "condition" && /all_of|any_of|not/.test(b.id)) continue; // nested examples are covered below
      expect(b.params.safeParse(b.example).success, `${b.id} example must satisfy its own schema`).toBe(true);
    }
    expect(new Set(BLOCKS.map((b) => b.id)).size).toBe(BLOCKS.length);
  });

  it("every block compiles into syntactically valid YouTrack JS when used in a rule", () => {
    const trigs = BLOCKS.filter((b) => b.kind === "trigger"), conds = BLOCKS.filter((b) => b.kind === "condition" && !/all_of|any_of|not/.test(b.id)), acts = BLOCKS.filter((b) => b.kind === "action");
    for (const t of trigs) for (const a of acts) {
      const isGate = /require_|wip_limit|block/.test(a.id), sched = t.id.includes("schedule");
      if (isGate && sched) continue;
      const r = compileWorkflow(wf({ when: { block: t.id, params: t.example }, if: conds.map((c) => ({ block: c.id, params: c.example })), then: [{ block: a.id, params: a.example }] }));
      expect(r.issues.filter((i) => i.level === "error"), `${t.id} + ${a.id}`).toEqual([]);
      new vm.Script(r.files["r1.js"]);
    }
  });

  it("nested all_of / any_of / not conditions compile and evaluate correctly", () => {
    const r = compileWorkflow(wf({ when: created, if: [{ block: "condition.any_of", params: { conditions: [
      { block: "condition.all_of", params: { conditions: [{ block: "condition.field_is", params: { field: "Priority", values: ["Minor"] } }, { block: "condition.has_tag", params: { tag: "x" } }] } },
      { block: "condition.not", params: { condition: { block: "condition.field_empty", params: { field: "Subsystem", empty: true } } } }] } }],
      then: [{ block: "action.add_tag", params: { tag: "hit" } }] }));
    expect(r.ok, JSON.stringify(r.issues)).toBe(true);
    const sim = new YouTrackSim(structuredClone(SIM_CONFIG)).load(r.files);
    expect(sim.get(sim.createIssue({ summary: "a", reporter: "dave", fields: { Subsystem: "UI" } }).id).tags).toContain("hit");
    expect(sim.get(sim.createIssue({ summary: "b", reporter: "dave", fields: { Priority: "Minor" } }).id).tags).not.toContain("hit");
    expect(sim.get(sim.createIssue({ summary: "c", reporter: "dave", fields: { Priority: "Minor" }, tags: ["x"] }).id).tags).toContain("hit");
  });
});

describe("validation & safety", () => {
  const errs = (r: ReturnType<typeof compileWorkflow>) => r.issues.filter((i) => i.level === "error").map((i) => i.message).join(" | ");
  it("rejects unknown blocks, wrong kinds, bad params, duplicate ids", () => {
    expect(errs(compileWorkflow(wf({ when: { block: "trigger.nope" }, then: [{ block: "action.add_tag", params: { tag: "a" } }] })))).toMatch(/Unknown block/);
    expect(errs(compileWorkflow(wf({ when: { block: "action.add_tag", params: { tag: "a" } }, then: [{ block: "action.add_tag", params: { tag: "a" } }] })))).toMatch(/expected trigger/);
    expect(errs(compileWorkflow(wf({ when: created, then: [{ block: "action.add_tag", params: { tag: "a", extra: 1 } }] })))).toMatch(/unrecognized/i);
    const dup = wf({ when: created, then: [{ block: "action.add_tag", params: { tag: "a" } }] }); dup.rules.push(dup.rules[0]);
    expect(errs(compileWorkflow(dup))).toMatch(/duplicate rule id/);
  });
  it("gates in scheduled rules are errors; gates without a change trigger warn", () => {
    expect(errs(compileWorkflow(wf({ when: { block: "trigger.schedule_overdue" }, then: [{ block: "action.block", params: { message: "no" } }] })))).toMatch(/cannot run in scheduled/);
    const w = compileWorkflow(wf({ when: { block: "trigger.comment_added" }, then: [{ block: "action.block", params: { message: "no" } }] }));
    expect(w.issues.some((i) => i.level === "warning")).toBe(true);
  });
  it("detects a field used with conflicting types", () => {
    expect(errs(compileWorkflow(wf({ when: created, then: [{ block: "action.set_field", params: { field: "Estimate", value: 3 } }, { block: "action.set_field", params: { field: "Estimate", value: "x", kind: "string" } }] })))).toMatch(/both integer and string/);
  });
  it("is injection-proof: hostile strings never reach the generated code unescaped", () => {
    for (const evil of ['"; process.exit(1); "', "{{constructor.constructor('return 1')()}}", "${evil}", "a'b"]) {
      const r = compileWorkflow(wf({ when: created, then: [{ block: "action.add_comment", params: { text: evil } }] }));
      if (r.ok) { new vm.Script(r.files["r1.js"]); expect(r.files["r1.js"]).not.toMatch(/process\.exit\(1\); "\)/); }
    }
    expect(() => tpl("{{constructor}}")).toThrow();
    expect(errs(compileWorkflow(wf({ when: created, then: [{ block: "action.add_tag", params: { tag: '"); evil(); ("' } }] })))).toMatch(/invalid value/);
    expect(errs(compileWorkflow(wf({ when: { block: "trigger.schedule_search", params: { search: "x'); evil(); ('", cron: "0 0 8 * * ?" } }, then: [{ block: "action.add_tag", params: { tag: "a" } }] })))).toMatch(/unsupported characters/);
    expect(errs(compileWorkflow(wf({ when: { block: "trigger.schedule_overdue", params: { cron: "bad cron" } }, then: [{ block: "action.add_tag", params: { tag: "a" } }] })))).toMatch(/Quartz/);
  });
  it("the simulator rejects a rule needing a field/value the project does not have (requirements check)", () => {
    const r = compileWorkflow(wf({ when: created, then: [{ block: "action.set_field", params: { field: "Priority", value: "Blocker" } }] }));
    expect(() => new YouTrackSim(structuredClone(SIM_CONFIG)).load(r.files)).toThrow(/no value 'Blocker'/);
    const r2 = compileWorkflow(wf({ when: created, then: [{ block: "action.set_field", params: { field: "Severity", value: "S1" } }] }));
    expect(() => new YouTrackSim(structuredClone(SIM_CONFIG)).load(r2.files)).toThrow(/no field 'Severity'/);
  });
});

describe("read-only field references", () => {
  it("are listed in manifest.requiredFields and checked against the project schema, but get no typed requirement", () => {
    const r = compileWorkflow(wf({ when: { block: "trigger.field_changed", params: { field: "State", to: "Done" } }, then: [{ block: "action.require_field", params: { field: "Customer", message: "need it" } }] }));
    expect(JSON.parse(r.files["manifest.json"]).requiredFields.map((f: any) => f.field)).toEqual(expect.arrayContaining(["State", "Customer"]));
    expect(r.files["r1.js"]).not.toMatch(/"Customer": \{ type/);
    expect(() => new YouTrackSim(structuredClone(SIM_CONFIG)).load(r.files)).toThrow(/no field 'Customer'/);
  });
});
