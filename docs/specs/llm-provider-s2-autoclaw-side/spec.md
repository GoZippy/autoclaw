---
spec_id: llm-provider-s2-autoclaw-side
title: Phase B S2 (AutoClaw side) — recommendModel HTTP swap + autoclaw llm install
status: pilot
owner: architect
created: 2026-05-29
updated: 2026-05-29
pilot_evidence:
  - "758 passing tests (9 new for S2, 0 failing) — 2026-05-29"
  - "recommendModel HTTP swap covered with happy/404/502/transport/handler-failure/legacy-shape cases"
  - "installLlm covered with fresh / idempotent re-run / unreachable / playbook-API-down / --ollama / report-format paths"
  - "Compile clean (tsc -p ./), adapters:check green, autoclaw.llm.install command palette entry registered"
supersedes: []
superseded_by: null
references:
  - docs/rfc/llm-provider-abstraction.md
  - docs/specs/llm-provider-s1/spec.md
  - docs/specs/llm-provider-s2-zmlr-mcp-route/spec.md
  - src/mcp/install.ts
  - src/llm/zippymesh.ts
acceptance:
  - given: "ZMLR is running with the S2 MCP route deployed at :20128/mcp"
    when: "ZippyMeshProvider.recommendModel('code', { preferLocal: true }) is called"
    then: "the method POSTs `{ tool: 'recommend_model', input: { intent: 'code', constraints: { prefer_local: true } } }` and returns `{ model: '<resolved>', fallbackChain: [...] }`"
  - given: "ZMLR is running but the /mcp route is NOT deployed (older ZMLR version)"
    when: "recommendModel is called"
    then: "the POST returns 404; the method returns null without throwing (registry falls through to oracle, S1-stopgap behavior preserved)"
  - given: "ZMLR is running but recommend_model handler self-reports `{ success: false, error: '...' }`"
    when: "recommendModel is called"
    then: "the method returns null; one debug log line is written; no exception escapes"
  - given: "ZMLR is unreachable (connection refused)"
    when: "recommendModel is called with timeoutMs: 2000"
    then: "the method returns null within 2 seconds; no exception escapes"
  - given: "a clean workspace with no .autoclaw/llm/ directory"
    when: "`autoclaw llm install --zippymesh` runs against a reachable ZMLR"
    then: "the command writes `.autoclaw/llm/config.yaml` with one `providers:` entry for ZMLR, imports the two shipped playbooks via ZMLR's API (idempotent — check IDs first), and registers `http://localhost:20128/mcp` in the workspace MCP server config; the report includes one row per side-effect, all `added`"
  - given: "the same workspace immediately after a successful install"
    when: "`autoclaw llm install --zippymesh` runs again"
    then: "every row is `unchanged`; no files are touched; ZMLR is not called for playbook imports (we check by ID first)"
  - given: "ZMLR is unreachable"
    when: "`autoclaw llm install --zippymesh` runs"
    then: "the report is one row `zippymesh: skipped — unreachable`; no files are written; exit code 0"
non_goals:
  - Ollama side of `autoclaw llm install` — same shape, separate slice (S2.2).
  - Streaming `llm.chat.stream` — defer.
  - Pushing the ZMLR PR itself — owner is the user; this spec only covers what AutoClaw does AFTER the PR lands.
  - Updating the persona loader — it already calls `LlmRegistry.getPreferred()` which uses recommendModel; no loader change.
---

# Phase B S2 (AutoClaw side) — recommendModel HTTP + autoclaw llm install

## Summary

Two deliverables on top of the merged S1 foundation:

1. **`ZippyMeshProvider.recommendModel()` swap** from the S1 `return null` stopgap to a real HTTP call against ZMLR's new `/mcp` route. The fall-through-on-failure semantics are preserved exactly — anything that isn't `{ success: true, ... }` returns `null` so the registry's oracle branch handles it.
2. **`autoclaw llm install --zippymesh`** — a new command that wires ZMLR into a workspace: writes `.autoclaw/llm/config.yaml`, imports the shipped playbooks via ZMLR's API, registers `:20128/mcp` in the workspace MCP server config. Same idempotency posture as `autoclaw mcp install`.

