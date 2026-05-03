# Review — {{agent_id}} Sprint {{sprint_number}}

**Branch:** {{branch_name}}
**Reviewer:** {{reviewer_id}}
**Date:** {{date}}

---

## 1. Compilation
- [ ] `npm run compile` passes (zero TypeScript errors)
- [ ] No `any` casts introduced without justification

## 2. Tests
- [ ] `npm test` passes (all suites green)
- [ ] `npm run test:unit` passes
- [ ] New code has tests for happy path + error paths
- [ ] No existing tests regressed

## 3. Adapter Parity
- [ ] `npm run adapters:check` passes
- [ ] If skills changed, all 8 platform adapters updated consistently
- [ ] KiloCode `.kilocodemodes` and `.clinerules/` copies in sync

## 4. Security
- [ ] No secrets or credentials in committed files
- [ ] No new `execSync` or unvalidated shell commands
- [ ] Webview CSP not weakened
- [ ] File writes stay within workspace/`.autoclaw/` bounds

## 5. Code Style
- [ ] No new comments explaining what code does (only why, if non-obvious)
- [ ] No unnecessary error handling for scenarios that cannot happen
- [ ] No backwards-compat shims for removed code
- [ ] Async/await used consistently (no mixed `.then()` chains)

## 6. Extension Host Safety
- [ ] No blocking synchronous I/O in activation path
- [ ] `setInterval`/file watchers registered to `context.subscriptions`
- [ ] OutputChannels disposed in `deactivate()`

## 7. Scope Compliance
- [ ] Only files within assigned `scope_patterns` were modified
- [ ] Any cross-scope changes flagged and approved via inbox

---

**Verdict:** APPROVED | MINOR_ISSUES | CRITICAL_ISSUES

## Issues
| # | File | Line | Description | Severity |
|---|------|------|-------------|----------|

## Required Actions
- [ ]
