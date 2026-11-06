import vm from "node:vm";
import { getBlock } from "./blocks/index.js";
import { WorkflowSpecSchema, type ActionOut, type BlockInstance, type CondOut, type FieldType, type Need, type RenderCtx, type RuleSpec, type TriggerOut, type ParsedWorkflow } from "./types.js";
import { q } from "./blocks/util.js";

export interface Issue { level: "error" | "warning"; rule?: string; message: string }
export interface CompiledRule { id: string; file: string; code: string; kind: "change" | "schedule"; needs: Need[] }
export interface CompileResult { ok: boolean; issues: Issue[]; files: Record<string, string>; rules: CompiledRule[]; manifest?: unknown }

const FIELD_TYPE_JS: Record<FieldType, string> = {
  any: "", state: "entities.State.fieldType", enum: "entities.EnumField.fieldType", user: "entities.User.fieldType",
  date: "entities.Field.dateType", string: "entities.Field.stringType", integer: "entities.Field.integerType", period: "entities.Field.periodType",
};

const HELPERS = `
function norm(v) {
  if (v === null || v === undefined) { return null; }
  if (typeof v === 'object') {
    if (v.name !== undefined) { return v.name; }
    if (v.login !== undefined) { return v.login; }
    if (typeof v.isNotEmpty === 'function') { return v.isNotEmpty() ? true : null; }
  }
  return v;
}
function fv(issue, f) { return norm(issue.fields[f]); }
function ov(issue, f) { return norm(issue.fields.oldValue(f)); }
function isEmptyField(issue, f) { return fv(issue, f) === null || fv(issue, f) === ''; }
function hasTag(issue, t) { return issue.hasTag(t); }
function containsAny(text, words) {
  var s = String(text || '').toLowerCase();
  return words.some(function (w) { return s.indexOf(w.toLowerCase()) >= 0; });
}
function every(coll, pred) { var ok = true; coll.forEach(function (x) { if (!pred(x)) { ok = false; } }); return ok; }
function addedByReporter(issue) {
  var hit = false;
  issue.comments.added.forEach(function (c) { if (issue.reporter && c.author.login === issue.reporter.login) { hit = true; } });
  return hit;
}`.trimStart();

const mergeNeeds = (all: Need[], where: string, issues: Issue[]): Need[] => {
  const m = new Map<string, Need>();
  for (const n of all) {
    const cur = m.get(n.field);
    if (!cur) { m.set(n.field, { ...n, values: n.values ? [...new Set(n.values)] : undefined }); continue; }
    if (cur.type === "any") cur.type = n.type;
    else if (n.type !== "any" && cur.type !== n.type) {
      if ((cur.type === "enum" && n.type === "state") || (cur.type === "state" && n.type === "enum")) cur.type = "state";
      else issues.push({ level: "error", rule: where, message: `field '${n.field}' used as both ${cur.type} and ${n.type}` });
    }
    if (n.values) cur.values = [...new Set([...(cur.values ?? []), ...n.values])];
  }
  return [...m.values()];
};