S2 is the smallest possible step that closes the loop: AutoClaw asks ZMLR "what model should I use for this intent?" and ZMLR's existing routing engine answers. Before S2, the registry always falls through to the oracle ladder — which works but bypasses ZMLR's playbook scoring, prompt cache, virtual-key budgets, and cost-aware routing.

## Read first

- [docs/rfc/llm-provider-abstraction.md](../../rfc/llm-provider-abstraction.md) §3.4 (ZMLR adapter), §6 (config surface), §7 (MCP angle)
- [docs/specs/llm-provider-s1/spec.md](../llm-provider-s1/spec.md) — the foundation this builds on
- [docs/specs/llm-provider-s2-zmlr-mcp-route/spec.md](../llm-provider-s2-zmlr-mcp-route/spec.md) — the ZMLR-side PR this consumes
- [src/llm/zippymesh.ts](../../../src/llm/zippymesh.ts) — the file recommendModel lives in
- [src/mcp/install.ts](../../../src/mcp/install.ts) — the install pattern this command mirrors (idempotent, scope-aware, `formatReport`-style output)
- [adapters/zippymesh/mateam-playbook.json](../../../adapters/zippymesh/mateam-playbook.json) and [adapters/zippymesh/kdream-playbook.json](../../../adapters/zippymesh/kdream-playbook.json) — the shipped playbooks the installer imports

## Design

### Inputs

1. Existing `.autoclaw/llm/config.yaml` if any (the installer is idempotent — read existing entries before writing).
2. Existing workspace MCP server config (the installer adds an entry, doesn't replace the file).
3. The two shipped playbook JSON files in `adapters/zippymesh/`.
4. Ambient `ZIPPYMESH_HOST` env (default `http://127.0.0.1:20128`) and `ZIPPYMESH_TOKEN` if set.

### Outputs

1. `.autoclaw/llm/config.yaml` — created or updated with the ZMLR entry.
2. Workspace MCP server config — updated with `{ name: 'zmlr', url: 'http://127.0.0.1:20128/mcp' }`.
3. ZMLR's dashboard playbook list — one entry per shipped playbook (idempotent — check existing IDs first).
4. Stdout — a `formatReport`-style summary table.

### recommendModel HTTP contract

```ts
// src/llm/zippymesh.ts — replace S1 stopgap
async recommendModel(
  intent: string,
  constraints?: RecommendModelConstraints,
): Promise<RecommendModelResult | null> {
  const mcpUrl = this.deriveMcpUrl();          // e.g. http://127.0.0.1:20128/mcp
  try {
    const res = await this.fetchImpl(mcpUrl, {
      method: 'POST',
      headers: this.buildHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        tool: 'recommend_model',
        input: {
          intent,
          constraints: constraints && this.mapConstraintsToHandlerShape(constraints),
        },
      }),
      signal: AbortSignal.timeout(2_000),
    });
    if (res.status === 404) return null;        // older ZMLR — route not deployed
    if (!res.ok) return null;                   // any HTTP error → null
    const json = (await res.json()) as RecommendModelHandlerResponse;
    if (!json.success) return null;             // handler self-reported failure
    return this.parseHandlerResponse(json);     // → { model, fallbackChain }
  } catch {
    return null;                                // timeout / transport → null
  }
}
```

The handler's response shape (from [the ZMLR-side spec](../llm-provider-s2-zmlr-mcp-route/spec.md)) is `{ success: true, recommendations: [{ model, ... }], fallbackChain: [...] }`. We pick `recommendations[0].model` (or `recommendations[0]` if it's already a string) and pass through `fallbackChain` as-is.

### `autoclaw llm install --zippymesh` design

New module `src/llm/install.ts`. Mirrors `src/mcp/install.ts` patterns:

