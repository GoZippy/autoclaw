---
spec_id: llm-provider-s2-zmlr-mcp-route
title: ZMLR HTTP MCP route — close the gap so AutoClaw and other clients can consume zmlr-server.js handlers
status: draft
owner: architect
created: 2026-05-23
updated: 2026-05-23
supersedes: []
superseded_by: null
references:
  - docs/rfc/llm-provider-abstraction.md
  - docs/specs/llm-provider-s1/spec.md
  - https://github.com/GoZippy/zippymesh-router
acceptance:
  - given: "ZMLR is running on 127.0.0.1:20128 with the new route handler merged"
    when: "a client POSTs JSON `{ tool: 'list_models', input: { filter: { local_only: true } } }` to http://localhost:20128/mcp"
    then: "the response is 200 with `{ success: true, count: <n>, models: [...] }` matching what the in-process zmlr-server.js handler returns"
  - given: "the route is live"
    when: "a client POSTs `{ tool: 'recommend_model', input: { intent: 'code', constraints: { prefer_free: true } } }`"
    then: "the response is the handler's `{ success: true, ...recommendations }` object including `fallbackChain` and `recommendations[]`"
  - given: "the route is live"
    when: "AutoClaw's `autoclaw llm install --zippymesh` runs and detects the route"
    then: "the workspace MCP config gains an entry `{ name: 'zmlr', url: 'http://localhost:20128/mcp' }` and re-running is a no-op"
  - given: "the route is live"
    when: "the persona loader calls `ZippyMeshProvider.recommendModel('code', { preferLocal: true })`"
    then: "the call goes over HTTP (no in-process require), returns the same shape as the S1 stub, and a row is appended to ZMLR's request log"
non_goals:
  - Streaming responses over MCP — defer until a client asks.
  - Adding new tools to zmlr-server.js — this spec only wires the existing handlers.
  - Adding auth to the /mcp route — local-only; same posture as ZMLR's other `/api/*` routes (workspace-trusted).
  - Migrating AutoClaw's S1 in-process import stopgap — separate spec change (S2 of llm-provider-s1).
---

# ZMLR HTTP MCP route — close the gap

## Summary

ZMLR ships an MCP server object at
[`src/mcp/zmlr-server.js`](ZMLR\src\mcp\zmlr-server.js)
with handlers for `list_models`, `recommend_model`, `validate_model`,
`get_models_by_capability`, `get_routing_metadata`, and
`execute_with_routing`. The README claims clients can reach these at
`http://localhost:20128/mcp` — but **no HTTP route exposes them**. The
handlers are pure async JS functions waiting on a route.

This spec adds the missing Next.js route handler. **One file. Small PR
to ZMLR.** Once merged, AutoClaw's `ZippyMeshProvider.recommendModel()`
(see [llm-provider-s1/spec.md](../llm-provider-s1/spec.md)) switches
from an in-process require stopgap to a normal HTTP call, and any
MCP-aware client (Cursor, Continue, Claude Code) can configure ZMLR's
MCP server natively.

## Read first

- [ZMLR\src\mcp\zmlr-server.js](ZMLR\src\mcp\zmlr-server.js) — the handlers we're exposing
- [ZMLR\src\app\api\v1\chat\completions\route.js](ZMLR\src\app\api\v1\chat\completions\route.js) — sibling route handler to mirror for shape/style
- [ZMLR\README.md](ZMLR\README.md) — the claim being made real

## Design

### Route shape

