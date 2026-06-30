/**
 * joinPrompt.test.ts — unit tests for the "join this project as an agent"
 * prompt generator (src/fleet/joinPrompt.ts, FF-2 / Slice A).
 *
 * Pure renderer: no vscode, no fs. Each test asserts the generated prompt
 * carries the load-bearing facts (token, agent_id, workspace, protocol-doc
 * pointer, loop body) AND the lane-appropriate concrete steps for the target.
 */

import * as assert from 'assert';
import {
  renderJoinPrompt,
  renderJoinPromptForInvite,
  JOIN_TARGETS,
  type RenderJoinPromptInput,
} from '../fleet/joinPrompt';
import type { Invite } from '../fleet/invites';

const BASE: RenderJoinPromptInput = {
  host: 'codex',
  workspacePath: '/workspace/demo',
  role: 'coder',
  scope: ['src/test/**', 'docs/**'],
  inviteToken: 'join-abc123def456',
};

/** Every prompt — regardless of lane — must carry these facts. */
function assertUniversal(prompt: string, input: RenderJoinPromptInput, agentId: string): void {
  assert.ok(prompt.includes(input.inviteToken), 'prompt must contain the invite token');
  assert.ok(prompt.includes(agentId), `prompt must name the agent_id "${agentId}"`);
  assert.ok(prompt.includes(input.workspacePath), 'prompt must contain the workspace path');
  assert.ok(
    prompt.includes('docs/AGENT_SESSION_PROTOCOL.md'),
    'prompt must point at the authoritative protocol doc',
  );
  // The six-phase loop body must be present so the agent actually starts the cycle.
  assert.ok(
    /REGISTER\s*->\s*SYNC\s*->\s*CLAIM\s*->\s*WORK\s*->\s*REPORT\s*->\s*LOOP/.test(prompt),
    'prompt must include the six-phase loop',
  );
  assert.ok(/cycle\s*>=\s*25/.test(prompt), 'prompt must include the HALT ceiling');
}

suite('joinPrompt — renderJoinPrompt lane coverage', () => {
  test('codex → MCP lane: presence.beacon tool call + MCP steps, fs fallback noted', () => {
    const p = renderJoinPrompt(BASE);
    assertUniversal(p, BASE, 'codex');
    assert.ok(p.includes('presence.beacon'), 'codex MCP prompt must call presence.beacon');
    assert.ok(p.includes('claim.task'), 'codex MCP prompt must mention claim.task');
    assert.ok(/MCP lane/.test(p), 'codex must declare the MCP lane');
    assert.ok(/filesystem lane/.test(p), 'codex must note the fs fallback lane');
    // MCP lane should NOT instruct HTTP routes.
    assert.ok(!p.includes('/api/v1/heartbeat'), 'MCP lane must not tell the agent to POST heartbeat');
  });

  test('claude-desktop → MCP lane, no fs fallback', () => {
    const input = { ...BASE, host: 'claude-desktop' };
    const p = renderJoinPrompt(input);
    assertUniversal(p, input, 'claude-desktop');
    assert.ok(p.includes('presence.beacon'), 'claude-desktop must use the MCP beacon');
    assert.ok(p.includes('allowWrites'), 'MCP lane must remind to enable writes');
  });

  test('openclaw → filesystem lane: beacon JSON + comms file paths + idempotency', () => {
    const input = { ...BASE, host: 'openclaw' };
    const p = renderJoinPrompt(input);
    assertUniversal(p, input, 'openclaw');
    assert.ok(
      p.includes('.autoclaw/orchestrator/comms/inboxes/'),
      'fs lane must give the inbox path',
    );
    assert.ok(
      p.includes('comms/heartbeats/openclaw.json') || p.includes('~/.autoclaw/beacons/openclaw.json'),
      'fs lane must give a concrete beacon/heartbeat path',
    );
    assert.ok(p.includes('processed/'), 'fs lane must include the idempotency move-to-processed step');
    assert.ok(!p.includes('presence.beacon'), 'fs lane must not use the MCP tool');
  });

  test('hermes → HTTP lane: REST routes + SSE + create-exclusive claim', () => {
    const input = { ...BASE, host: 'hermes', bridgeUrl: 'http://127.0.0.1:7878' };
    const p = renderJoinPrompt(input);
    assertUniversal(p, input, 'hermes');
    assert.ok(p.includes('/api/v1/heartbeat'), 'http lane must POST heartbeat');
    assert.ok(p.includes('/api/v1/claims/'), 'http lane must claim over HTTP');
    assert.ok(p.includes('/api/v1/messages'), 'http lane must report via messages route');
    assert.ok(p.includes('http://127.0.0.1:7878'), 'http lane must use the supplied bridge URL');
    assert.ok(p.includes('.well-known/agent.json'), 'http lane must serve an Agent Card');
  });

  test('http lane without a bridgeUrl emits an editable placeholder', () => {
    const input = { ...BASE, host: 'hermes' };
    const p = renderJoinPrompt(input);
    assert.ok(/bridge-base-url/i.test(p), 'http lane must leave a placeholder URL for the user');
  });
});