```ts
// src/llm/install.ts
export type LlmInstallOutcome = 'added' | 'unchanged' | 'updated' | 'skipped' | 'error';

export interface LlmInstallStep {
  /** One side-effect row. */
  step: 'config' | 'playbook' | 'workspace-mcp';
  /** What this step touched. */
  target: string;
  outcome: LlmInstallOutcome;
  detail: string;
}

export interface LlmInstallOptions {
  workspaceRoot?: string;
  scope?: 'workspace' | 'user';
  /** Provider toggles — match the CLI flags. */
  zippymesh?: boolean;
  ollama?: boolean;
  /** Override the ZMLR base URL (for tests and remote ZMLR). */
  zippymeshHost?: string;
  /** Test hook — replace global fetch. */
  fetchImpl?: typeof fetch;
}

export interface LlmInstallReport {
  steps: LlmInstallStep[];
  /** True when no step is `error`. (Skipped + unchanged are both fine.) */
  ok: boolean;
}

export async function installLlm(opts: LlmInstallOptions): Promise<LlmInstallReport>;
export function formatLlmInstallReport(report: LlmInstallReport): string;
```

**Step 1 — config write** (`config` step):
- Detect ZMLR via `GET ${host}/mcp`. If 200 (route deployed) or 404 (older ZMLR, fall back to `GET /api/health`), record reachable. If neither, skip.
- Read `.autoclaw/llm/config.yaml` if present; parse minimally (hand-rolled — no new deps; see `src/voidspec/sync.ts` parser pattern).
- If a ZMLR entry with the same endpoint already exists and matches — `unchanged`. Otherwise, write/merge — `added`/`updated`.

**Step 2 — playbook import** (one `playbook` step per shipped file):
- Read the two `adapters/zippymesh/*.json` files.
- For each playbook, `GET ${host}/api/playbooks/${id}` (or list endpoint, depending on ZMLR API). If the playbook ID already exists with matching content — `unchanged`. Otherwise `POST ${host}/api/playbooks` — `added`.
- If ZMLR's playbook API isn't reachable (older ZMLR), skip with detail `"playbook API not available — ZMLR version too old"`.

**Step 3 — workspace MCP server registration** (`workspace-mcp` step):
- Use the existing MCP install pattern from `src/mcp/install.ts`. Add an entry to whatever workspace MCP config the user has: `{ name: 'zmlr', url: 'http://127.0.0.1:20128/mcp' }`.
- Same idempotency: present + matching → `unchanged`; absent → `added`; present + different URL → `updated`.

### CLI surface

VS Code command `autoclaw.llm.install` (workspace) — Quick Pick chooses `zippymesh` / `ollama` / both. CLI tail invocation matches `autoclaw mcp install`'s style:

```
autoclaw llm install [--zippymesh] [--ollama] [--scope workspace|user]
```

When run from the extension command palette, defaults to `--zippymesh --ollama --scope workspace`.

### File layout

```
src/llm/
  install.ts              # new — installLlm(), formatLlmInstallReport()
  zippymesh.ts            # MODIFIED — recommendModel() HTTP swap
src/test/
  llm-install.test.ts     # new — install report shape, idempotency, all-skipped path
  llm-zippymesh.test.ts   # MODIFIED — flip recommendModel test from null-stub to HTTP
src/extension.ts          # MODIFIED — register autoclaw.llm.install command
package.json              # MODIFIED — declare the new command + setting
```

## Acceptance criteria (expanded)

See frontmatter. Key cases the tests must cover:

1. **recommendModel — happy path.** Mocked ZMLR returns `{ success: true, recommendations: [{ model: 'openai/gpt-4o' }], fallbackChain: ['ollama/llama3.1:8b'] }`. Method returns `{ model: 'openai/gpt-4o', fallbackChain: ['ollama/llama3.1:8b'] }`.

2. **recommendModel — 404 (older ZMLR).** Mock returns 404. Method returns `null` (NOT an error — same observable as S1 stopgap).

3. **recommendModel — handler self-reports failure.** Mock returns `{ success: false, error: 'discovery service down' }`. Method returns `null`.

