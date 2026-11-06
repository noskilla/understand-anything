import { z } from "zod";
import { YouTrackSim, type TxResult } from "./sim/runtime.js";

const Expect = z.object({
  blocked: z.union([z.boolean(), z.string()]).optional().describe("true = any block; string = exact block message; false = must not be blocked"),
  fields: z.record(z.unknown()).optional(), tagsInclude: z.array(z.string()).optional(), tagsExclude: z.array(z.string()).optional(),
  notifications: z.number().int().optional().describe("exact number of notifications sent in this step"),
  commentLast: z.string().optional(), ruleRan: z.array(z.string()).optional(), ruleNotRan: z.array(z.string()).optional(),
  dueInDays: z.number().optional().describe("Due Date == simulated now + N days"),
}).strict();

export const StepSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), as: z.string(), summary: z.string(), reporter: z.string(), fields: z.record(z.unknown()).optional(), tags: z.array(z.string()).optional(), expect: Expect.optional() }).strict(),
  z.object({ op: z.literal("update"), issue: z.string(), actor: z.string(), fields: z.record(z.unknown()).optional(), comment: z.string().optional(), addTags: z.array(z.string()).optional(), expect: Expect.optional() }).strict(),
  z.object({ op: z.literal("advance"), days: z.number() }).strict(),
  z.object({ op: z.literal("schedule"), rule: z.string().optional(), issue: z.string().optional(), expect: Expect.optional() }).strict(),
  z.object({ op: z.literal("link"), parent: z.string(), child: z.string() }).strict(),
]);
export type Step = z.infer<typeof StepSchema>;
export interface StepReport { step: number; op: string; ok: boolean; failures: string[]; blocked?: string; ran?: string[]; notifications?: number }

export function runScenario(sim: YouTrackSim, steps: Step[]): { ok: boolean; reports: StepReport[] } {
  const alias = new Map<string, string>();
  const rid = (a: string) => alias.get(a) ?? a;
  const reports: StepReport[] = [];
  steps.forEach((s, n) => {
    const fail: string[] = []; let res: TxResult | undefined; let target: string | undefined;
    try {
      if (s.op === "create") { const r = sim.createIssue({ summary: s.summary, reporter: s.reporter, fields: s.fields, tags: s.tags }); alias.set(s.as, r.id); res = r.result; target = r.id; }
      else if (s.op === "update") { target = rid(s.issue); res = sim.update(target, { fields: s.fields, comment: s.comment, addTags: s.addTags, actor: s.actor }); }
      else if (s.op === "advance") sim.advance(s.days);
      else if (s.op === "link") sim.link(rid(s.parent), rid(s.child));
      else { res = sim.runSchedules(s.rule); target = s.issue ? rid(s.issue) : undefined; }
    } catch (e) { fail.push(`runtime error: ${(e as Error).message}`); }
    const ex = "expect" in s ? s.expect : undefined;
    if (ex && res) {
      if (ex.blocked !== undefined) {
        if (ex.blocked === false && res.blocked) fail.push(`unexpectedly blocked: ${res.blocked}`);
        else if (ex.blocked === true && !res.blocked) fail.push("expected the change to be blocked");
        else if (typeof ex.blocked === "string" && res.blocked !== ex.blocked) fail.push(`expected block '${ex.blocked}', got ${res.blocked ? `'${res.blocked}'` : "no block"}`);
      }
      if (ex.notifications !== undefined && res.notifications.length !== ex.notifications) fail.push(`expected ${ex.notifications} notifications, got ${res.notifications.length}`);
      for (const r of ex.ruleRan ?? []) if (!res.ran.some((x) => x.startsWith(r + "@")) && !res.log.some((x) => x.startsWith(r + "@"))) fail.push(`rule '${r}' did not run`);
      for (const r of ex.ruleNotRan ?? []) if (res.ran.some((x) => x.startsWith(r + "@")) || res.log.some((x) => x.startsWith(r + "@"))) fail.push(`rule '${r}' ran but should not have`);
      if (target && (ex.fields || ex.tagsInclude || ex.tagsExclude || ex.commentLast || ex.dueInDays !== undefined)) {
        const i = sim.get(target);
        for (const [k, v] of Object.entries(ex.fields ?? {})) if ((i.fields[k] ?? null) !== v) fail.push(`${target}.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(i.fields[k] ?? null)}`);
        for (const t of ex.tagsInclude ?? []) if (!i.tags.includes(t)) fail.push(`${target} missing tag '${t}' (has ${JSON.stringify(i.tags)})`);
        for (const t of ex.tagsExclude ?? []) if (i.tags.includes(t)) fail.push(`${target} unexpectedly has tag '${t}'`);
        if (ex.commentLast !== undefined && i.comments.at(-1)?.text !== ex.commentLast) fail.push(`last comment: expected '${ex.commentLast}', got '${i.comments.at(-1)?.text}'`);
        if (ex.dueInDays !== undefined && i.fields["Due Date"] !== sim.now + ex.dueInDays * 86400000) fail.push(`Due Date is not now+${ex.dueInDays}d`);
      }
    }
    reports.push({ step: n + 1, op: s.op, ok: fail.length === 0, failures: fail, blocked: res?.blocked, ran: res?.ran, notifications: res?.notifications.length });
  });
  return { ok: reports.every((r) => r.ok), reports };
}
