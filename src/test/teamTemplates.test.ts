/**
 * teamTemplates.test.ts — validity of the team-template catalog
 * (src/fleet/teamTemplates.ts). Pure: no vscode, no fs.
 *
 * The catalog is user-facing data that fans out into real invites, so every seat
 * must use only valid taxonomy values and every behavioural type must agree with
 * the role→type derivation (or be a DECLARED alternate) — the whole point of the
 * reconciliation was to remove silent role/type contradictions.
 */

import * as assert from 'assert';
import {
  TEAM_TEMPLATES, getTeamTemplate, recommendedTemplate, seatSummary, type TeamTemplate,
} from '../fleet/teamTemplates';
import { ROLE_ORDER, type CanonicalRole } from '../roles';
import { AGENT_TYPES } from '../fabric/agentTypes';
import { JOIN_TARGETS } from '../fleet/joinPrompt';
import { agentTypeForRole, ROLE_TYPE_ALTERNATES } from '../fleet/roleType';

const VALID_TOOLS = new Set(Object.keys(JOIN_TARGETS));
const VALID_ADMIT = new Set(['manual', 'auto-preapproved']); // NO 'open' — invites are single-use.

suite('teamTemplates — catalog validity', () => {
  test('there is at least a useful set of templates', () => {
    assert.ok(TEAM_TEMPLATES.length >= 8, `expected a real catalog, got ${TEAM_TEMPLATES.length}`);
  });

  test('every seat uses only valid roles, types, tools, and admit policies', () => {
    for (const tpl of TEAM_TEMPLATES) {
      assert.ok(tpl.seats.length >= 1, `${tpl.id} must have at least one seat`);
      for (const seat of tpl.seats) {
        assert.ok(ROLE_ORDER.includes(seat.role), `${tpl.id}: invalid role "${seat.role}"`);
        assert.ok(AGENT_TYPES.includes(seat.agentType), `${tpl.id}: invalid agent_type "${seat.agentType}"`);
        assert.ok(VALID_TOOLS.has(seat.tool), `${tpl.id}: invalid tool "${seat.tool}"`);
        assert.ok(VALID_ADMIT.has(seat.admit), `${tpl.id}: invalid/forbidden admit "${seat.admit}"`);
        assert.ok(seat.rationale.length > 0, `${tpl.id}: seat ${seat.role} needs a rationale`);
      }
    }
  });

  test("every seat's type is the role's derived default or a declared alternate", () => {
    for (const tpl of TEAM_TEMPLATES) {
      for (const seat of tpl.seats) {
        const derived = agentTypeForRole(seat.role as CanonicalRole);
        const alternates = ROLE_TYPE_ALTERNATES[seat.role as CanonicalRole] ?? [];
        const allowed = seat.agentType === derived || alternates.includes(seat.agentType);
        assert.ok(allowed,
          `${tpl.id}: seat ${seat.role}/${seat.agentType} is neither the derived default (${derived}) nor a declared alternate`);
      }
    }
  });

  test('ids are unique and kebab-case', () => {
    const ids = TEAM_TEMPLATES.map(t => t.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'template ids must be unique');
    for (const id of ids) {
      assert.ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id), `id "${id}" must be kebab-case`);
    }
  });

  test('exactly one template is the recommended default, and it is the starter', () => {
    const recs = TEAM_TEMPLATES.filter(t => t.recommended);
    assert.strictEqual(recs.length, 1, 'exactly one recommended template');
    assert.strictEqual(recommendedTemplate().id, 'solo-reviewer-starter');
    assert.strictEqual(recommendedTemplate().seats.length, 2, 'the starter is the smallest viable team');
  });

  test('the recommended starter pairs a coder with a read-only auditor reviewer', () => {
    const starter = recommendedTemplate();
    const types = starter.seats.map(s => s.agentType).sort();
    assert.deepStrictEqual(types, ['auditor', 'coder'], 'starter = builder + read-only checker');
  });

  test('getTeamTemplate round-trips known ids and rejects unknown', () => {
    assert.ok(getTeamTemplate('feature-build-squad'));
    assert.strictEqual(getTeamTemplate('feature-build-squad')!.name, 'Feature Build Squad');
    assert.strictEqual(getTeamTemplate('no-such-template'), undefined);
  });

  test('every template carries the human-facing fields the gallery + preview need', () => {
    for (const tpl of TEAM_TEMPLATES) {
      const t: TeamTemplate = tpl;
      assert.ok(t.name.length > 0, `${t.id} needs a name`);
      assert.ok(t.description.length > 0, `${t.id} needs a description`);
      assert.ok(t.whenToUse.length > 0, `${t.id} needs a whenToUse`);
      assert.ok(t.consensusNote.length > 0, `${t.id} needs a consensusNote`);
    }
  });

  test('seatSummary renders role/type → tool', () => {
    assert.strictEqual(
      seatSummary({ role: 'reviewer', agentType: 'auditor', tool: 'codex', scope: 'x', admit: 'manual', rationale: 'y' }),
      'reviewer/auditor → codex',
    );
  });
});