suite('joinPrompt — existing IDE hosts still work', () => {
  test('claude-code → native /loop lane with Agent subagent note', () => {
    const input = { ...BASE, host: 'claude-code' };
    const p = renderJoinPrompt(input);
    assertUniversal(p, input, 'claude-code');
    assert.ok(p.includes('/loop'), 'claude-code prompt must mention /loop');
    assert.ok(/Agent subagent/i.test(p), 'claude-code prompt must mention the Agent subagent fanout');
    assert.ok(p.includes('heartbeats/claude-code.json'), 'claude-code writes a heartbeat, not a beacon-only');
  });

  test('chat-only IDE hosts (cline/kilocode/cursor/kiro) render the fs lane', () => {
    for (const host of ['cline', 'kilocode', 'cursor', 'kiro', 'continue', 'windsurf']) {
      const input = { ...BASE, host };
      const p = renderJoinPrompt(input);
      assertUniversal(p, input, JOIN_TARGETS[host].agentId);
      assert.ok(p.includes('.autoclaw/orchestrator/comms/'), `${host} fs lane must give comms paths`);
    }
  });

  test('antigravity maps to the gemini-cli agent_id', () => {
    const input = { ...BASE, host: 'antigravity' };
    const p = renderJoinPrompt(input);
    assert.ok(p.includes('gemini-cli'), 'antigravity announces as gemini-cli per the protocol matrix');
  });
});

suite('joinPrompt — edges + invite convenience', () => {
  test('unknown host falls back to the fs lane with the host as agent_id', () => {
    const input = { ...BASE, host: 'some-new-tool' };
    const p = renderJoinPrompt(input);
    assertUniversal(p, input, 'some-new-tool');
    assert.ok(p.includes('.autoclaw/orchestrator/comms/'), 'unknown host must get the universal fs lane');
  });

  test('agentId override wins over the convention default', () => {
    const p = renderJoinPrompt({ ...BASE, host: 'codex', agentId: 'codex-2' });
    assert.ok(p.includes('codex-2'), 'explicit agentId override must appear');
  });

  test('no role / no scope still produces a valid prompt', () => {
    const input: RenderJoinPromptInput = {
      host: 'openclaw',
      workspacePath: '/srv/work',
      inviteToken: 'join-xyz',
    };
    const p = renderJoinPrompt(input);
    assertUniversal(p, input, 'openclaw');
    assert.ok(/whole repo/i.test(p), 'missing scope must say "whole repo"');
  });

  test('renderJoinPromptForInvite pulls workspace/role/scope/token off the Invite', () => {
    const invite: Invite = {
      token: 'join-from-invite-001',
      issued_by: 'claude-code',
      project: 'demo',
      workspace: '/workspace/demo',
      suggested_role: 'auditor',
      scope: ['src/security/**'],
      trust: 'off',
      admit_policy: 'auto-preapproved',
      issued_at: '2026-06-22T00:00:00.000Z',
      expires: '2026-06-23T00:00:00.000Z',
      consumed_by: null,
    };
    const p = renderJoinPromptForInvite('hermes', invite, { bridgeUrl: 'http://h:9' });
    assert.ok(p.includes('join-from-invite-001'), 'token comes from the invite');
    assert.ok(p.includes('/workspace/demo'), 'workspace comes from the invite');
    assert.ok(p.includes('auditor'), 'role comes from the invite');
    assert.ok(p.includes('src/security/**'), 'scope comes from the invite');
    assert.ok(p.includes('http://h:9'), 'bridgeUrl is threaded through');
  });

  test('every JOIN_TARGETS entry renders a non-empty prompt with its agent_id', () => {
    for (const [host, conv] of Object.entries(JOIN_TARGETS)) {
      const p = renderJoinPrompt({ ...BASE, host });
      assert.ok(p.length > 200, `${host} prompt should be substantial`);
      assert.ok(p.includes(conv.agentId), `${host} must announce as ${conv.agentId}`);
      assert.ok(p.includes(BASE.inviteToken), `${host} must include the token`);
    }
  });
});

