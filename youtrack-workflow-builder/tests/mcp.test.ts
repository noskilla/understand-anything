import { createServer as http } from "node:http";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.js";
import { deployWorkflow } from "../src/deploy.js";
import { compileWorkflow } from "../src/compiler.js";
import { SOFTWARE_DELIVERY } from "../src/examples/software-delivery.js";

async function client() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer().connect(a);
  const c = new Client({ name: "test", version: "1" }); await c.connect(b); return c;
}
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r: any = await c.callTool({ name, arguments: args }); const t = r.content[0].text;
  let j: any; try { j = JSON.parse(t); } catch { j = t; } return { isError: !!r.isError, j };
};

describe("MCP surface", () => {
  it("lists tools/prompt/resource and serves block docs", async () => {
    const c = await client();
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(["compile_workflow", "deploy_workflow", "describe_block", "export_workflow", "get_example_workflow", "get_spec_schema", "list_blocks", "simulate_workflow", "validate_workflow"]);
    expect((await c.listPrompts()).prompts[0].name).toBe("build_youtrack_workflow");
    const p = await c.getPrompt({ name: "build_youtrack_workflow", arguments: { goal: "bug triage" } });
    expect((p.messages[0].content as any).text).toContain("bug triage");
    expect((await c.listResources()).resources[0].uri).toBe("yt://blocks/catalog");
    const l = await call(c, "list_blocks", { kind: "action" }); expect(l.j.every((b: any) => b.id.startsWith("action."))).toBe(true);
    const d = await call(c, "describe_block", { id: "action.wip_limit" }); expect(d.j.paramsSchema.properties.limit).toBeTruthy();
    expect((await call(c, "describe_block", { id: "nope" })).isError).toBe(true);
  });
  it("validate → compile → simulate with a custom scenario, including failing assertions", async () => {
    const c = await client();
    expect((await call(c, "validate_workflow", { spec: SOFTWARE_DELIVERY })).j.ok).toBe(true);
    expect(Object.keys((await call(c, "compile_workflow", { spec: SOFTWARE_DELIVERY })).j.files)).toContain("manifest.json");
    const good = await call(c, "simulate_workflow", { spec: SOFTWARE_DELIVERY, scenario: [
      { op: "create", as: "i", summary: "Checkout outage", reporter: "dave", fields: { Subsystem: "Backend" }, expect: { fields: { Priority: "Critical", Assignee: "alice" }, dueInDays: 1, tagsInclude: ["incident"] } },
      { op: "update", issue: "i", actor: "alice", fields: { State: "Done" }, expect: { blocked: "Only QA can close Critical issues." } }] });
    expect(good.j.ok, JSON.stringify(good.j.failedSteps)).toBe(true);
    const bad = await call(c, "simulate_workflow", { spec: SOFTWARE_DELIVERY, scenario: [{ op: "create", as: "i", summary: "x", reporter: "dave", expect: { fields: { Priority: "Critical" } } }] });
    expect(bad.isError).toBe(true); expect(bad.j.failedSteps[0].failures[0]).toMatch(/Priority/);
  });
  it("deploy is dry-run by default and refuses real deploy without confirm/credentials", async () => {
    const c = await client();
    const dry = await call(c, "deploy_workflow", { spec: SOFTWARE_DELIVERY, projectId: "0-1" });
    expect(dry.j.dryRun).toBe(true); expect(dry.j.steps.length).toBe(1 + SOFTWARE_DELIVERY.rules.length + 1);
    expect((await call(c, "deploy_workflow", { spec: SOFTWARE_DELIVERY, dryRun: false })).isError).toBe(true);
  });
});

describe("REST deploy against a mock YouTrack", () => {
  it("creates workflow, rules and attaches; surfaces HTTP failures", async () => {
    const seen: string[] = []; let fail = false;
    const srv = http((req, res) => {
      let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
        seen.push(`${req.method} ${req.url} auth=${req.headers.authorization}`);
        if (fail && /rules/.test(req.url!)) { res.writeHead(400); return res.end("bad script"); }
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "wf-1" }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, r));
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    const c = compileWorkflow(SOFTWARE_DELIVERY);
    const ok = await deployWorkflow({ baseUrl: base, token: "tok", name: "software-delivery", title: "t", files: c.files, projectId: "0-1", dryRun: false });
    expect(ok.ok).toBe(true); expect(seen).toHaveLength(1 + SOFTWARE_DELIVERY.rules.length + 1);
    expect(seen[1]).toContain("/api/admin/workflows/wf-1/rules"); expect(seen[0]).toContain("auth=Bearer tok");
    fail = true;
    const bad = await deployWorkflow({ baseUrl: base, token: "tok", name: "x", title: "t", files: c.files, dryRun: false });
    expect(bad.ok).toBe(false); expect(bad.error).toMatch(/HTTP 400/);
    srv.close();
  });
});
