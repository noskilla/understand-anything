import vm from "node:vm";
import { matches, type SearchableIssue } from "./search.js";
import type { FieldType } from "../types.js";

export class WorkflowBlocked extends Error {}
export interface SchemaField { type: FieldType; values?: string[] }
export interface SimConfig {
  project: string; schema: Record<string, SchemaField>; resolvedStates: string[];
  users: { login: string; groups?: string[] }[]; now?: number;
}
interface Rec { id: string; num: number; project: string; summary: string; reporter: string; fields: Record<string, unknown>; tags: string[]; comments: { author: string; text: string }[]; updated: number; created: number }
interface TxIssue { isNew: boolean; fields: Record<string, unknown>; resolved: boolean; commentCount: number; tags: string[] }
export interface Effects { messages: string[]; notifications: { to: string; subject: string; body: string }[]; log: string[] }
export interface TxResult extends Effects { blocked?: string; ran: string[] }
interface LoadedRule { id: string; kind: "change" | "schedule"; def: any; fired: Set<string> }

const DAY = 86400000;
class Coll<T> {
  constructor(private a: T[]) {}
  forEach(f: (x: T) => void) { this.a.forEach(f); }
  isNotEmpty() { return this.a.length > 0; }
  isEmpty() { return this.a.length === 0; }
  get size() { return this.a.length; }
  get(i: number) { return this.a[i]; }
  [Symbol.iterator]() { return this.a[Symbol.iterator](); }
}

export class YouTrackSim {
  now: number;
  private recs = new Map<string, Rec>();
  private versions = new Map<string, number>();
  private links: { parent: string; child: string }[] = [];
  private rules: LoadedRule[] = [];
  private tx: Map<string, TxIssue> | null = null;
  private fx!: Effects;
  private counter = 0;
  readonly history: TxResult[] = [];
  constructor(public cfg: SimConfig) { this.now = cfg.now ?? Date.UTC(2026, 10, 6, 9, 0, 0); }

  // ---------- loading ----------
  load(files: Record<string, string>) {
    for (const [name, code] of Object.entries(files)) {
      if (!name.endsWith(".js")) continue;
      const exportsObj: any = {}; const self = this;
      const FakeDate = class extends Date { constructor(...a: any[]) { if (a.length) super(...(a as [any])); else super(self.now); } static now() { return self.now; } };
      const sandbox: any = {
        exports: exportsObj, Date: FakeDate, console: { log: (...a: unknown[]) => this.fx?.log.push(a.join(" ")) },
        require: (m: string) => this.requireShim(m),
      };
      vm.runInNewContext(code, sandbox, { filename: name, timeout: 2000 });
      const def = exportsObj.rule; if (!def) throw new Error(`${name}: no exports.rule`);
      this.checkRequirements(name, def.requirements ?? {});
      this.rules.push({ id: name.replace(/\.js$/, ""), kind: def.__kind, def, fired: new Set() });
    }
    // Every field the workflow references (typed or merely read) must exist in the project.
    if (files["manifest.json"]) for (const f of JSON.parse(files["manifest.json"]).requiredFields as { field: string }[])
      if (!this.cfg.schema[f.field]) throw new Error(`manifest: project has no field '${f.field}'`);
    return this;
  }
  private checkRequirements(file: string, req: Record<string, any>) {
    for (const [field, spec] of Object.entries(req)) {
      const s = this.cfg.schema[field];
      if (!s) throw new Error(`${file}: requirement not satisfied — project has no field '${field}'`);
      const wantType = spec.type?.__t;
      if (wantType && wantType !== s.type && !(wantType === "enum" && s.type === "state")) throw new Error(`${file}: field '${field}' is ${s.type}, rule expects ${wantType}`);
      for (const v of Object.keys(spec).filter((k) => k !== "type"))
        if (s.values && !s.values.includes(spec[v].name ?? v)) throw new Error(`${file}: field '${field}' has no value '${spec[v].name ?? v}'`);
    }
  }
  private requireShim(m: string): any {
    const ft = (t: string) => ({ fieldType: { __t: t } });
    const mkRule = (kind: "change" | "schedule") => (def: any) => { if (!def.title || typeof def.action !== "function") throw new Error("rule needs title and action"); if (kind === "schedule" && (!def.search || !def.cron)) throw new Error("onSchedule needs search and cron"); def.__kind = kind; return def; };
    if (m.endsWith("/entities")) return {
      Issue: { onChange: mkRule("change"), onSchedule: mkRule("schedule") },
      State: ft("state"), EnumField: ft("enum"), User: { ...ft("user"), findByLogin: (l: string) => this.user(l) },
      Field: { dateType: { __t: "date" }, stringType: { __t: "string" }, integerType: { __t: "integer" }, periodType: { __t: "period" } },
    };
    if (m.endsWith("/workflow")) return {
      message: (t: string) => this.fx.messages.push(String(t)),
      check: (cond: unknown, msg: string) => { if (!cond) throw new WorkflowBlocked(msg); },
    };
    if (m.endsWith("/search")) return { search: (_p: unknown, q: string) => new Coll(this.searchRecs(q).map((r) => this.issueProxy(r))) };
    throw new Error(`module not available in sandbox: ${m}`);
  }

