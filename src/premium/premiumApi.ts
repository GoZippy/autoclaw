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

/** A task to be scheduled by the advanced-orchestration engine. */
export interface AdvancedOrchestrationTask {
  id: string;
  /** Ids of tasks that must complete before this one. */
  dependsOn?: string[];
  /** Relative effort/points (defaults to 1). */
  effort?: number;
  /** Review-risk tier; `high` is flagged for stricter review. */
  criticality?: 'low' | 'medium' | 'high';
  /** Files this task touches (used for scope-conflict avoidance). */
  filePaths?: string[];
  /** Capabilities a suitable agent should have. */
  requiredCapabilities?: string[];
}

/** An agent the engine can assign work to. */
export interface AdvancedOrchestrationAgent {
  id: string;
  capabilities?: string[];
  /** Track-record score in [0,1]; higher wins quality-weighted assignment. */
  reputation?: number;
  /** Relative cost per effort point (defaults to 1). */
  costPerEffort?: number;
  /** Max concurrent tasks per sprint (defaults to 1). */
  maxParallel?: number;
}

export interface AdvancedOrchestrationInput {
  workspaceRoot: string;
  tasks: AdvancedOrchestrationTask[];
  agents: AdvancedOrchestrationAgent[];
  /** What to optimise for. Defaults to `balanced`. */
  objective?: 'speed' | 'cost' | 'quality' | 'balanced';
}

/** One agent's work for one sprint. */
export interface AdvancedOrchestrationAssignment {
  sprint: number;
  agentId: string;
  taskIds: string[];
  rationale: string;
}

export interface AdvancedOrchestrationResult {
  /** Human-readable plan + rationale. */
  markdown: string;
  /** Per-sprint, per-agent assignments. */
  assignments: AdvancedOrchestrationAssignment[];
  /** Task ids on the critical (longest weighted) path. */
  criticalPath: string[];
  /** Projected number of sprints. */
  projectedSprints: number;
  /** High-criticality task ids flagged for stricter review. */
  highRiskTasks: string[];
  featureTier: 'pro' | 'teams' | 'enterprise';
  createdAt: string;
}

export interface PremiumApi {
  generatePrEvidenceReport(input: PrEvidenceReportInput): Promise<PrEvidenceReport>;
  generateAgentScorecard?(input: unknown): Promise<unknown>;
  /**
   * Advanced sprint optimiser (Pro): critical-path analysis +
   * capability/reputation/cost-aware, scope-conflict-free, objective-weighted
   * assignment. Optional so the free fallback can omit the real engine.
   */
  runAdvancedOrchestration?(
    input: AdvancedOrchestrationInput,
  ): Promise<AdvancedOrchestrationResult>;
}

export interface PremiumApiFactoryContext {
  extensionPath: string;
}
