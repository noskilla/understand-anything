/** Minimal YouTrack search-query evaluator (the subset the blocks emit + common hand-written queries). */
export interface SearchableIssue { id: string; project: string; updated: number; resolved: boolean; fields: Record<string, unknown>; tags: string[]; reporter: string }

const DAY = 86400000;
const startOfDay = (t: number) => { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };

function tokenize(q: string): string[] {
  const out: string[] = []; let i = 0;
  while (i < q.length) {
    if (q[i] === " ") { i++; continue; }
    let depth = 0, j = i;
    while (j < q.length && (depth > 0 || q[j] !== " ")) { if (q[j] === "{") depth++; if (q[j] === "}") depth--; j++; }
    out.push(q.slice(i, j)); i = j;
  }
  // YouTrack allows `Field: value` with a space after the colon.
  const merged: string[] = [];
  for (const t of out) { if (merged.length && merged[merged.length - 1].endsWith(":")) merged[merged.length - 1] += t; else merged.push(t); }
  return merged;
}
const unbrace = (s: string) => (s.startsWith("{") && s.endsWith("}") ? s.slice(1, -1) : s);

function dateExpr(s: string, now: number): number | null {
  const t = unbrace(s.trim());
  if (t === "*") return null;
  if (/^today$/i.test(t)) return startOfDay(now);
  let m = /^minus (\d+)([dwh])$/.exec(t) ?? /^plus (\d+)([dwh])$/.exec(t);
  if (m) { const u = m[2] === "d" ? DAY : m[2] === "w" ? 7 * DAY : 3600000; return now + (t.startsWith("minus") ? -1 : 1) * Number(m[1]) * u; }
  const p = Date.parse(t); if (!Number.isNaN(p)) return p;
  throw new Error(`unsupported date expression '${s}'`);
}

export function matches(issue: SearchableIssue, query: string, now: number): boolean {
  for (const tok of tokenize(query)) {
    if (tok === "#Unresolved") { if (issue.resolved) return false; continue; }
    if (tok === "#Resolved") { if (!issue.resolved) return false; continue; }
    const m = /^(-?)(\{[^}]*\}|[\w-]+):(.*)$/.exec(tok);
    if (!m) throw new Error(`unsupported search token '${tok}'`);
    const neg = m[1] === "-"; const key = unbrace(m[2]); const val = m[3];
    let ok: boolean;
    if (key.toLowerCase() === "project") ok = issue.project.toLowerCase() === unbrace(val).toLowerCase();
    else if (key.toLowerCase() === "tag") ok = issue.tags.map((t) => t.toLowerCase()).includes(unbrace(val).toLowerCase());
    else if (val.includes("..")) {
      const [a, b] = val.split(".."); const lo = dateExpr(a, now), hi = dateExpr(b, now);
      const v = key.toLowerCase() === "updated" ? issue.updated : (issue.fields[key] as number | null | undefined);
      // `{Today}..{plus Nd}` is a whole-day range; `*..{minus Nd}` an instant bound.
      const hiEnd = hi !== null && /today|plus/i.test(b) ? startOfDay(hi) + DAY - 1 : hi;
      ok = typeof v === "number" && (lo === null || v >= lo) && (hiEnd === null || v <= hiEnd);
    } else {
      const wanted = splitTop(val).map((x) => unbrace(x).toLowerCase());
      const v = issue.fields[key]; ok = v !== null && v !== undefined && wanted.includes(String(v).toLowerCase());
    }
    if (neg ? ok : !ok) return false;
  }
  return true;
}
function splitTop(s: string): string[] {
  const out: string[] = []; let d = 0, cur = "";
  for (const ch of s) { if (ch === "{") d++; if (ch === "}") d--; if (ch === "," && d === 0) { out.push(cur); cur = ""; } else cur += ch; }
  out.push(cur); return out;
}
