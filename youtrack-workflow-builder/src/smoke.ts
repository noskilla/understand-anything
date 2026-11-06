import { compileWorkflow } from "./compiler.js";
const r = compileWorkflow({ name: "demo", title: "Demo", rules: [{ id: "a-rule", title: "Auto assign", when: { block: "trigger.issue_created" }, if: [{ block: "condition.field_empty", params: { field: "Assignee" } }], then: [{ block: "action.assign", params: { mode: "round_robin", logins: ["alice", "bob"] } }, { block: "action.add_comment", params: { text: "Hi {{issue.reporter}}" } }] }] });
console.log(r.ok, r.issues); console.log(r.files["a-rule.js"]?.split("\n").slice(-22).join("\n"));
