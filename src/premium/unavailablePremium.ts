// ZIPPY OPEN MATERIAL
//
// The free/community fallback implementation of PremiumApi. Always available, so
// the public build compiles + runs without any private premium package. Generates
// a basic report and points the user at the full Pro engine.

import type { PremiumApi, PremiumApiFactoryContext, PrEvidenceReportInput } from './premiumApi';

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
  };
}