```js
// src/app/api/mcp/route.js (new file in the ZMLR repo)
import { NextResponse } from 'next/server';
import zmlrMCPServer from '@/mcp/zmlr-server';

const TOOLS = {
  list_models:               zmlrMCPServer.listModels,
  recommend_model:           zmlrMCPServer.recommendModel,
  validate_model:            zmlrMCPServer.validateModel,
  get_models_by_capability:  zmlrMCPServer.getModelsByCapability,
  get_routing_metadata:      zmlrMCPServer.getRoutingMetadata,
  execute_with_routing:      zmlrMCPServer.executeWithRouting,
};

export async function POST(req) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.tool !== 'string') {
    return NextResponse.json({ success: false, error: 'invalid_request' }, { status: 400 });
  }
  const handler = TOOLS[body.tool];
  if (!handler) {
    return NextResponse.json(
      { success: false, error: 'unknown_tool', tool: body.tool, available: Object.keys(TOOLS) },
      { status: 404 },
    );
  }
  try {
    const result = await handler(body.input ?? {});
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { success: false, error: 'internal', message: String(err?.message ?? err) },
      { status: 500 },
    );
  }
}

export async function GET() {
  return NextResponse.json({
    success: true,
    server: 'zmlr-mcp',
    version: zmlrMCPServer.version ?? '1',
    tools: Object.keys(TOOLS),
  });
}
```

That's the entire delta. Six lines of TOOLS map + a generic dispatcher
+ a GET for discovery.

### Why a single `/mcp` route vs. `/mcp/[tool]/route.js` per tool

Single route keeps the surface small and matches how AutoClaw's
`writeTools.ts` dispatches: one entry point, one handler map, one error
boundary. Per-tool routes scatter the same logic across six files.

### Auth posture

None added. ZMLR's `/api/*` routes are workspace-trusted (the user's
local-host gateway). The MCP route inherits that posture. If ZMLR later
adds bearer auth to `/v1`, this route adopts the same middleware in the
same PR.

### Streaming

`execute_with_routing` is the only handler that could plausibly want
streaming. For now it returns a single JSON object with `nextSteps[]`
the caller iterates over. Streaming is deferred per the non-goals.

## Acceptance criteria

See frontmatter. Concrete test fixtures:

```bash
# After merge, with ZMLR running:
curl http://localhost:20128/mcp -H 'content-type: application/json' \
  -d '{"tool":"list_models","input":{"filter":{"local_only":true}}}'
# → { "success": true, "count": <n>, "models": [...] }

curl http://localhost:20128/mcp \
  -d '{"tool":"recommend_model","input":{"intent":"code","constraints":{"prefer_free":true}}}'
# → { "success": true, "recommendations": [...], "fallbackChain": [...] }

curl http://localhost:20128/mcp
# → { "success": true, "server": "zmlr-mcp", "version": "1", "tools": [...] }
```

## Sequencing

| Step | Deliverable | Owner | Exit gate |
|---|---|---|---|
| 1 | Open the PR against `github.com/GoZippy/zippymesh-router` adding `src/app/api/mcp/route.js` + a smoke test | AutoClaw maintainer (user) | curl tests above pass against a local dev server |
| 2 | Cut a ZMLR patch release containing the route | ZMLR maintainer (user — same person) | `npm view zippymesh-router version` shows the new tag |
| 3 | Update AutoClaw's `ZippyMeshProvider.recommendModel()` to call `POST /mcp` over HTTP instead of the in-process require stopgap | llm-impl | `llm-zippymesh.test.ts` test for `recommendModel` now uses mocked HTTP, not module loading |
| 4 | Update `autoclaw llm install --zippymesh` to detect the route via `GET /mcp` and register it in workspace MCP config | llm-impl | re-running `autoclaw llm install --zippymesh` is a no-op (golden file) |

## Open questions

1. **CORS posture.** ZMLR's existing `/v1/*` routes ship with permissive CORS for browser dashboards. Should `/mcp` mirror that or stay server-only? Recommend: mirror — dashboards may want to display routing decisions.
2. **Rate limiting.** ZMLR rate-limits `/v1/chat/completions`. Should `/mcp` be limited too, or is it cheap enough to leave open? Recommend: leave open in this PR; revisit if tools become expensive.

## Don't-do

- **Don't fork the handler signatures** in the route layer. The dispatcher must call `handler(input)` and return whatever it returns. No wrapping, no schema validation in the route — that's the handler's job.
- **Don't add new tools** in this spec. Only wire what `zmlr-server.js` already exports. New tools are a separate spec against the ZMLR repo.
- **Don't add auth** before measuring whether anyone needs it. AutoClaw's `/v1` calls don't auth locally; the MCP route doesn't either.
- **Don't streaming-ify** anything. One JSON in, one JSON out. Streaming is a future spec.