4. **recommendModel — transport failure within timeout.** Mock throws ECONNREFUSED. Method returns `null` within the request's timeoutMs.

5. **`installLlm` — fresh workspace.** Tmp workspace + mocked ZMLR returning 200. Report has 3 `added` rows; `.autoclaw/llm/config.yaml` exists with the ZMLR entry; the workspace MCP config has the `zmlr` server entry.

6. **`installLlm` — idempotent re-run.** Same setup, run twice. Second run's report has 3 `unchanged` rows.

7. **`installLlm` — ZMLR unreachable.** Mock throws on every call. Report is `[{ step: 'config', outcome: 'skipped', detail: 'ZMLR unreachable' }]`. No files written. `ok: true` (skip is not an error).

8. **Regression — existing S1 tests stay green.** The `recommendModel returns null in S1` test flips to the new shape; everything else passes unchanged.

## Sequencing

| Step | Deliverable | Owner | Exit gate |
|---|---|---|---|
| 1 | Spec review + sign-off (this doc draft → review) | architect | This file's `status:` is `review` |
| 2 | `recommendModel()` HTTP swap in `src/llm/zippymesh.ts` + updated `llm-zippymesh.test.ts` | llm-impl | New tests pass; old test renamed and flipped |
| 3 | `src/llm/install.ts` + `src/test/llm-install.test.ts` | llm-impl | All 8 acceptance cases pass; idempotency verified by running twice in test |
| 4 | `autoclaw.llm.install` command wiring in `extension.ts` + `package.json` declarations | extension-impl | Command appears in palette; runs against a real ZMLR; report shows in output channel |
| 5 | End-to-end smoke test against a live local ZMLR | manual | The persona loader's `dispatch()` for an `intent: 'chat'` request goes through ZMLR's `recommend_model` (verified by checking ZMLR's request log) |

## Open questions

1. **ZMLR playbook API URL shape.** The architecture doc mentions `POST /api/playbooks` as a routing-engine concept but I haven't confirmed it exists as a literal HTTP endpoint vs. a UI-side import. Step 2 of the install needs a short investigation before implementation — if there's no API, the installer skips with `playbook API not available` and leaves the user to import via the dashboard.

2. **Workspace MCP server config path.** AutoClaw's `mcp install` writes to several per-host paths; should `autoclaw llm install --zippymesh` add the ZMLR MCP server to ALL of them (claude-code, cursor, kiro, etc.), or only the workspace-scoped `.mcp.json`? Recommend: workspace-scoped only in S2; per-host expansion in S3 if user feedback wants it.

3. **`autoclaw llm install --ollama` shape.** Same command, different provider. Recommend: include the Ollama side in this S2 spec as a non-goal note (separate slice) so we're not blocked on it; ship a separate `llm-provider-s2-ollama-install/spec.md` if/when needed.

4. **Should the install command auto-pull `qwen3:0.6b` if `--ollama` was passed?** S1's `installFailsafe()` already handles this. Reuse it from the install command? Yes — calling `installFailsafe()` is the right primitive.

## Don't-do

- **Don't add streaming over MCP.** No consumer yet (RFC §8). Defer.
- **Don't add auth headers to the `/mcp` calls** unless ZMLR ships auth on the route. Local-workspace posture matches everything else.
- **Don't migrate the persona loader.** It already calls `LlmRegistry.getPreferred()` → `recommendModel()`. No loader-level change is needed for S2.
- **Don't write playbook content into the AutoClaw repo as a fallback when the API isn't available.** That would silently duplicate state. Skip + report, let the user import via the dashboard.
- **Don't add a setting for `ZIPPYMESH_HOST`** in `package.json`. The env var is the single source of truth; the install command reads it and writes the resulting URL into `.autoclaw/llm/config.yaml`. Future changes go through re-running install.
- **Don't try to merge `cost-ledger.jsonl` with the runner cost ledger here.** That's S4 (`project_v3_1_phase_b_s4`).
