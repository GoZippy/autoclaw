# ZippyMesh LLM Router — AutoClaw Setup

This adapter configures your AI extensions to route through ZippyMesh LLM Router,
giving AutoClaw automatic failover, free-tier distribution, and rate limit prevention.

## Prerequisites
- ZippyMesh LLM Router running on localhost:20128
  Download: https://zippymesh.com
  Start: `node run.js`

## Per-Extension Setup

### KiloCode
1. Open KiloCode settings (⚙️ icon in chat panel)
2. Set "Base URL" to: `http://localhost:20128/v1`
3. Add custom headers:
   ```
   X-Intent: code
   ```
4. For MAteam sessions, also add:
   ```
   X-Session-Parallel: true
   ```

### Cursor
1. Open Cursor Settings → AI → Base URL
2. Set to: `http://localhost:20128/v1`
3. API key: use any value (e.g., `zmlr-local`)

### Continue
1. Edit `.continue/config.json`
2. Add/update the model entry:
   ```json
   {
     "title": "ZippyMesh (Auto-Route)",
     "provider": "openai",
     "model": "auto",
     "apiBase": "http://localhost:20128/v1",
     "apiKey": "zmlr-local"
   }
   ```

### Claude Code
1. Add to `~/.claude/settings.json`:
   ```json
   {
     "apiBaseUrl": "http://localhost:20128/v1"
   }
   ```
   Note: Claude Code requires Anthropic auth — ZMLR must have an Anthropic provider configured
   and will pass-through auth headers.

### Windsurf
1. Open Windsurf Settings → Cascade → Custom Model
2. Set base URL: `http://localhost:20128/v1`

## Recommended Playbooks
- `mateam-playbook.json` — For MAteam multi-agent sessions (free-tier burst routing)
- `kdream-playbook.json` — For long-running KDream sessions (cost-optimized)

Import these in the ZippyMesh dashboard under Routing → Import Playbook.
