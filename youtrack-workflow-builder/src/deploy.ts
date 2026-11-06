import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Write the compiled workflow as a folder (manifest.json + one .js per rule) for manual import / version control. */
export function exportToDir(name: string, files: Record<string, string>, outDir: string): string {
  const dir = resolve(outDir, name);
  mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(files)) { if (/[\\/]/.test(f)) throw new Error(`unsafe file name ${f}`); writeFileSync(join(dir, f), c); }
  return dir;
}

export interface DeployOpts {
  baseUrl: string; token: string; name: string; title: string; files: Record<string, string>;
  projectId?: string; dryRun?: boolean; fetchImpl?: typeof fetch;
}
export interface DeployStep { method: string; path: string; body?: unknown; status?: number; id?: string }

/**
 * Deploy via the YouTrack REST admin API: create workflow → add each rule script → (optionally) attach to a project.
 * NOTE: endpoint contract is written from the documented admin resources; it is exercised against a mock server in tests,
 * NOT against a live YouTrack (no instance reachable from the build sandbox). Always run with dryRun first.
 */
export async function deployWorkflow(o: DeployOpts): Promise<{ ok: boolean; dryRun: boolean; steps: DeployStep[]; error?: string }> {
  const steps: DeployStep[] = [];
  const base = o.baseUrl.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) return { ok: false, dryRun: !!o.dryRun, steps, error: "baseUrl must be http(s)://…" };
  const plan: { method: string; path: string; body: unknown; capture?: boolean }[] = [
    { method: "POST", path: "/api/admin/workflows?fields=id,name", body: { name: o.name, title: o.title }, capture: true },
    ...Object.entries(o.files).filter(([f]) => f.endsWith(".js")).map(([f, script]) => ({ method: "POST", path: "/api/admin/workflows/{wf}/rules?fields=id,name", body: { name: f.replace(/\.js$/, ""), script } })),
    ...(o.projectId ? [{ method: "POST", path: `/api/admin/projects/${encodeURIComponent(o.projectId)}/workflows?fields=id`, body: { id: "{wf}" } }] : []),
  ];
  if (o.dryRun !== false) return { ok: true, dryRun: true, steps: plan.map((p) => ({ method: p.method, path: p.path, body: p.body })) };
  const f = o.fetchImpl ?? fetch; let wf = "";
  for (const p of plan) {
    const path = p.path.replace("{wf}", wf); const body = JSON.parse(JSON.stringify(p.body).replace('"{wf}"', JSON.stringify(wf)));
    const res = await f(base + path, { method: p.method, headers: { Authorization: `Bearer ${o.token}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    const st: DeployStep = { method: p.method, path, status: res.status };
    steps.push(st);
    if (!res.ok) return { ok: false, dryRun: false, steps, error: `${p.method} ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
    if (p.capture) { wf = ((await res.json()) as { id: string }).id; st.id = wf; }
  }
  return { ok: true, dryRun: false, steps };
}
