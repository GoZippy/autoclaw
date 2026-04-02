# ZippyMesh MCP Server Setup for Claude Code

This enables Claude Code to query ZippyMesh LLM Router for model recommendations
and execute routing decisions programmatically.

## Automatic Setup
AutoClaw installs this automatically when both Claude Code and ZippyMesh are detected.
The MCP server definition is added to `~/.claude/mcp.json`.

## Manual Setup
Add the following to `~/.claude/mcp.json` (create if it doesn't exist):

```json
{
  "mcpServers": {
    "zippymesh": {
      "command": "node",
      "args": ["<path-to-zippymesh>/mcp-server.js"],
      "env": {
        "ZMLR_BASE_URL": "http://localhost:20128"
      }
    }
  }
}
```

Replace `<path-to-zippymesh>` with the directory where you unzipped ZippyMesh LLM Router.

## Available MCP Tools

Once configured, Claude Code (and KDream) can use these tools:

| Tool | Description | Example Use |
|---|---|---|
| `list_models` | List all available models across providers | "What models do I have available?" |
| `recommend_model` | Get best model for a task type | KDream tick: recommend model for code review |
| `validate_model` | Check if a model is available | Before starting a MAteam session |
| `execute_with_routing` | Run inference with smart routing | Direct agent execution |

## KDream Integration
Once the MCP server is active, KDream's tick cycle can:
- Call `recommend_model` with intent "code" to pick the best model for a code task
- Call `validate_model` before suggesting a model to the user
- Use `list_models` in its status output to show available options
