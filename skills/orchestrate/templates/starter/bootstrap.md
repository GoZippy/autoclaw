# Bootstrap prompt

Paste this into any single agent on a fresh project. Run once. After this, switch the same window (or any other) to the **worker** or **coordinator** template.

```
/orchestrate init && /orchestrate plan
```

That's the whole prompt. No preamble, no follow-up. The skill is idempotent — re-running `plan` regenerates sprints in place against the current manifest.

If you don't have a manifest yet:

- If a Kiro spec exists at `.kiro/specs/*/tasks.md`, `/orchestrate init` offers to convert it to a manifest automatically — say yes.
- Otherwise, write `.autoclaw/orchestrator/manifests/<project>.yaml` first (format in [`docs/AGENT_WORKFLOW.md`](../../../../docs/AGENT_WORKFLOW.md) or the README's Orchestrate section), then re-run.

When this prompt finishes you should see:

- `.autoclaw/orchestrator/config.yaml`
- `.autoclaw/orchestrator/sprints/sprint-{1..N}.yaml`
- `.autoclaw/orchestrator/sprints/plan-summary.yaml`

If you don't, **don't** start workers yet — fix the planning error first, otherwise workers will spin on an empty plan.
