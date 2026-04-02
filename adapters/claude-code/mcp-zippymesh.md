# ZippyMesh MCP — Claude Code Integration Notes

This file documents how to use ZippyMesh LLM Router's MCP tools within Claude Code + KDream.

## After MCP Setup

In any Claude Code chat, you can use:

```
What models are available through ZippyMesh? (calls list_models)
```

```
/kdream work
[KDream tick] → calls recommend_model with intent "code" → uses result to suggest model
```

## KDream Tick with Model Awareness

When ZMLR MCP is active, KDream's tick output will include:
```
[HH:MM:SS] Tick N — checking models via ZippyMesh
  Available: groq/llama-3.3-70b (free, 120ms avg), anthropic/claude-sonnet (paid, 800ms avg)
  Recommended for code review: groq/llama-3.3-70b
```

This is purely informational in the current chat-invoked architecture.
A future daemon architecture could act on this automatically.
