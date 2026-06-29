# Agentic AI Workflow Research Synthesis

Date: 2026-06-27

This folder contains local copies of the requested papers plus a small related set
selected for direct relevance to AutoClaw's current direction: long-running
multi-agent orchestration, context packs, KG/intelligence convergence, reputation
routing, gates, and agent workflow automation.

## Local Source Inventory

Requested papers:

- `2510.04871v1-less-is-more-recursive-reasoning.html` and `.pdf`:
  [Less is More: Recursive Reasoning with Tiny Networks](https://arxiv.org/html/2510.04871v1)
- `2511.00592v2-agentic-auto-scheduling.html`, `2511.00592-agentic-auto-scheduling.abs.html`, and `.pdf`:
  [Agentic Auto-Scheduling: An Experimental Study of LLM-Guided Loop Optimization](https://arxiv.org/html/2511.00592v2)
- `2604.15771v3-skill-rag.html`, `2604.15771-skill-rag.abs.html`, and `.pdf`:
  [Skill-RAG: Failure-State-Aware Retrieval Augmentation via Hidden-State Probing and Skill Routing](https://arxiv.org/abs/2604.15771)
- `2510.12803v1-autocode.html`, `2510.12803-autocode.abs.html`, and `.pdf`:
  [AutoCode: LLMs as Problem Setters for Competitive Programming](https://arxiv.org/html/2510.12803v1)

Related papers pulled for context:

- `related/2509.16941-swe-bench-pro.*`:
  [SWE-Bench Pro: Can AI Agents Solve Long-Horizon Software Engineering Tasks?](https://arxiv.org/abs/2509.16941)
- `related/2501.09136-agentic-rag-survey.*`:
  [Agentic Retrieval-Augmented Generation: A Survey on Agentic RAG](https://arxiv.org/abs/2501.09136)
- `related/2604.24594-skill-retrieval-augmentation.*`:
  [Skill Retrieval Augmentation for Agentic AI](https://arxiv.org/abs/2604.24594)
- `related/2602.08146-advertest.*`:
  [Test vs Mutant: Adversarial LLM Agents for Robust Unit Test Generation](https://arxiv.org/abs/2602.08146)
- `related/2601.07136-multi-agent-ai-systems-study.*`:
  [A Large-Scale Study on the Development and Issues of Multi-Agent AI Systems](https://arxiv.org/abs/2601.07136)
- `related/2506.11442-reveal.*`:
  [ReVeal: Self-Evolving Code Agents via Iterative Generation-Verification](https://arxiv.org/abs/2506.11442)

## Executive Takeaways for AutoClaw

The strongest shared lesson is not "make the model smarter." It is "make the
loop smarter." The papers that matter most for AutoClaw all converge on four
engineering patterns:

1. Give agents a small, explicit action space backed by deterministic tools.
2. Treat tool feedback as the optimization signal, not as incidental logging.
3. Route failures by type, then invoke the right corrective skill or stop.
4. Measure verifier quality separately from generator quality.

AutoClaw already has the right substrate for this: context packs, gates,
reputation ledger, KG/intelligence storage, hooks, runner registry, board state,
and multi-agent comms. The next leverage is to tighten those pieces into
closed-loop workflows with typed failure states and measurable verifier quality.

## Paper Notes

### Less is More: Recursive Reasoning with Tiny Networks

Core idea:

The paper critiques complex hierarchical-recursive reasoning models and shows
that much of the benefit can come from simpler recursive/deep-supervision
structure rather than elaborate biological or hierarchy-inspired machinery.
Their Tiny Recursion Model uses a much smaller model and simpler recursion, yet
reports stronger generalization than the heavier HRM baseline on Sudoku,
Maze-Hard, ARC-AGI-1, and ARC-AGI-2.

Critical read:

- This is supervised, puzzle-oriented work, not an agent workflow paper.
- The AutoClaw-relevant lesson is architectural: recursion helps when each
  iteration is forced through a useful state transition and a supervision point.
- The paper is also a warning against over-explaining orchestration with grand
  hierarchy metaphors. If a simple recursive loop plus evidence checkpoints
  works, prefer that.
- It does not prove recursion is generally better for software work; it shows
  that small, repeated reasoning state updates can beat larger one-pass designs
  on constrained domains.

AutoClaw implication:

- Keep v4's org model, but avoid making the org chart the source of intelligence.
  The intelligence should come from repeated, measurable state transitions:
  plan -> act -> gate -> diagnose -> retry/route/stop.
- Add "supervision checkpoints" to long-running tasks: context-pack read,
  claim/scope validation, acceptance command, reviewer gate, failure diagnosis,
  memory write.

### Agentic Auto-Scheduling

Core idea:

ComPilot gives the LLM a bounded loop-transformation API and lets the compiler
handle legality and measurement. The LLM proposes schedules; the compiler
returns legality and performance feedback; the LLM iterates. The paper reports
2.66x geometric mean speedup in a single run and 3.54x best-of-5 over original
code on PolyBench, and strong results against Pluto and Tiramisu autoschedulers.

Critical read:

- This is a strong fit for AutoClaw because it validates an LLM-as-policy,
  deterministic-tool-as-judge pattern.
- The action space is narrow and parseable. That is why the loop works.
- Direct code rewriting underperformed the structured transformation API by
  roughly 14-16% in their ablation. That maps directly to AutoClaw: agents should
  not always edit raw code when a safer structured action exists.
- Their invalid/illegal/runnable split matters. AutoClaw should log failure
  classes at each gate, not just "failed."
- Best-of-N helped, but it has cost implications. Reputation routing and budget
  ceilings should decide when to fan out.

AutoClaw implication:

- Introduce "structured action lanes" for common high-risk workflows:
  dependency upgrades, refactors, test generation, release prep, prompt/skill
  edits, and config migrations.
- Give agents tool schemas that encode legal moves, then let tools/gates enforce
  legality. Example: a `refactor.plan` tool that emits file moves, symbol
  renames, and import updates before edits happen.
- Extend gate results with typed verdicts: `format_invalid`, `tool_illegal`,
  `compile_error`, `test_fail`, `perf_regression`, `scope_violation`,
  `acceptance_fail`, `unsafe_write`.

### Skill-RAG

Core idea:

Skill-RAG treats retrieval failure as diagnostic, not just as a retry trigger.
When retrieval stalls, a router selects one of four skills: query rewriting,
question decomposition, evidence focusing, or exit. The paper reports strongest
gains on OOD/multi-hop datasets and reduced retrieval rounds, especially by
using exit when further retrieval is unlikely to pay off.

Critical read:

- The hidden-state probing part may not be directly available for black-box
  models and hosted tools. AutoClaw should not depend on internal model states.
- The actionable abstraction is still valuable: failures are typed, and each type
  has a different remediation path.
- The exit skill is important. A mature agentic system needs graceful stopping,
  not endless retries disguised as diligence.
- Their four-skill vocabulary is deliberately small. AutoClaw should resist a
  sprawling failure router until metrics prove the need.

AutoClaw implication:

- Add failure-aware context-pack retrieval:
  `rewrite_query`, `decompose_task`, `focus_evidence`, `exit_or_escalate`.
- Track RAG/context-pack outcomes: hits used, files touched, acceptance pass,
  rework count, retrieval rounds, and whether the agent reported missing context.
- Add a "retrieval budget exhausted" stop reason to prevent context pack churn.
- Use observable proxies instead of hidden states: repeated low-overlap hits,
  unchanged top-K across retries, missing referenced symbol, failing same test
  after context refresh, or agent declares "cannot find evidence."

### AutoCode

Core idea:

AutoCode uses LLMs as problem setters and test-data builders through a
multi-role closed loop: validator, generator, checker, and interactor. It uses
near-valid invalid cases, diverse generators, mutants, and cross-verification to
produce robust competitive-programming tests and problem variants. It reports
98%+ agreement with official judgments on a modern Codeforces benchmark.

Critical read:

- This is less about competitive programming and more about verifier design.
- Near-valid invalid cases are a high-value idea for AutoClaw: test not only the
  happy path but also subtly malformed tasks, bad manifests, stale claims,
  conflicting leases, invalid runner configs, and incomplete context packs.
- Their problem-generation results expose a key weakness: LLM self-judgment of
  quality/novelty correlated poorly with human experts. AutoClaw should not rely
  on agents to grade their own work products without external signals.
- Their validator-generator-checker split matches AutoClaw's planned persona
  roster and gates.

AutoClaw implication:

- Add "validator tests" for AutoClaw control-plane artifacts:
  `org.yaml`, task manifests, scope leases, runner registrations, context packs,
  relay payloads, KG facts, and hook rules.
- Add adversarial/near-valid fixture generation to specs. For example, invalid
  hook rules that almost pass, stale claims with healthy agent IDs but dead
  session IDs, and context packs with duplicate H1s or unverifiable citations.
- Score verifier quality with FPR/FNR where possible. A gate that rejects good
  work is as damaging as a gate that accepts bad work.

## Related Work Context

### SWE-Bench Pro

This benchmark is directly aligned with AutoClaw's target environment:
long-horizon, enterprise-style tasks that can take hours or days and often span
multiple files. The key point for AutoClaw is that "task resolvability" requires
human-verified context and failure-mode analysis, not just a GitHub issue and a
repo checkout.

AutoClaw implication:

- Treat context completeness as a first-class gate before dispatch.
- Add a task-size classifier: short patch, medium feature, long-horizon feature,
  migration, release, research/design.
- For long-horizon tasks, require checkpoints and handoff snapshots, not a single
  final report.

### Agentic RAG Survey

The survey's workflow taxonomy maps closely to AutoClaw's architecture:
prompt chaining, routing, parallelization, orchestrator-workers, and
evaluator-optimizer. It also warns that agentic RAG is not always the right
default and that autonomy needs explicit constraints.

AutoClaw implication:

- Make context-pack generation mode-selectable:
  simple RAG, graph-enhanced RAG, corrective RAG, multi-agent RAG, or no RAG.
- Use constraints and budgets as part of every RAG/workflow mode.

### Skill Retrieval Augmentation

This paper argues that stuffing all skills into context does not scale, and that
agents need retrieval over a structured skill corpus. It explicitly calls for
structured skill libraries, quality control, skill evolution, and utility-aware
retrieval.

AutoClaw implication:

- Move Launch Skill and adapter prompts toward a searchable skill index with:
  tags, prerequisites, failure modes, examples, accepted inputs, expected
  artifacts, historical success rate, and cost.
- Integrate REP-1 with skill retrieval: route by demonstrated utility, not just
  semantic similarity.

### AdverTest

AdverTest uses a test-generation agent and mutant-generation agent in an
adversarial loop. It reports better real-fault detection than prior LLM and
search-based baselines. The important lesson is that coverage is not enough:
the tests must kill plausible mutants.

AutoClaw implication:

- Add an AutoClaw "mutant critic" role for code and control-plane specs.
- For high-risk code changes, require generated tests to kill at least one
  plausible bug mutant or exercise a known failure mode.
- For orchestration workflows, generate protocol mutants: wrong agent type,
  missing session ID, stale lease, malformed hook payload, wrong relay scope.

### Multi-Agent AI Systems Maintenance Study

The study found that bugs, infrastructure, and agent-coordination issues are
major maintenance concerns in multi-agent frameworks. This validates the current
Coordination Layer v2 emphasis: auto-announce, telemetry split, claim reaper,
scope leases, and `fleet.brief`.

AutoClaw implication:

- Prioritize coordination reliability over adding more agent personas.
- Add maintenance telemetry categories that mirror the study:
  bug, infrastructure, agent coordination, data/indexing, documentation, UX.
- Track issue-like failure clusters locally even if AutoClaw does not use GitHub
  Issues as its planning source.

### ReVeal

ReVeal alternates generation and verification, using dense turn-level feedback
instead of sparse final outcome rewards. The relevant idea is not the RL training
itself; it is the loop shape and feedback templates.

AutoClaw implication:

- Make every long-running task log turn-level reward/progress signals:
  compile passed, tests passed, verifier generated valid test, reviewer accepted,
  scope clean, context sufficient, no regression.
- Feed these signals into reputation and future routing.

## Recommended AutoClaw Improvements

### 1. Typed Failure Taxonomy

Add a shared taxonomy used by gates, context packs, hooks, and reputation:

- `context_missing`
- `context_noisy`
- `query_too_broad`
- `task_needs_decomposition`
- `artifact_invalid`
- `scope_conflict`
- `tool_format_invalid`
- `tool_action_illegal`
- `compile_error`
- `test_failure`
- `mutation_survived`
- `acceptance_failure`
- `perf_regression`
- `coordination_stale_claim`
- `coordination_dead_session`
- `budget_exhausted`
- `irreducible_or_needs_human`

This should be an enum in TypeScript, not prose in prompts.

### 2. Failure-Aware Context Pack v2

Extend `src/intelligence/contextPack.ts` with remediation modes:

- `normal`: current behavior.
- `rewrite`: reformulate the retrieval query when hits are low/noisy.
- `decompose`: split task into subtasks and retrieve per subtask.
- `focus`: retrieve missing symbols/files/tests from current evidence gaps.
- `exit`: stop context retries and emit a reason plus escalation path.

The context pack summary should include:

- retrieval mode
- failure type, if any
- retrieval rounds used
- unchanged-top-k count
- code hits, learning hits, KG hits
- confidence/degraded flags
- suggested next skill

### 3. Structured Action Lanes

Define narrow tool/action schemas for workflows where agents often drift:

- `test.generate`: target file, behavior, edge cases, expected assertions.
- `mutation.generate`: target function, mutation constraints, expected kill.
- `refactor.plan`: symbols, files, allowed edit kinds, expected imports.
- `release.check`: version, package, changelog, registry verification.
- `coordination.repair`: stale claims, dead sessions, scope overlaps.
- `skill.update`: failure mode, new instruction, evidence link.

This follows the ComPilot lesson: let the LLM choose among legal actions, and let
deterministic code execute and judge them.

### 4. Verifier Quality Metrics

Add metrics for gates and generated tests:

- false accept proxy: later failure after gate pass.
- false reject proxy: human/independent reviewer override.
- mutation score.
- valid-test rate.
- acceptance-test specificity.
- repeated failure class after retry.

These metrics should feed REP-1/REP-2 so AutoClaw can route verification work to
agents and skills with actual verifier track records.

### 5. Adversarial Fixture Generation for the Control Plane

Create near-valid fixture suites for:

- hooks
- claims
- heartbeats
- scope leases
- relay payloads
- `org.yaml`
- context packs
- KG facts
- runner manifests

This is the AutoCode/AdverTest idea applied to AutoClaw itself. It should expose
bugs that normal happy-path unit tests miss.

### 6. Fleet Brief as the One Read

The research reinforces Coordination Layer v2. Implement `fleet.brief` as the
single startup artifact for every agent:

- active sessions
- claimed scopes
- stale/dead sessions
- current branch/PR
- open tasks
- relevant context pack path
- known blocked gates
- recent failure clusters
- what not to touch

This reduces human intervention and addresses the maintenance-study finding that
coordination issues are a top class of multi-agent system failures.

### 7. Skill Index + Utility-Aware Retrieval

Create a structured skill catalog, then rank skills by:

- semantic match
- required host/tool availability
- historical success rate by task tag
- average cost/time
- known failure modes
- last updated
- confidence/provenance

This unifies Launch Skill, context packs, skill retrieval augmentation, and the
reputation ledger.

## Suggested Sequencing

1. Add the typed failure enum and gate/context-pack summary fields.
2. Implement Failure-Aware Context Pack v2 with `rewrite`, `decompose`, `focus`,
   and `exit` modes using observable proxies, not hidden states.
3. Add `fleet.brief` as an MCP/read artifact and make worker templates read it
   at session start.
4. Add adversarial near-valid fixtures for coordination artifacts.
5. Add mutation-guided test generation for high-risk code paths.
6. Build the skill index and wire utility-aware retrieval to REP-1.
7. Add structured action lanes for release, refactor, test, and coordination
   repair workflows.

## Open Questions

- Should failure taxonomy live under `src/orchestrator`, `src/intelligence`, or
  a shared `src/diagnostics` module?
- How much of context-pack v2 should be available through MCP/HTTP versus only
  local files?
- Which high-risk workflow should get the first structured action lane:
  release, coordination repair, or test generation?
- Can AutoClaw measure false rejects without adding too much human burden?

## Bottom Line

AutoClaw's roadmap is aligned with the literature, but the next step should be
more disciplined loops, not more agents. The best immediate improvements are:
typed failure routing, failure-aware context packs, verifier-quality metrics,
adversarial control-plane fixtures, and utility-aware skill retrieval. These are
all compatible with the current local-first, opt-in, evidence-grounded design.
