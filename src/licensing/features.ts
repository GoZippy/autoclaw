// ZIPPY OPEN MATERIAL
//
// Feature registry — the single source of truth for what each feature is, the
// minimum tier it needs, whether the 7-day Pro trial unlocks it, its graceful
// free fallback, and how (un)obtrusively to surface an upgrade. Local-first
// philosophy: core.* features are always free; paid features degrade gracefully.

import type { LicenseTier } from './license';

export type FeatureId =
  | 'core.kdream.basic'
  | 'core.adapters.install'
  | 'core.doctor'
  | 'core.launchSkill'
  | 'core.reports.basicMarkdown'
  | 'core.history.limited'
  | 'core.intelligence.basic'
  | 'pro.autobuild.schedule'
  | 'pro.orchestrate.advanced'
  | 'pro.mateam.launch'
  | 'pro.reports.prEvidence'
  | 'pro.history.full'
  | 'pro.agentScorecards'
  | 'pro.githubIssueImport'
  | 'pro.kiroTasksImport'
  | 'pro.zippyMeshIntegration'
  | 'team.sharedMemory'
  | 'team.policyEngine'
  | 'team.auditLogs'
  | 'team.privateSkillRegistry'
  | 'team.cloudRelay'
  | 'enterprise.sso'
  | 'enterprise.selfHostedControlPlane'
  | 'enterprise.airGappedMode';

export interface FeatureDefinition {
  id: FeatureId;
  label: string;
  description: string;
  minimumTier: LicenseTier;
  /** Whether the 7-day Pro trial unlocks this feature. */
  trialAllowed: boolean;
  /** A free feature to fall back to when this one is gated, if any. */
  fallbackFeature?: FeatureId;
  /** True when the feature costs us (Zippy) money to run (hosted). */
  hostedCost?: boolean;
  /** How obtrusively to surface the upgrade prompt. */
  nagStyle: 'none' | 'statusbar' | 'inline' | 'toast';
}

