import { z } from "zod";

/** A reference to a block plus its parameters. Conditions may nest (all_of / any_of / not). */
export interface BlockInstance { block: string; params?: Record<string, unknown> }
export const BlockInstanceSchema: z.ZodType<BlockInstance> = z.lazy(() =>
  z.object({ block: z.string().min(1), params: z.record(z.unknown()).optional() }).strict(),
);

export const RuleSpecSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/, "rule id: kebab-case, starts with a letter"),
  title: z.string().min(3).max(120),
  when: BlockInstanceSchema,
  if: z.array(BlockInstanceSchema).default([]),
  then: z.array(BlockInstanceSchema).min(1),
}).strict();

export const WorkflowSpecSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/, "workflow name: kebab-case"),
  title: z.string().min(3).max(120),
  description: z.string().max(500).optional(),
  rules: z.array(RuleSpecSchema).min(1).max(40),
}).strict();

export type RuleSpec = z.infer<typeof RuleSpecSchema>;
export type WorkflowSpec = z.input<typeof WorkflowSpecSchema>;
export type ParsedWorkflow = z.infer<typeof WorkflowSpecSchema>;

/** "any" = field is only read (type unknown): listed in the manifest, no typed `requirements` entry. */
export type FieldType = "any" | "state" | "enum" | "user" | "date" | "string" | "integer" | "period";
/** A custom-field requirement a rule declares (becomes `requirements` in YouTrack JS). */
export interface Need { field: string; type: FieldType; values?: string[] }

export interface TriggerOut { kind: "change" | "schedule"; guard: string; search?: string; cron?: string; needs: Need[]; requires?: string[] }
export interface CondOut { expr: string; needs: Need[] }
export interface ActionOut { code: string; needs: Need[]; requires?: string[] }

export interface Block<K extends "trigger" | "condition" | "action", O> {
  id: string; kind: K; title: string; description: string;
  /** Which popular PM tools this block was distilled from. */
  inspiredBy: string[];
  params: z.ZodTypeAny;
  example: Record<string, unknown>;
  render(p: any, ctx: RenderCtx): O;
}
export interface RenderCtx { renderCondition(i: BlockInstance): CondOut }
export type AnyBlock = Block<"trigger", TriggerOut> | Block<"condition", CondOut> | Block<"action", ActionOut>;
