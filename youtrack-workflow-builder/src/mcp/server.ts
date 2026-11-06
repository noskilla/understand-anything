#!/usr/bin/env -S npx tsx
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { BLOCKS, getBlock } from "../blocks/index.js";
import { compileWorkflow } from "../compiler.js";
import { deployWorkflow, exportToDir } from "../deploy.js";
import { SIM_CONFIG, SOFTWARE_DELIVERY } from "../examples/software-delivery.js";
import { runScenario, StepSchema } from "../scenario.js";
import { YouTrackSim } from "../sim/runtime.js";
import { WorkflowSpecSchema } from "../types.js";

const text = (o: unknown, isError = false) => ({ content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }], isError });
const SpecInput = z.record(z.unknown()).describe("WorkflowSpec: {name,title,rules:[{id,title,when:{block,params},if:[{block,params}],then:[{block,params}]}]}");

const ProjectConfig = z.object({
  project: z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/),
  schema: z.record(z.object({ type: z.enum(["state", "enum", "user", "date", "string", "integer", "period"]), values: z.array(z.string()).optional() })),
  resolvedStates: z.array(z.string()),
  users: z.array(z.object({ login: z.string(), groups: z.array(z.string()).optional() })).min(1),
}).describe("Simulated project: custom fields (+ allowed values), which states count as resolved, users & groups");

