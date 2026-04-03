# AutoClaw FAQ & Error Guide

Common errors, their meanings, and how to resolve them.

---

## Loop Permission Prompts

### "Permission for loop" / "Continue execution?"

**What it means:** Kilo detected that an agent or command is repeating the same action multiple times. This is a safety guardrail to prevent infinite loops from consuming resources.

**Why it happens:**
- An agent (KDream, MAteam, AutoBuild) hit a transient error and is retrying
- A file watcher triggered rapid successive updates
- A chat command entered a retry cycle

**What to do:**
- **Continue** — If you know the agent is working on something legitimate (e.g., waiting for a slow build)
- **Stop** — If the agent seems stuck or you didn't expect it to keep running
- **Ask AI** — Use the "Ask AI about this error" button to get a detailed explanation

**Prevention:** Check `/kdream ps`, `/mateam status`, or `/autobuild list` to see what's running.

---

## KDream Errors

### "No workspace folder open"

**What it means:** KDream needs a workspace to operate in but none is open in VS Code.

**Fix:** Open a folder or workspace in VS Code (`File → Open Folder`), then try again.

### "gitignore check failed"

**What it means:** AutoClaw tried to check if `.autoclaw/` is in your `.gitignore` but couldn't access the file.

**Fix:** This is non-critical. You can manually add `.autoclaw/` to your `.gitignore` file.

### "adapter install failed"

**What it means:** Auto-installation of AI extension adapters failed silently.

**Fix:** Run `Ctrl+Shift+P → AutoClaw: Install Adapters for Detected AI Extensions` manually.

### Dashboard shows "Loading..." indefinitely

**What it means:** The dashboard webview isn't receiving data from the extension.

**Fix:**
1. Click the **Refresh** button in the dashboard
2. Check VS Code Developer Tools (`Help → Toggle Developer Tools`) for errors
3. Reload the VS Code window (`Ctrl+Shift+P → Developer: Reload Window`)

---

## AutoBuild Errors

### "Workflow not found"

**What it means:** The named workflow doesn't exist in `.autoclaw/autobuild/workflows/`.

**Fix:** Run `/autobuild list` to see available workflows, or create a new one with `/autobuild schedule`.

### "Step failed with exit code N"

**What it means:** A shell command in your workflow returned a non-zero exit code.

**Fix:** Check the run log with `/autobuild status <name>` to see the full output. Fix the underlying command issue.

### "Workflow timed out"

**What it means:** A step took longer than the configured timeout (default 120 seconds).

**Fix:** Increase the timeout in your workflow YAML or investigate why the step is slow.

---

## MAteam Errors

### "No active sessions"

**What it means:** No MAteam sessions are currently running.

**Fix:** Launch a new session with `/mateam launch "your task"`.

### "Agent failed" / "Session halted"

**What it means:** One of the agents (Researcher, Coder, Reviewer, Verifier) encountered an error.

**Fix:** Check the scratchpad files in `.autoclaw/mateam/scratch/<session>/` for details. The `review.md` file often contains blocker information.

### "Rate limit exceeded"

**What it means:** Your LLM provider is throttling requests. Common with free-tier providers.

**Fix:**
- Install **ZippyMesh LLM Router** to automatically route across multiple providers
- Wait a few minutes and retry
- Use `/mateam launch` with `--roles` to run fewer agents in parallel

---

## Connection & Adapter Errors

### "fetch failed" / "Network error"

**What it means:** The extension couldn't reach an LLM provider or service.

**Fix:**
- Check your internet connection
- If using ZippyMesh LLM Router, verify it's running on `localhost:20128`
- Check your AI extension's base URL configuration

### "ZippyMesh LLM Router not detected"

**What it means:** The health check couldn't reach ZMLR at the configured URL.

**Fix:**
- Start ZMLR: `node run.js` in your ZippyMesh directory
- Verify it's accessible at `http://localhost:20128`
- The dashboard works fine without ZMLR — this is just a recommendation

### "No supported AI extensions detected"

**What it means:** AutoClaw couldn't find any compatible AI extensions (Claude Code, KiloCode, Cline, etc.).

**Fix:** Install a supported AI extension, or manually copy adapter files from the extension's `adapters/` folder.

---

## File System Errors

### "EPERM: Permission denied"

**What it means:** Windows file locking prevented an operation (common during tests or file watches).

**Fix:** This is usually transient. Close any open file handles and retry. AutoClaw handles this gracefully.

### "ENOENT: no such file or directory"

**What it means:** A file that AutoClaw expected doesn't exist yet (e.g., `state.json` on first run).

**Fix:** This is normal on first use. AutoClaw creates files as needed. If it persists, check that your workspace is writable.

---

## Getting More Help

If you're stuck:

1. **Ask AI** — Use `Ctrl+Shift+P → AutoClaw: Ask AI for Help` to open a chat with error context
2. **Check logs** — Look in `.autoclaw/kdream/logs/` for today's activity log
3. **GitHub Issues** — Report bugs at [github.com/GoZippy/autoclaw/issues](https://github.com/GoZippy/autoclaw/issues)
4. **ZippyMesh** — Learn about LLM routing at [zippymesh.com](https://zippymesh.com)
