// ZIPPY OPEN MATERIAL
//
// The public interface for premium-only engines. The community/source-available
// build ships a free fallback implementation (unavailablePremium.ts); a future
// private @autoclaw/premium package implements the same interface for real.

export interface PrEvidenceReportInput {
  workspaceRoot: string;
  taskId?: string;
  changedFiles?: string[];
}

export interface PrEvidenceReport {
  markdown: string;
  createdAt: string;
  featureTier: 'pro' | 'teams' | 'enterprise';
}

export interface PremiumApi {
  generatePrEvidenceReport(input: PrEvidenceReportInput): Promise<PrEvidenceReport>;
  generateAgentScorecard?(input: unknown): Promise<unknown>;
  runAdvancedOrchestration?(input: unknown): Promise<unknown>;
}

export interface PremiumApiFactoryContext {
  extensionPath: string;
}
