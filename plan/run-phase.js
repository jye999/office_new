// Runs plan tasks sequentially on the local Qwen model; stops at first failure.
// Usage: subagent({ workflow: "./plan/run-phase.js", args: { ids: ["T00","T01"] }, cwd: "/home/johnny/code/office_new" })
const results = [];
for (const id of args.ids) {
  const r = await runs.run(id, {
    agent: "worker",
    model: "D:\\models\\Swift-Qwen3.8-27B-Q5_K_M.gguf:medium",
    cwd: "/home/johnny/code/office_new",
    timeoutMs: 7200000,
    task: `You are porting a PHP Laravel app to TypeScript. Your task id is ${id}.

1. Read /home/johnny/code/office_new/plan/CONVENTIONS.md, then plan/PLAN.md, then plan/tasks/${id}.md. Follow the task file exactly.
2. The old app at /home/johnny/code/office is READ-ONLY. Never modify it. Work only inside /home/johnny/code/office_new.
3. Read previous tasks' entries in plan/STATUS.md and reuse what they built. Do not rewrite shared files from earlier tasks unless your task says so.
4. Never call anything that buys postage, uploads tracking, writes to a marketplace, or sends email.
5. Run the verification steps in the task file. Fix failures before finishing. Do not claim something passed unless you ran it and saw it pass.
6. Append your "## ${id} — done|partial|blocked" entry to plan/STATUS.md (files created, what you verified with the actual command output summary, what is not verified, open questions).
7. Commit: git add -A && git commit -m "${id}: <short summary>".
Final answer: the STATUS.md entry you wrote.`,
  });
  results.push({ id, ok: r.ok, output: r.output });
  if (!r.ok) break;
}
return results;
