import { z } from "zod";

export const q = (s: string) => JSON.stringify(s);
/** Field / value names: conservative charset so nothing can break out of a literal or a search query. */
export const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.\-/]{0,60}$/;
export const FieldName = z.string().regex(NAME, "invalid field name");
export const Value = z.string().regex(NAME, "invalid value");
export const Login = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.\-@]{0,60}$/, "invalid login");
export const Cron = z.string().regex(/^(\S+ ){5}\S+$/, "Quartz cron needs 6 fields, e.g. '0 0 9 * * ?'");

const TPL_TOKEN = /\{\{\s*([a-zA-Z.:_ ]+?)\s*\}\}/g;
const TPL_ALLOWED = /^(issue\.(id|summary|reporter|assignee|project)|currentUser|field:[A-Za-z0-9][A-Za-z0-9 _.\-/]{0,60})$/;

/** Message templates -> JS string-concatenation expression. Only whitelisted placeholders. */
export function tpl(text: string): string {
  const parts: string[] = []; let last = 0; let m: RegExpExecArray | null;
  TPL_TOKEN.lastIndex = 0;
  while ((m = TPL_TOKEN.exec(text))) {
    if (!TPL_ALLOWED.test(m[1])) throw new Error(`template placeholder not allowed: {{${m[1]}}}`);
    if (m.index > last) parts.push(q(text.slice(last, m.index)));
    const t = m[1];
    if (t === "issue.id") parts.push("issue.id");
    else if (t === "issue.summary") parts.push("issue.summary");
    else if (t === "issue.reporter") parts.push("(issue.reporter ? issue.reporter.login : '')");
    else if (t === "issue.assignee") parts.push("String(fv(issue, 'Assignee') || 'unassigned')");
    else if (t === "issue.project") parts.push("issue.project.name");
    else if (t === "currentUser") parts.push("ctx.currentUser.login");
    else parts.push(`String(fv(issue, ${q(t.slice(6))}) == null ? '' : fv(issue, ${q(t.slice(6))}))`);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(q(text.slice(last)));
  return parts.length ? parts.join(" + ") : "''";
}
export function checkTpl(text: string) { tpl(text); return text; }
export const Template = z.string().min(1).max(600).refine((s) => { try { tpl(s); return true; } catch { return false; } }, "unsupported {{placeholder}}");

/** YouTrack search-query fragment for "value of field" (braces needed for spaces). */
export const qv = (v: string) => (/\s/.test(v) ? `{${v}}` : v);
export const qf = (f: string) => (/\s/.test(f) ? `{${f}}` : f);
