# Changelog

## [1.2.1] - 2026-04-06

### Changed
- License updated to Zippy Technologies Source-Available Commercial License v1.3
  (personal/educational use remains free; commercial use requires a paid license)

### Fixed
- Patched high-severity `serialize-javascript` transitive vulnerability in dev dependencies
  via package override (does not affect the published extension — devDeps are not bundled)
- Updated `@vscode/test-cli` to 0.0.12

## [1.2.0] - 2026-04-01

### Added
- ZippyMesh LLM Router adapter with setup guide and routing playbooks
- Auto-detection of ZMLR on extension activation
- `mateam-playbook.json` and `kdream-playbook.json` for ZMLR routing
- MCP server setup wizard for Claude Code + ZippyMesh integration

## [1.1.0] - 2026-04-01

### Added
- **KDream Dashboard** — Visual sidebar showing KDream status, tasks, recent activity, adapter health, and TODOs
- New commands:
  - `kdream.showDashboard` — Open the KDream Dashboard view
  - `kdream.refreshDashboard` — Refresh dashboard data
  - `kdream.addTask` — Add a task to KDream memory via input box
- Activity bar icon for KDream Dashboard (lobster icon)
- File system watcher for `.autoclaw/kdream/state.json` — dashboard auto-refreshes on state changes
- Content Security Policy headers for webview security
- New settings:
  - `autoclaw.kdream.enableFileWatcher` — Toggle file system watcher
  - `autoclaw.kdream.notifyNewTodos` — Toggle notifications for new TODOs
  - `autoclaw.kdream.refreshInterval` — Dashboard refresh interval in seconds
  - `autoclaw.kdream.scanPatterns` — File patterns to scan for TODOs/FIXMEs
  - `autoclaw.kdream.notificationLevel` — Notification verbosity level
  - `autoclaw.kdream.autoInstallAdapters` — Auto-install adapters on activation
  - `autoclaw.kdream.adapters` — AI adapters to monitor for health status

### Fixed
- Replaced synchronous I/O operations with async `fs.promises` to prevent UI blocking
- Added Content Security Policy to webview to prevent XSS attacks
- Proper nonce generation for webview script and style loading
- Fixed error handling for missing state.json and MEMORY.md files

### Changed
- Build process now copies webview assets via `copy-webview.js` script
- Added `npm run copy-webview` to `vscode:prepublish` script
- Webview resources served from `out/webview/` directory

## [1.0.7] - 2026-04-01

### Added
- Universal adapter system — AutoClaw now auto-detects installed AI extensions and installs the correct skill files automatically on activation
- Adapters for 7 platforms:
  - **Claude Code** — `SKILL.md` files copied to `~/.claude/skills/`
  - **Cursor** — `.mdc` rule files for `.cursor/rules/`
  - **Kiro** — steering `.md` files for `.kiro/steering/`
  - **Windsurf** — rules `.md` files for `.windsurf/rules/`
  - **KiloCode** — custom modes YAML merged into `.kilocodemodes`
  - **Cline** — `.md` files copied to `.clinerules/`
  - **Continue** — `.prompt` files copied to `.continue/prompts/`
- New command: **AutoClaw: Install Adapters for Detected AI Extensions** — manually re-run adapter installation from the Command Palette

## [1.0.6] - 2026-04-01

### Fixed
- `chatSkills` paths now point to `SKILL.md` files directly instead of directories — skills now register correctly in GitHub Copilot Chat

## [1.0.5] - 2026-04-01

### Changed
- Rewrote all three SKILL.md files with full behavioral instructions for the AI — previously they were descriptions only, now they contain step-by-step execution logic

## [1.0.4] - 2026-04-01

### Added
- `icon` field added to `package.json` — lobster Z logo now appears on the Marketplace listing

## [1.0.3] - 2026-04-01

### Added
- Lobster Z icon (`icon.png`)

## [1.0.2] - 2026-04-01

### Added
- `README.md` with full user documentation for all three skills
- `LICENSE` (MIT)
- `repository` field in `package.json`

### Fixed
- Publisher corrected to `ZippyTechnologiesLLC`

## [1.0.1] - 2026-04-01

### Fixed
- Publisher updated from placeholder to `ZippyTechnologiesLLC`

## [1.0.0] - 2026-04-01

### Added
- Initial release
- Three chat skills: `kdream`, `autobuild`, `mateam`
- VS Code `chatSkills` contribution point for GitHub Copilot Chat
- Commands: `autoclaw.enableAll`, `autoclaw.startKdream`
- Activates on `onStartupFinished`
