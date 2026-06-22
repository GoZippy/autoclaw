// ZIPPY OPEN MATERIAL
//
// The free/community fallback implementation of PremiumApi. Always available, so
// the public build compiles + runs without any private premium package. Generates
// a basic report and points the user at the full Pro engine.

import type {
  PremiumApi,
  PremiumApiFactoryContext,
  PrEvidenceReportInput,
  AdvancedOrchestrationInput,
} from './premiumApi';

export function createUnavailablePremiumApi(_ctx: PremiumApiFactoryContext): PremiumApi {
  return {
    async generatePrEvidenceReport(input: PrEvidenceReportInput) {
      const markdown = [
        '# AutoClaw Basic Report',
        '',
        'The full PR Evidence Report engine is available in AutoClaw Pro.',
        '',
        `Workspace: ${input.workspaceRoot}`,
        ...(input.taskId ? [`Task: ${input.taskId}`] : []),
        `Created: ${new Date().toISOString()}`,
        '',
        '## Free Summary',
        '',
        '- Basic report generated from Free Community fallback.',
        '- Upgrade to Pro for agent run history, changed-file evidence, command log evidence, test evidence, and reviewer verdicts.',
      ].join('\n');

      return { markdown, createdAt: new Date().toISOString(), featureTier: 'pro' as const };
    },

    async generateAgentScorecard(_input: unknown) {
      const markdown = [
        '# AutoClaw Agent Scorecards (Basic)',
        '',
        'Detailed per-agent scorecards — actions, tokens, wall time, token share, and',
        'last-active — are an **AutoClaw Pro** feature.',
        '',
        `Created: ${new Date().toISOString()}`,
        '',
        '- Upgrade to Pro for the full agent-scorecard engine.',
      ].join('\n');
      return { markdown, createdAt: new Date().toISOString() };
    },

    async runAdvancedOrchestration(input: AdvancedOrchestrationInput) {
      const markdown = [
        '# AutoClaw Advanced Orchestration (Basic)',
        '',
        'Critical-path analysis and capability/reputation/cost-aware sprint',
        'optimisation are an **AutoClaw Pro** feature. The free build plans sprints',
        'with the standard DAG bin-packer (`/orchestrate plan`).',
        '',
        `- Tasks: ${input.tasks?.length ?? 0}`,
        `- Agents: ${input.agents?.length ?? 0}`,
        `- Objective: ${input.objective ?? 'balanced'}`,
        `- Created: ${new Date().toISOString()}`,
        '',
        '- Upgrade to Pro for the optimising planner (critical path, weighted',
        '  assignment, scope-conflict-free packing, risk-tiered review hints).',
      ].join('\n');
      return {
        markdown,
        assignments: [],
        criticalPath: [],
        projectedSprints: 0,
        highRiskTasks: [],
        featureTier: 'pro' as const,
        createdAt: new Date().toISOString(),
      };
    },
  };
}