  // ---------- model ----------
  private user(login: string | null | undefined) {
    if (!login) return null;
    const u = this.cfg.users.find((x) => x.login === login); if (!u) return null;
    return { login: u.login, fullName: u.login, isInGroup: (g: string) => (u.groups ?? []).includes(g), notify: (subject: string, body: string) => this.fx.notifications.push({ to: u.login, subject, body }) };
  }
  private isResolved(r: Rec) { return this.cfg.resolvedStates.includes(String(r.fields.State)); }
  private touch(r: Rec, isNew = false) {
    if (!this.tx) throw new Error("mutation outside a transaction");
    if (!this.tx.has(r.id)) this.tx.set(r.id, { isNew, fields: isNew ? {} : { ...r.fields }, resolved: isNew ? false : this.isResolved(r), commentCount: r.comments.length, tags: [...r.tags] });
  }
  private bump(r: Rec) { this.versions.set(r.id, (this.versions.get(r.id) ?? 0) + 1); r.updated = this.now; }
  private encode(field: string, v: unknown) {
    if (v === null || v === undefined) return null;
    if (typeof v === "object") { const o = v as any; if (o.name !== undefined) return o.name; if (o.login !== undefined) return o.login; throw new Error(`cannot assign object to ${field}`); }
    return v;
  }
  private decode(field: string, v: unknown) {
    if (v === null || v === undefined) return null;
    const t = this.cfg.schema[field]?.type;
    return t === "state" || t === "enum" ? { name: v } : t === "user" ? this.user(String(v)) : v;
  }
  private validateAssign(field: string, v: unknown) {
    const s = this.cfg.schema[field]; if (!s) throw new Error(`no such field '${field}'`);
    if (v === null) return;
    if ((s.type === "enum" || s.type === "state") && s.values && !s.values.includes(String(v))) throw new Error(`'${v}' is not a value of ${field}`);
    if (s.type === "user" && !this.user(String(v))) throw new Error(`unknown user '${v}'`);
    if (s.type === "integer" && typeof v !== "number") throw new Error(`${field} expects a number`);
    if (s.type === "date" && typeof v !== "number") throw new Error(`${field} expects a timestamp`);
  }