export function createServer() {
  const s = new McpServer({ name: "youtrack-workflow-builder", version: "0.1.0" });

  s.tool("list_blocks", "Catalogue of composable workflow blocks (triggers, conditions, actions) with their PM-tool inspirations. Start here.",
    { kind: z.enum(["trigger", "condition", "action"]).optional() },
    async ({ kind }) => text(BLOCKS.filter((b) => !kind || b.kind === kind).map((b) => ({ id: b.id, kind: b.kind, title: b.title, description: b.description, inspiredBy: b.inspiredBy }))));

  s.tool("describe_block", "JSON Schema of a block's params plus a working example instance.",
    { id: z.string() },
    async ({ id }) => { try { const b = getBlock(id); return text({ id, kind: b.kind, description: b.description, paramsSchema: zodToJsonSchema(b.params, { $refStrategy: "none" }), example: { block: id, params: b.example } }); } catch (e) { return text((e as Error).message, true); } });

  s.tool("get_spec_schema", "JSON Schema of the WorkflowSpec document.", {}, async () => text(zodToJsonSchema(WorkflowSpecSchema, { $refStrategy: "none" })));
  s.tool("get_example_workflow", "A complete, tested 17-rule software-delivery workflow spec plus the simulated project config it runs against.", {}, async () => text({ spec: SOFTWARE_DELIVERY, simulatedProject: SIM_CONFIG }));

  s.tool("validate_workflow", "Validate a spec: schema, block ids/params, field-type consistency, gate/trigger lint, generated-JS syntax. Returns errors and warnings with rule ids.",
    { spec: SpecInput },
    async ({ spec }) => { const r = compileWorkflow(spec); return text({ ok: r.ok, issues: r.issues, rules: r.rules.map((x) => ({ id: x.id, kind: x.kind, fields: x.needs })) }, !r.ok); });

  s.tool("compile_workflow", "Compile a spec into YouTrack workflow JavaScript (one module per rule + manifest.json).",
    { spec: SpecInput },
    async ({ spec }) => { const r = compileWorkflow(spec); return text({ ok: r.ok, issues: r.issues, files: r.files }, !r.ok); });

  s.tool("simulate_workflow", "Compile and execute the workflow in a YouTrack runtime simulator against a scenario (create/update/advance time/run schedulers/link subtasks) with assertions. Use it to verify happy paths AND negative cases (gates, no duplicate firing).",
    { spec: SpecInput, scenario: z.array(StepSchema).min(1).max(200), project: ProjectConfig.optional() },
    async ({ spec, scenario, project }) => {
      const c = compileWorkflow(spec);
      if (!c.ok) return text({ ok: false, stage: "compile", issues: c.issues }, true);
      try {
        const sim = new YouTrackSim(project ?? SIM_CONFIG).load(c.files);
        const r = runScenario(sim, scenario);
        return text({ ok: r.ok, warnings: c.issues, failedSteps: r.reports.filter((x) => !x.ok), reports: r.reports }, !r.ok);
      } catch (e) { return text({ ok: false, stage: "load", error: (e as Error).message }, true); }
    });

  s.tool("export_workflow", "Write the compiled workflow to <outDir>/<name>/ (relative to the server's working directory).",
    { spec: SpecInput, outDir: z.string().default("out") },
    async ({ spec, outDir }) => {
      const c = compileWorkflow(spec); if (!c.ok) return text({ ok: false, issues: c.issues }, true);
      const abs = resolve(outDir); if (abs !== process.cwd() && !abs.startsWith(process.cwd() + sep)) return text("outDir must be inside the server working directory", true);
      return text({ ok: true, dir: exportToDir((spec as { name: string }).name, c.files, abs), files: Object.keys(c.files) });
    });

  s.tool("deploy_workflow", "Deploy to YouTrack via REST (credentials come from env YOUTRACK_URL + YOUTRACK_TOKEN, never from arguments). dryRun=true (default) only returns the request plan; a real deploy needs dryRun=false AND confirm=true. Only deploy after simulate_workflow passes.",
    { spec: SpecInput, projectId: z.string().optional(), dryRun: z.boolean().default(true), confirm: z.boolean().default(false) },
    async ({ spec, projectId, dryRun, confirm }) => {
      const c = compileWorkflow(spec); if (!c.ok) return text({ ok: false, issues: c.issues }, true);
      const baseUrl = process.env.YOUTRACK_URL ?? "", token = process.env.YOUTRACK_TOKEN ?? "";
      if (!dryRun && (!confirm || !baseUrl || !token)) return text("real deploy needs confirm=true and YOUTRACK_URL / YOUTRACK_TOKEN in the server environment", true);
      const sp = spec as { name: string; title: string };
      const r = await deployWorkflow({ baseUrl: baseUrl || "https://youtrack.example.invalid", token, name: sp.name, title: sp.title, files: c.files, projectId, dryRun });
      return text(r, !r.ok);
    });

  s.prompt("build_youtrack_workflow", "Guided procedure for turning a plain-language process into a verified YouTrack workflow.",
    { goal: z.string().describe("The process to automate, in plain language") },
    ({ goal }) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text:
`Build a YouTrack workflow for: ${goal}

Procedure (do not skip verification):
1. list_blocks, then describe_block for every block you intend to use. Compose ONLY from catalogued blocks.
2. Draft a WorkflowSpec: one rule = one trigger + optional conditions + ordered actions. Prefer many small single-purpose rules. Use kebab-case ids.
   - Gates (action.require_*, wip_limit, block) belong on trigger.field_changed / resolved, never on schedules.
   - Scheduled rules must be idempotent (guard with a tag or state) so they do not repeat every run.
3. validate_workflow; fix every error, read every warning.
4. simulate_workflow with a scenario that covers each rule's happy path AND at least one negative case per gate/guard (blocked change rolled back, schedule not firing twice). Use the project's real field names/values via the 'project' argument.
5. Fix failures and re-simulate until all steps pass.
6. export_workflow, then deploy_workflow with dryRun=true; only deploy for real when the user confirms.
Report: rules built, scenarios passed, and what was NOT verified against a live YouTrack.` } }] }));

  s.resource("block-catalog", "yt://blocks/catalog", { mimeType: "application/json", description: "All block ids with titles" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(BLOCKS.map((b) => ({ id: b.id, title: b.title })), null, 2) }] }));
  return s;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createServer().connect(new StdioServerTransport());
}