suite('joinPrompt — role != agent_type is announced distinctly (regression)', () => {
  // A `reviewer` ROLE must announce the `auditor` TYPE, not "reviewer". Before the
  // fix the renderer wrote the role string into BOTH fields, so a reviewer never
  // got the auditor (read-only / unanimous) posture downstream.
  const REVIEWER = { ...BASE, role: 'reviewer', agentType: undefined as string | undefined };

  test('mcp lane: derived auditor type, role stays reviewer', () => {
    const p = renderJoinPrompt({ ...REVIEWER, host: 'codex' });
    assert.ok(p.includes('role: "reviewer"'), 'role must remain reviewer');
    assert.ok(p.includes('agent_type: "auditor"'), 'agent_type must derive to auditor');
    assert.ok(!p.includes('agent_type: "reviewer"'), 'must NOT collapse role into agent_type');
  });

  test('http lane: derived auditor type announced on heartbeat', () => {
    const p = renderJoinPrompt({ ...REVIEWER, host: 'hermes' });
    assert.ok(p.includes('agent_type: "auditor"'), 'http heartbeat must announce auditor');
    assert.ok(!p.includes('agent_type: "reviewer"'));
  });

  test('fs lane: beacon JSON carries distinct role + agent_type', () => {
    const p = renderJoinPrompt({ ...REVIEWER, host: 'openclaw' });
    assert.ok(/"role":\s*"reviewer"/.test(p), 'fs beacon role = reviewer');
    assert.ok(/"agent_type":\s*"auditor"/.test(p), 'fs beacon agent_type = auditor');
  });

  test('slash lane (Claude Code) now emits agent_type (previously omitted)', () => {
    const p = renderJoinPrompt({ ...REVIEWER, host: 'claude-code' });
    assert.ok(p.includes('agent_type: "auditor"'), 'slash heartbeat must now announce the derived type');
    assert.ok(p.includes('role: "reviewer"'));
  });

  test('explicit agentType override wins over role derivation', () => {
    const p = renderJoinPrompt({ ...BASE, host: 'codex', role: 'docs', agentType: 'assistant' });
    assert.ok(p.includes('agent_type: "assistant"'), 'explicit override must be announced');
    assert.ok(!p.includes('agent_type: "coder"'), 'must not use the role-derived default when overridden');
  });

  test('the header surfaces the behavioral type line', () => {
    const p = renderJoinPrompt({ ...REVIEWER, host: 'codex' });
    assert.ok(/Behavioral type:\s*auditor/.test(p), 'header must state the derived behavioral type');
  });

  test('renderJoinPromptForInvite threads suggested_agent_type distinctly', () => {
    const invite: Invite = {
      token: 'join-rt-001',
      issued_by: 'claude-code',
      project: 'demo',
      workspace: '/workspace/demo',
      suggested_role: 'reviewer',
      suggested_agent_type: 'auditor',
      scope: ['src/**'],
      trust: 'off',
      admit_policy: 'auto-preapproved',
      issued_at: '2026-06-23T00:00:00.000Z',
      expires: '2026-06-24T00:00:00.000Z',
      consumed_by: null,
    };
    const p = renderJoinPromptForInvite('claude-desktop', invite);
    assert.ok(p.includes('role: "reviewer"'), 'invite role threaded');
    assert.ok(p.includes('agent_type: "auditor"'), 'invite suggested_agent_type threaded distinctly');
  });
});