function describe(e: unknown): string {
  const zi = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues;
  if (zi) return zi.map((i) => `params.${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  return e instanceof Error ? e.message : String(e);
}

function renderRule(rule: RuleSpec, issues: Issue[]): CompiledRule | null {
  const err = (message: string) => issues.push({ level: "error", rule: rule.id, message });
  const ctx: RenderCtx = {
    renderCondition(i: BlockInstance): CondOut {
      const b = getBlock(i.block, "condition"); const p = b.params.parse(i.params ?? {});
      return (b as any).render(p, ctx);
    },
  };
  // Render every block independently so one authoring pass reports ALL problems, each tagged with its block.
  const guarded = <T,>(i: BlockInstance, kind: "trigger" | "condition" | "action", f: () => T): T | null => {
    try { return f(); } catch (e) { err(`${i.block}: ${describe(e)}`); return null; }
  };
  try {
    const trigR = guarded(rule.when, "trigger", () => { const tb = getBlock(rule.when.block, "trigger"); return (tb as any).render(tb.params.parse(rule.when.params ?? {}), ctx) as TriggerOut; });
    const condR = rule.if.map((c) => guarded(c, "condition", () => ctx.renderCondition(c)));
    const actR = rule.then.map((a) => guarded(a, "action", () => { const b = getBlock(a.block, "action"); return (b as any).render(b.params.parse(a.params ?? {}), ctx) as ActionOut; }));
    if (!trigR || condR.includes(null) || actR.includes(null)) return null;
    const trig: TriggerOut = trigR; const conds = condR as CondOut[]; const acts = actR as ActionOut[];

    const gates = rule.then.filter((a) => /^action\.(require_|wip_limit|block)/.test(a.block));
    if (gates.length && trig.kind === "schedule") err("gate actions (require_*, wip_limit, block) block a user's change and cannot run in scheduled rules");
    if (gates.length && !/isChanged|becomes/.test(trig.guard)) issues.push({ level: "warning", rule: rule.id, message: "gate action with a trigger that is not a field change/resolve — it will run on every save of the issue" });
    if (trig.kind === "schedule" && rule.then.some((a) => a.block === "action.message")) issues.push({ level: "warning", rule: rule.id, message: "action.message has no UI user in scheduled rules" });

    const needs = mergeNeeds([...trig.needs, ...conds.flatMap((c) => c.needs), ...acts.flatMap((a) => a.needs)], rule.id, issues);
    for (const n of needs) for (const v of n.values ?? []) if (v === "type") err(`value 'type' of field '${n.field}' is reserved in requirements`);
    const typed = needs.filter((n) => n.type !== "any");
    const reqSrc = typed.length
      ? "{\n" + typed.map((n) => `    ${q(n.field)}: { type: ${FIELD_TYPE_JS[n.type]}${(n.values ?? []).map((v) => `, ${q(v)}: { name: ${q(v)} }`).join("")} }`).join(",\n") + "\n  }"
      : "{}";

    const guardParts = [trig.guard, ...conds.map((c) => c.expr)].filter((x) => x && x !== "true");
    const guard = guardParts.length ? guardParts.join("\n      && ") : "true";
    const usesSearch = [...(trig.requires ?? []), ...acts.flatMap((a) => a.requires ?? [])].includes("search");
    const body = acts.map((a) => "    " + a.code).join("\n");
    const common = `  title: ${q(rule.title)},\n` + (trig.kind === "schedule" ? `  search: ${q(trig.search!)},\n  cron: ${q(trig.cron!)},\n  muteUpdateNotifications: true,\n` : "")
      + `  guard: function (ctx) {\n    var issue = ctx.issue;\n    return ${guard};\n  },\n  action: function (ctx) {\n    var issue = ctx.issue;\n${body}\n  },\n  requirements: ${reqSrc}`;
    const code = `/* Generated by youtrack-workflow-builder. Rule: ${rule.id}. Do not edit by hand — change the spec and recompile. */\n`
      + `var entities = require('@jetbrains/youtrack-scripting-api/entities');\nvar workflow = require('@jetbrains/youtrack-scripting-api/workflow');\n`
      + (usesSearch ? `var search = require('@jetbrains/youtrack-scripting-api/search');\n` : "") + `\n${HELPERS}\n\n`
      + `exports.rule = entities.Issue.${trig.kind === "schedule" ? "onSchedule" : "onChange"}({\n${common}\n});\n`;
    try { new vm.Script(code, { filename: `${rule.id}.js` }); } catch (e) { err(`generated JS has a syntax error: ${(e as Error).message}`); return null; }
    return { id: rule.id, file: `${rule.id}.js`, code, kind: trig.kind, needs };
  } catch (e) {
    err(describe(e));
    return null;
  }
}

/** Validate + compile a workflow spec into YouTrack JS rule modules. Never throws. */
export function compileWorkflow(input: unknown): CompileResult {
  const issues: Issue[] = [];
  const parsed = WorkflowSpecSchema.safeParse(input);
  if (!parsed.success) {
    for (const i of parsed.error.issues) issues.push({ level: "error", message: `${i.path.join(".") || "spec"}: ${i.message}` });
    return { ok: false, issues, files: {}, rules: [] };
  }
  const spec: ParsedWorkflow = parsed.data;
  const seen = new Set<string>();
  for (const r of spec.rules) { if (seen.has(r.id)) issues.push({ level: "error", rule: r.id, message: "duplicate rule id" }); seen.add(r.id); }
  const rules = spec.rules.map((r) => renderRule(r, issues)).filter((x): x is CompiledRule => !!x);
  const ok = !issues.some((i) => i.level === "error");
  const files: Record<string, string> = {};
  if (ok) {
    for (const r of rules) files[r.file] = r.code;
    const manifest = { name: spec.name, title: spec.title, description: spec.description ?? "", rules: rules.map((r) => ({ id: r.id, file: r.file, kind: r.kind })), requiredFields: mergeNeeds(rules.flatMap((r) => r.needs), "*", issues) };
    files["manifest.json"] = JSON.stringify(manifest, null, 2) + "\n";
    return { ok, issues, files, rules, manifest };
  }
  return { ok, issues, files, rules };
}