  private issueProxy(r: Rec): any {
    const sim = this;
    const fields = new Proxy({}, {
      get: (_t, k: string) => {
        if (k === "isChanged") return (f: string) => { const o = sim.tx?.get(r.id); return !!o && !sameVal(o.fields[f], r.fields[f]); };
        if (k === "oldValue") return (f: string) => { const o = sim.tx?.get(r.id); return sim.decode(f, o ? o.fields[f] : r.fields[f]); };
        return sim.decode(k, r.fields[k]);
      },
      set: (_t, k: string, v) => { const enc = sim.encode(k, v); sim.validateAssign(k, enc); sim.touch(r); if (!sameVal(r.fields[k], enc)) { r.fields[k] = enc; sim.bump(r); } return true; },
    });
    const resolvedNow = () => sim.isResolved(r);
    const parentsOf = () => sim.links.filter((l) => l.child === r.id).map((l) => sim.recs.get(l.parent)!);
    const childrenOf = () => sim.links.filter((l) => l.parent === r.id).map((l) => sim.recs.get(l.child)!);
    return {
      id: r.id, numberInProject: r.num, project: { name: r.project, shortName: r.project },
      get summary() { return r.summary; }, set summary(v: string) { sim.touch(r); r.summary = v; sim.bump(r); },
      get reporter() { return sim.user(r.reporter); }, fields,
      get isResolved() { return resolvedNow(); },
      get becomesResolved() { const o = sim.tx?.get(r.id); return !!o && !o.resolved && resolvedNow(); },
      get becomesUnresolved() { const o = sim.tx?.get(r.id); return !!o && !o.isNew && o.resolved && !resolvedNow(); },
      get becomesReported() { return !!sim.tx?.get(r.id)?.isNew; },
      get isReported() { return true; },
      hasTag: (t: string) => r.tags.includes(t),
      addTag: (t: string) => { sim.touch(r); if (!r.tags.includes(t)) { r.tags.push(t); sim.bump(r); } },
      removeTag: (t: string) => { sim.touch(r); const i = r.tags.indexOf(t); if (i >= 0) { r.tags.splice(i, 1); sim.bump(r); } },
      addComment: (text: string) => { sim.touch(r); r.comments.push({ author: "workflow", text: String(text) }); sim.bump(r); },
      comments: { get added() { const o = sim.tx?.get(r.id); return new Coll(r.comments.slice(o ? o.commentCount : r.comments.length).map((c) => ({ text: c.text, author: sim.user(c.author) ?? { login: c.author } }))); } },
      links: new Proxy({}, { get: (_t, type: string) => new Coll((type === "parent for" ? childrenOf() : type === "subtask of" ? parentsOf() : []).map((x) => sim.issueProxy(x))) }),
    };
  }
  private searchRecs(q: string) {
    return [...this.recs.values()].filter((r) => matches(this.toSearchable(r), q, this.now));
  }
  private toSearchable(r: Rec): SearchableIssue {
    return { id: r.id, project: r.project, updated: r.updated, resolved: this.isResolved(r), fields: r.fields, tags: r.tags, reporter: r.reporter };
  }

  // ---------- transactions ----------
  private runTx(setup: () => void, actor: string): TxResult {
    const snapshot = structuredClone({ recs: [...this.recs], versions: [...this.versions], links: this.links, counter: this.counter });
    this.tx = new Map(); this.fx = { messages: [], notifications: [], log: [] };
    const ran: string[] = [];
    try {
      setup();
      this.cascade(actor, ran);
      const res: TxResult = { ...this.fx, ran }; this.history.push(res); return res;
    } catch (e) {
      this.recs = new Map(snapshot.recs); this.versions = new Map(snapshot.versions); this.links = snapshot.links; this.counter = snapshot.counter;
      if (e instanceof WorkflowBlocked) { const res: TxResult = { ...this.fx, blocked: e.message, ran }; this.history.push(res); return res; }
      throw e;
    } finally { this.tx = null; }
  }
  /**
   * Semantics (documented assumption): an on-change rule runs at most once per issue per transaction, but a rule whose guard
   * was false earlier can still fire after another rule changed the issue. Passes repeat until no rule fires.
   */
  private cascade(actor: string, ran: string[]) {
    for (const rule of this.rules) rule.fired.clear();
    for (let pass = 0; pass < 8; pass++) {
      let fired = false;
      for (const rule of this.rules.filter((x) => x.kind === "change")) {
        for (const id of [...this.tx!.keys()]) {
          if (rule.fired.has(id)) continue;
          const ctx = this.ruleCtx(this.recs.get(id)!, actor);
          if (rule.def.guard ? rule.def.guard(ctx) : true) { rule.fired.add(id); fired = true; ran.push(`${rule.id}@${id}`); rule.def.action(ctx); }
        }
      }
      if (!fired) return;
    }
    throw new Error("workflow did not stabilise after 8 passes");
  }
  private ruleCtx(r: Rec, actor: string) {
    const self = this;
    const ctx: any = new Proxy({ issue: this.issueProxy(r), currentUser: this.user(actor) }, {
      get: (t: any, k: string) => {
        if (k in t) return t[k];
        const s = self.cfg.schema[k]; if (!s) return undefined;
        const rule = self.rules.find((x) => x.def.requirements?.[k]);
        void rule;
        return new Proxy({}, { get: (_x, v: string) => { if (s.values && !s.values.includes(v)) throw new Error(`value '${v}' not defined for ${k}`); return { name: v }; } });
      },
    });
    return ctx;
  }