export const FEATURE_DEFINITIONS: Record<FeatureId, FeatureDefinition> = {
  'core.kdream.basic': {
    id: 'core.kdream.basic', label: 'Basic KDream Memory',
    description: 'Basic local project memory and follow-up tracking.',
    minimumTier: 'free', trialAllowed: true, nagStyle: 'none',
  },
  'core.adapters.install': {
    id: 'core.adapters.install', label: 'Adapter Install',
    description: 'Install local skill/adapters for detected AI coding tools.',
    minimumTier: 'free', trialAllowed: true, nagStyle: 'none',
  },
  'core.doctor': {
    id: 'core.doctor', label: 'Doctor Health Check',
    description: 'Run AutoClaw health checks.',
    minimumTier: 'free', trialAllowed: true, nagStyle: 'none',
  },
  'core.launchSkill': {
    id: 'core.launchSkill', label: 'Launch Skill',
    description: 'Launch or copy AutoClaw skill prompts.',
    minimumTier: 'free', trialAllowed: true, nagStyle: 'none',
  },
  'core.reports.basicMarkdown': {
    id: 'core.reports.basicMarkdown', label: 'Basic Markdown Report',
    description: 'Generate a basic local markdown summary.',
    minimumTier: 'free', trialAllowed: true, nagStyle: 'none',
  },
  'core.history.limited': {
    id: 'core.history.limited', label: 'Limited Local History',
    description: 'Keep a limited amount of local run history.',
    minimumTier: 'free', trialAllowed: true, nagStyle: 'none',
  },
  'core.intelligence.basic': {
    id: 'core.intelligence.basic', label: 'Basic Intelligence',
    description: 'Basic local indexing/search utilities.',
    minimumTier: 'free', trialAllowed: true, nagStyle: 'none',
  },
  'pro.autobuild.schedule': {
    id: 'pro.autobuild.schedule', label: 'Scheduled AutoBuild Workflows',
    description: 'Schedule repeatable local build workflows.',
    minimumTier: 'pro', trialAllowed: true, fallbackFeature: 'core.launchSkill', nagStyle: 'inline',
  },
  'pro.orchestrate.advanced': {
    id: 'pro.orchestrate.advanced', label: 'Advanced Orchestration',
    description: 'Plan and manage multi-agent sprint workflows.',
    minimumTier: 'pro', trialAllowed: true, fallbackFeature: 'core.launchSkill', nagStyle: 'inline',
  },
  'pro.mateam.launch': {
    id: 'pro.mateam.launch', label: 'MAteam Multi-Agent Teams',
    description: 'Launch coordinated researcher/coder/reviewer/verifier workflows.',
    minimumTier: 'pro', trialAllowed: true, fallbackFeature: 'core.launchSkill', nagStyle: 'inline',
  },
  'pro.reports.prEvidence': {
    id: 'pro.reports.prEvidence', label: 'PR Evidence Report',
    description: 'Generate full PR-ready evidence reports for agent work.',
    minimumTier: 'pro', trialAllowed: true, fallbackFeature: 'core.reports.basicMarkdown', nagStyle: 'inline',
  },
  'pro.history.full': {
    id: 'pro.history.full', label: 'Full Local History',
    description: 'Keep complete local run history.',
    minimumTier: 'pro', trialAllowed: true, fallbackFeature: 'core.history.limited', nagStyle: 'inline',
  },
  'pro.agentScorecards': {
    id: 'pro.agentScorecards', label: 'Agent Scorecards',
    description: 'Track agent performance and effectiveness.',
    minimumTier: 'pro', trialAllowed: true, fallbackFeature: 'core.reports.basicMarkdown', nagStyle: 'inline',
  },
  'pro.githubIssueImport': {
    id: 'pro.githubIssueImport', label: 'GitHub Issue Import',
    description: 'Import GitHub issues into AutoClaw workflows.',
    minimumTier: 'pro', trialAllowed: true, fallbackFeature: 'core.launchSkill', nagStyle: 'inline',
  },
  'pro.kiroTasksImport': {
    id: 'pro.kiroTasksImport', label: 'Kiro tasks.md Import',
    description: 'Import Kiro tasks.md into AutoClaw workflows.',
    minimumTier: 'pro', trialAllowed: true, fallbackFeature: 'core.launchSkill', nagStyle: 'inline',
  },
  'pro.zippyMeshIntegration': {
    id: 'pro.zippyMeshIntegration', label: 'ZippyMesh Integration',
    description: 'Integrate with ZippyMesh local/model routing workflows.',
    minimumTier: 'pro', trialAllowed: true, fallbackFeature: 'core.intelligence.basic', nagStyle: 'inline',
  },
  'team.sharedMemory': {
    id: 'team.sharedMemory', label: 'Team Shared Memory',
    description: 'Shared project memory across multiple users/agents.',
    minimumTier: 'teams', trialAllowed: true, fallbackFeature: 'core.kdream.basic', nagStyle: 'toast',
  },
  'team.policyEngine': {
    id: 'team.policyEngine', label: 'Policy Engine',
    description: 'Team and workspace policy enforcement for agent activity.',
    minimumTier: 'teams', trialAllowed: true, nagStyle: 'toast',
  },
  'team.auditLogs': {
    id: 'team.auditLogs', label: 'Audit Logs',
    description: 'Team-level audit logs for agent activity.',
    minimumTier: 'teams', trialAllowed: true, fallbackFeature: 'core.history.limited', nagStyle: 'toast',
  },
  'team.privateSkillRegistry': {
    id: 'team.privateSkillRegistry', label: 'Private Skill Registry',
    description: 'Private team/enterprise skill pack registry.',
    minimumTier: 'teams', trialAllowed: true, hostedCost: true, nagStyle: 'toast',
  },
  'team.cloudRelay': {
    id: 'team.cloudRelay', label: 'Cloud Relay',
    description: 'Cross-machine relay/sync for teams.',
    minimumTier: 'teams', trialAllowed: true, hostedCost: true, nagStyle: 'toast',
  },
  'enterprise.sso': {
    id: 'enterprise.sso', label: 'SSO',
    description: 'Enterprise single sign-on.',
    minimumTier: 'enterprise', trialAllowed: false, nagStyle: 'toast',
  },
  'enterprise.selfHostedControlPlane': {
    id: 'enterprise.selfHostedControlPlane', label: 'Self-Hosted Control Plane',
    description: 'Enterprise self-hosted control plane.',
    minimumTier: 'enterprise', trialAllowed: false, nagStyle: 'toast',
  },
  'enterprise.airGappedMode': {
    id: 'enterprise.airGappedMode', label: 'Air-Gapped Mode',
    description: 'Enterprise air-gapped deployment support.',
    minimumTier: 'enterprise', trialAllowed: false, nagStyle: 'toast',
  },
};