  // ---------- public API ----------
  createIssue(p: { summary: string; reporter: string; fields?: Record<string, unknown>; tags?: string[] }): { id: string; result: TxResult } {
    let id = "";
    const result = this.runTx(() => {
      const num = ++this.counter; id = `${this.cfg.project}-${num}`;
      const r: Rec = { id, num, project: this.cfg.project, summary: p.summary, reporter: p.reporter, fields: {}, tags: [...(p.tags ?? [])], comments: [], updated: this.now, created: this.now };
      for (const [k, v] of Object.entries(this.defaultFields())) r.fields[k] = v;
      for (const [k, v] of Object.entries(p.fields ?? {})) { this.validateAssign(k, v as any); r.fields[k] = v; }
      this.recs.set(id, r); this.touch(r, true); this.bump(r);
    }, p.reporter);
    return { id, result };
  }
  private defaultFields(): Record<string, unknown> {
    const d: Record<string, unknown> = {};
    for (const [f, s] of Object.entries(this.cfg.schema)) d[f] = s.type === "state" ? s.values?.[0] ?? null : null;
    return d;
  }
  update(id: string, p: { fields?: Record<string, unknown>; comment?: string; addTags?: string[]; actor: string }): TxResult {
    return this.runTx(() => {
      const r = this.rec(id); this.touch(r);
      for (const [k, v] of Object.entries(p.fields ?? {})) { this.validateAssign(k, v as any); if (!sameVal(r.fields[k], v)) { r.fields[k] = v; this.bump(r); } }
      if (p.comment) { r.comments.push({ author: p.actor, text: p.comment }); this.bump(r); }
      for (const t of p.addTags ?? []) if (!r.tags.includes(t)) { r.tags.push(t); this.bump(r); }
    }, p.actor);
  }
  link(parentId: string, childId: string) { this.links.push({ parent: parentId, child: childId }); }
  advance(days: number) { this.now += days * DAY; }
  /** Fire all (or one) scheduled rules once, as the YouTrack scheduler would. */
  runSchedules(only?: string): TxResult {
    return this.runTx(() => {
      for (const rule of this.rules.filter((x) => x.kind === "schedule" && (!only || x.id === only))) {
        for (const r of this.searchRecs(rule.def.search)) {
          this.touch(r); const ctx = this.ruleCtx(r, "system");
          if (rule.def.guard ? rule.def.guard(ctx) : true) { this.fx.log.push(`${rule.id}@${r.id}`); rule.def.action(ctx); }
        }
      }
    }, "system");
  }
  private rec(id: string) { const r = this.recs.get(id); if (!r) throw new Error(`no issue ${id}`); return r; }
  get(id: string) {
    const r = this.rec(id);
    return { id, summary: r.summary, fields: { ...r.fields }, tags: [...r.tags], comments: r.comments.map((c) => ({ ...c })), updated: r.updated };
  }
  ruleIds() { return this.rules.map((r) => r.id); }
}
function sameVal(a: unknown, b: unknown) { return (a ?? null) === (b ?? null); }
