# AutoClaw Licensing, Trial, Feature-Gate, and Public/Private Build Refactor

## Purpose

Refactor AutoClaw so the extension can support:

1. A 7-day full-feature trial that starts on first meaningful use, not installation.
2. Graceful fallback to Free Community mode after trial expiration.
3. Minimally intrusive upgrade reminders.
4. Paid Solo/Pro/Teams/Enterprise entitlement checks.
5. One-time major-version licenses with update-window semantics.
6. Optional subscriptions for Teams/Enterprise.
7. Public/core source-available repo structure with future private premium modules.
8. One smooth published VSIX experience with free mode, trial mode, and paid unlock.
9. No hostile DRM, no hidden telemetry, no lockout of user-created data.

This file is intended to be given directly to Claude Code or another coding agent inside VS Code while working in the AutoClaw repository.

---

## Current Repo Context

Current repository: `GoZippy/autoclaw`

Current relevant files already present:

```text
src/licensing/license.ts
src/licensing/licensing.ts
src/licensing/publicKey.ts
src/extension.ts
package.json
LICENSE
```

Current licensing behavior:

- `license.ts` already implements offline signed license verification.
- `licensing.ts` already registers:
  - `autoclaw.license.enter`
  - `autoclaw.license.status`
  - `autoclaw.license.clear`
  - `autoclaw.byok.set`
- Current license tiers are `free`, `pro`, `teams`, and `enterprise`.
- Current `requireHosted()` only gates hosted features that cost Zippy money.
- Current design explicitly does not gate local features.

New target behavior:

- Keep local-first and non-abusive philosophy.
- Add feature gates for paid local features, but always provide graceful fallback where reasonable.
- Preserve free local usability.
- Make paid/commercial value clear without nagging users constantly.
- Keep user-created data visible/exportable even after trial expiration.

---

## Strategic Product Rules

### Rule 1: One install should feel like one product

The normal user should install one extension:

```text
ZippyTechnologiesLLC.autoclaw
```

They should not need to uninstall/reinstall a different extension to unlock Pro.

### Rule 2: Public repo should remain useful

The public/source-available repo should contain:

- core extension shell
- licensing client
- trial client
- feature registry
- gate service
- free implementations
- premium interfaces
- premium stubs
- basic docs
- basic reports
- basic KDream/Doctor/adapter workflows

### Rule 3: Private premium modules can come later

Design the code so premium implementations can later live in a private package or repo, but do not require that split to complete this first refactor.

Future private repos may include:

```text
GoZippy/autoclaw-premium
GoZippy/autoclaw-team
GoZippy/autoclaw-enterprise
GoZippy/autoclaw-license-service
```

### Rule 4: Never put secrets into the VSIX

Do not include:

- license private signing keys
- Stripe/Lemon/Gumroad secrets
- webhook secrets
- cloud service credentials
- admin tokens
- any private server secret

The VSIX may contain only the public verification key.

### Rule 5: Client-side gates are UX/compliance gates, not perfect security

Do not attempt invasive DRM.

Use:

- signed license verification
- clear legal license terms
- low-friction UX
- optional online validation later
- hosted/team features for stronger enforcement

### Rule 6: Do not lock user data after trial

After trial expiration, the user must still be able to view/export their own local data, run logs, basic memory, and basic reports.

Paid gates may disable advanced analysis, advanced export, branding removal, team sync, policy enforcement, and advanced orchestration.

---

## Desired Licensing Model

### Trial

- Full Pro unlock for 7 days.
- Trial starts on first meaningful use, not extension install.
- No account required for local trial.
- No credit card required.
- Trial state stored locally using VS Code `context.globalState`.
- Trial should not restart just because the extension is reinstalled.
- Reasonable local reset resistance is enough; do not implement hostile fingerprinting.

### Free Community

After trial, fallback to useful Free mode.

Allowed:

- basic KDream memory
- basic Doctor/health checks
- basic adapter install/generation
- basic TODO/FIXME tracking
- manual skill launch
- limited local run history
- basic markdown summaries/reports
- personal/educational/open-source/evaluation use
- viewing/exporting user-created data

Limited/gated:

- commercial use rights
- full local history
- scheduled AutoBuild
- advanced Orchestrate
- MAteam multi-agent workflows
- PR evidence reports
- agent scorecards
- branded/client-ready report export
- team/shared memory
- cloud relay
- private skill registry
- policy engine
- audit dashboards
- enterprise deployment features

### Solo/Pro One-Time Licenses

Support one-time paid licenses tied to a major version/update window.

Example policy:

```text
Buy AutoClaw Pro v1 once.
Use that major version forever.
Includes 12 months of updates.
Renew only to receive another year of updates or next major version access.
```

### Teams/Enterprise

Teams/Enterprise may be subscription or annual seat licenses.

They may unlock:

- team shared memory
- multi-seat enforcement hints
- policy engine
- audit logs
- cloud relay
- hosted/private skill registry
- SSO later
- self-hosted control plane later

---

## Implementation Overview

Add these new modules:

```text
src/licensing/features.ts
src/licensing/trialService.ts
src/licensing/entitlementService.ts
src/licensing/gateService.ts
src/licensing/nagService.ts
src/licensing/licenseStore.ts
src/licensing/statusBar.ts
src/premium/premiumApi.ts
src/premium/unavailablePremium.ts
src/premium/index.ts
```

Modify:

```text
src/licensing/license.ts
src/licensing/licensing.ts
src/extension.ts
package.json
```

Optional docs to add:

```text
docs/licensing.md
docs/editions.md
docs/build-editions.md
COMMERCIAL_TERMS.md
```

Optional tests to add:

```text
src/test/licensing/license.test.ts
src/test/licensing/trialService.test.ts
src/test/licensing/gateService.test.ts
```

---

## Step 1: Extend License Types

Modify `src/licensing/license.ts`.

Current tier type:

```ts
export type LicenseTier = 'free' | 'pro' | 'teams' | 'enterprise';
```

Change to:

```ts
export type LicenseTier =
  | 'free'
  | 'solo'
  | 'pro'
  | 'teams'
  | 'enterprise';

export type LicenseKind =
  | 'free'
  | 'trial'
  | 'perpetual-major'
  | 'subscription'
  | 'enterprise';
```

Extend `LicensePayload`:

```ts
export interface LicensePayload {
  /** Schema version. */
  v: number;

  /** Product guard. Must be "autoclaw" when present. */
  product?: 'autoclaw';

  tier: LicenseTier;

  /** License style. */
  licenseKind?: LicenseKind;

  /** Seats covered. 1 for Solo/Pro. */
  seats: number;

  /** Licensee email, informational. */
  email?: string;

  /** Issued-at, epoch seconds. */
  iat: number;

  /** Expiry for subscriptions/trials. null means perpetual use for the licensed major version. */
  exp: number | null;

  /** Major version this license applies to. Example: 1, 2, 3. */
  majorVersion?: number;

  /** End of included updates/support window. User keeps the last eligible version after this date. */
  updatesUntil?: number;

  /** Optional explicit feature grants for special licenses. */
  features?: string[];
}
```

Extend `Entitlement`:

```ts
export interface Entitlement {
  tier: LicenseTier;
  valid: boolean;
  reason: string;
  email?: string;
  seats?: number;
  expiresAt?: number | null;
  product?: 'autoclaw';
  licenseKind?: LicenseKind;
  majorVersion?: number;
  updatesUntil?: number;
  features?: string[];
  commercialUseAllowed?: boolean;
  updatesActive?: boolean;
}
```

Update `FREE_ENTITLEMENT`:

```ts
export const FREE_ENTITLEMENT: Entitlement = {
  tier: 'free',
  valid: true,
  reason: 'Free Community mode: personal, educational, open-source, and evaluation use.',
  licenseKind: 'free',
  commercialUseAllowed: false,
  updatesActive: false,
};
```

Update verification logic:

- Validate product if present. If `payload.product` exists and is not `autoclaw`, return invalid.
- Support `solo` as paid.
- Expired subscription/trial means invalid for paid features.
- `exp: null` is valid for perpetual-major licenses.
- `updatesUntil` does not invalidate use; it only marks whether updates are active.

Add helpers:

```ts
export function isCommercialTier(ent: Entitlement): boolean {
  return ent.valid && ['solo', 'pro', 'teams', 'enterprise'].includes(ent.tier);
}

export function isPaid(ent: Entitlement): boolean {
  return isCommercialTier(ent);
}

export function tierRank(tier: LicenseTier): number {
  switch (tier) {
    case 'enterprise': return 4;
    case 'teams': return 3;
    case 'pro': return 2;
    case 'solo': return 1;
    case 'free':
    default: return 0;
  }
}

export function hasTierAtLeast(ent: Entitlement, required: LicenseTier): boolean {
  return ent.valid && tierRank(ent.tier) >= tierRank(required);
}

export function getCurrentMajorVersion(extensionVersion: string): number {
  const major = Number(extensionVersion.split('.')[0]);
  return Number.isFinite(major) && major > 0 ? major : 1;
}
```

Acceptance criteria:

- Existing license keys with old schema still work where possible.
- New license payloads with `solo` verify.
- Perpetual-major with `exp: null` verifies.
- Expired subscriptions are invalid for paid features.
- `updatesUntil` does not make the license unusable.

---

## Step 2: Add Feature Registry

Create `src/licensing/features.ts`.

```ts
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
  trialAllowed: boolean;
  fallbackFeature?: FeatureId;
  hostedCost?: boolean;
  nagStyle: 'none' | 'statusbar' | 'inline' | 'toast';
}

export const FEATURE_DEFINITIONS: Record<FeatureId, FeatureDefinition> = {
  'core.kdream.basic': {
    id: 'core.kdream.basic',
    label: 'Basic KDream Memory',
    description: 'Basic local project memory and follow-up tracking.',
    minimumTier: 'free',
    trialAllowed: true,
    nagStyle: 'none',
  },
  'core.adapters.install': {
    id: 'core.adapters.install',
    label: 'Adapter Install',
    description: 'Install local skill/adapters for detected AI coding tools.',
    minimumTier: 'free',
    trialAllowed: true,
    nagStyle: 'none',
  },
  'core.doctor': {
    id: 'core.doctor',
    label: 'Doctor Health Check',
    description: 'Run AutoClaw health checks.',
    minimumTier: 'free',
    trialAllowed: true,
    nagStyle: 'none',
  },
  'core.launchSkill': {
    id: 'core.launchSkill',
    label: 'Launch Skill',
    description: 'Launch or copy AutoClaw skill prompts.',
    minimumTier: 'free',
    trialAllowed: true,
    nagStyle: 'none',
  },
  'core.reports.basicMarkdown': {
    id: 'core.reports.basicMarkdown',
    label: 'Basic Markdown Report',
    description: 'Generate a basic local markdown summary.',
    minimumTier: 'free',
    trialAllowed: true,
    nagStyle: 'none',
  },
  'core.history.limited': {
    id: 'core.history.limited',
    label: 'Limited Local History',
    description: 'Keep a limited amount of local run history.',
    minimumTier: 'free',
    trialAllowed: true,
    nagStyle: 'none',
  },
  'core.intelligence.basic': {
    id: 'core.intelligence.basic',
    label: 'Basic Intelligence',
    description: 'Basic local indexing/search utilities.',
    minimumTier: 'free',
    trialAllowed: true,
    nagStyle: 'none',
  },
  'pro.autobuild.schedule': {
    id: 'pro.autobuild.schedule',
    label: 'Scheduled AutoBuild Workflows',
    description: 'Schedule repeatable local build workflows.',
    minimumTier: 'pro',
    trialAllowed: true,
    fallbackFeature: 'core.launchSkill',
    nagStyle: 'inline',
  },
  'pro.orchestrate.advanced': {
    id: 'pro.orchestrate.advanced',
    label: 'Advanced Orchestration',
    description: 'Plan and manage multi-agent sprint workflows.',
    minimumTier: 'pro',
    trialAllowed: true,
    fallbackFeature: 'core.launchSkill',
    nagStyle: 'inline',
  },
  'pro.mateam.launch': {
    id: 'pro.mateam.launch',
    label: 'MAteam Multi-Agent Teams',
    description: 'Launch coordinated researcher/coder/reviewer/verifier workflows.',
    minimumTier: 'pro',
    trialAllowed: true,
    fallbackFeature: 'core.launchSkill',
    nagStyle: 'inline',
  },
  'pro.reports.prEvidence': {
    id: 'pro.reports.prEvidence',
    label: 'PR Evidence Report',
    description: 'Generate full PR-ready evidence reports for agent work.',
    minimumTier: 'pro',
    trialAllowed: true,
    fallbackFeature: 'core.reports.basicMarkdown',
    nagStyle: 'inline',
  },
  'pro.history.full': {
    id: 'pro.history.full',
    label: 'Full Local History',
    description: 'Keep complete local run history.',
    minimumTier: 'pro',
    trialAllowed: true,
    fallbackFeature: 'core.history.limited',
    nagStyle: 'inline',
  },
  'pro.agentScorecards': {
    id: 'pro.agentScorecards',
    label: 'Agent Scorecards',
    description: 'Track agent performance and effectiveness.',
    minimumTier: 'pro',
    trialAllowed: true,
    fallbackFeature: 'core.reports.basicMarkdown',
    nagStyle: 'inline',
  },
  'pro.githubIssueImport': {
    id: 'pro.githubIssueImport',
    label: 'GitHub Issue Import',
    description: 'Import GitHub issues into AutoClaw workflows.',
    minimumTier: 'pro',
    trialAllowed: true,
    fallbackFeature: 'core.launchSkill',
    nagStyle: 'inline',
  },
  'pro.kiroTasksImport': {
    id: 'pro.kiroTasksImport',
    label: 'Kiro tasks.md Import',
    description: 'Import Kiro tasks.md into AutoClaw workflows.',
    minimumTier: 'pro',
    trialAllowed: true,
    fallbackFeature: 'core.launchSkill',
    nagStyle: 'inline',
  },
  'pro.zippyMeshIntegration': {
    id: 'pro.zippyMeshIntegration',
    label: 'ZippyMesh Integration',
    description: 'Integrate with ZippyMesh local/model routing workflows.',
    minimumTier: 'pro',
    trialAllowed: true,
    fallbackFeature: 'core.intelligence.basic',
    nagStyle: 'inline',
  },
  'team.sharedMemory': {
    id: 'team.sharedMemory',
    label: 'Team Shared Memory',
    description: 'Shared project memory across multiple users/agents.',
    minimumTier: 'teams',
    trialAllowed: true,
    fallbackFeature: 'core.kdream.basic',
    nagStyle: 'toast',
  },
  'team.policyEngine': {
    id: 'team.policyEngine',
    label: 'Policy Engine',
    description: 'Team and workspace policy enforcement for agent activity.',
    minimumTier: 'teams',
    trialAllowed: true,
    nagStyle: 'toast',
  },
  'team.auditLogs': {
    id: 'team.auditLogs',
    label: 'Audit Logs',
    description: 'Team-level audit logs for agent activity.',
    minimumTier: 'teams',
    trialAllowed: true,
    fallbackFeature: 'core.history.limited',
    nagStyle: 'toast',
  },
  'team.privateSkillRegistry': {
    id: 'team.privateSkillRegistry',
    label: 'Private Skill Registry',
    description: 'Private team/enterprise skill pack registry.',
    minimumTier: 'teams',
    trialAllowed: true,
    hostedCost: true,
    nagStyle: 'toast',
  },
  'team.cloudRelay': {
    id: 'team.cloudRelay',
    label: 'Cloud Relay',
    description: 'Cross-machine relay/sync for teams.',
    minimumTier: 'teams',
    trialAllowed: true,
    hostedCost: true,
    nagStyle: 'toast',
  },
  'enterprise.sso': {
    id: 'enterprise.sso',
    label: 'SSO',
    description: 'Enterprise single sign-on.',
    minimumTier: 'enterprise',
    trialAllowed: false,
    nagStyle: 'toast',
  },
  'enterprise.selfHostedControlPlane': {
    id: 'enterprise.selfHostedControlPlane',
    label: 'Self-Hosted Control Plane',
    description: 'Enterprise self-hosted control plane.',
    minimumTier: 'enterprise',
    trialAllowed: false,
    nagStyle: 'toast',
  },
  'enterprise.airGappedMode': {
    id: 'enterprise.airGappedMode',
    label: 'Air-Gapped Mode',
    description: 'Enterprise air-gapped deployment support.',
    minimumTier: 'enterprise',
    trialAllowed: false,
    nagStyle: 'toast',
  },
};
```

Acceptance criteria:

- All features have definitions.
- Free features have no upgrade nags.
- Paid features define fallback where possible.
- Hosted-cost features are clearly marked.

---

## Step 3: Add License Store

Create `src/licensing/licenseStore.ts`.

```ts
import * as vscode from 'vscode';

const LICENSE_SECRET = 'autoclaw.license.key';
const BYO_KEY_SECRET = 'autoclaw.byok.apiKey';

export class LicenseStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async getLicenseKey(): Promise<string | undefined> {
    const key = await this.context.secrets.get(LICENSE_SECRET);
    return key?.trim() || undefined;
  }

  async setLicenseKey(key: string): Promise<void> {
    await this.context.secrets.store(LICENSE_SECRET, key.trim());
  }

  async clearLicenseKey(): Promise<void> {
    await this.context.secrets.delete(LICENSE_SECRET);
  }

  async getByoKey(): Promise<string | undefined> {
    const key = await this.context.secrets.get(BYO_KEY_SECRET);
    return key?.trim() || undefined;
  }

  async setByoKey(key: string): Promise<void> {
    await this.context.secrets.store(BYO_KEY_SECRET, key.trim());
  }

  async clearByoKey(): Promise<void> {
    await this.context.secrets.delete(BYO_KEY_SECRET);
  }

  async hasByoKey(): Promise<boolean> {
    return !!(await this.getByoKey());
  }
}
```

Refactor `licensing.ts` to use `LicenseStore`.

Acceptance criteria:

- No direct reference to `LICENSE_SECRET` or `BYO_KEY_SECRET` outside `licenseStore.ts` unless justified.
- Existing commands still work.

---

## Step 4: Add Trial Service

Create `src/licensing/trialService.ts`.

```ts
import * as vscode from 'vscode';

const TRIAL_STATE_KEY = 'autoclaw.trial.state';
const TRIAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrialState {
  firstMeaningfulUseAt?: number;
  trialEndsAt?: number;
  trialConsumed: boolean;
  lastNagAt?: number;
}

export interface TrialStatus {
  active: boolean;
  consumed: boolean;
  started: boolean;
  startedAt?: number;
  endsAt?: number;
  daysRemaining?: number;
}

export class TrialService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getState(): TrialState {
    return this.context.globalState.get<TrialState>(TRIAL_STATE_KEY, {
      trialConsumed: false,
    });
  }

  async saveState(state: TrialState): Promise<void> {
    await this.context.globalState.update(TRIAL_STATE_KEY, state);
  }

  getStatus(now = Date.now()): TrialStatus {
    const state = this.getState();

    if (!state.firstMeaningfulUseAt || !state.trialEndsAt) {
      return {
        active: false,
        consumed: !!state.trialConsumed,
        started: false,
      };
    }

    const active = now <= state.trialEndsAt;
    const daysRemaining = active
      ? Math.max(0, Math.ceil((state.trialEndsAt - now) / DAY_MS))
      : 0;

    return {
      active,
      consumed: !!state.trialConsumed || !active,
      started: true,
      startedAt: state.firstMeaningfulUseAt,
      endsAt: state.trialEndsAt,
      daysRemaining,
    };
  }

  async startIfNeeded(reason: string, now = Date.now()): Promise<TrialStatus> {
    const state = this.getState();

    if (state.firstMeaningfulUseAt && state.trialEndsAt) {
      return this.getStatus(now);
    }

    if (state.trialConsumed) {
      return this.getStatus(now);
    }

    const next: TrialState = {
      ...state,
      firstMeaningfulUseAt: now,
      trialEndsAt: now + TRIAL_DAYS * DAY_MS,
      trialConsumed: false,
    };

    await this.saveState(next);

    vscode.window.showInformationMessage(
      `AutoClaw Pro trial started: 7 days of full access. Trigger: ${reason}. No account required.`,
    );

    return this.getStatus(now);
  }

  async markConsumedIfExpired(now = Date.now()): Promise<TrialStatus> {
    const state = this.getState();
    if (state.trialEndsAt && now > state.trialEndsAt && !state.trialConsumed) {
      await this.saveState({ ...state, trialConsumed: true });
    }
    return this.getStatus(now);
  }

  async setLastNagAt(now = Date.now()): Promise<void> {
    const state = this.getState();
    await this.saveState({ ...state, lastNagAt: now });
  }

  getLastNagAt(): number | undefined {
    return this.getState().lastNagAt;
  }
}
```

Acceptance criteria:

- Trial does not start on install/activation.
- Trial starts only when `startIfNeeded()` is called.
- Trial lasts 7 days.
- Expired trial becomes consumed.
- User can still use free features after trial.

---

## Step 5: Add Entitlement Service

Create `src/licensing/entitlementService.ts`.

```ts
import * as vscode from 'vscode';
import {
  Entitlement,
  FREE_ENTITLEMENT,
  verifyLicenseKey,
  isPaid,
  LicenseTier,
} from './license';
import { LICENSE_PUBLIC_KEY_PEM } from './publicKey';
import { LicenseStore } from './licenseStore';
import { TrialService } from './trialService';

export interface EffectiveEntitlement {
  base: Entitlement;
  effectiveTier: LicenseTier;
  reason: 'free' | 'trial' | 'licensed' | 'byo-hosted' | 'expired-license';
  trialActive: boolean;
  trialEndsAt?: number;
  hasByoKey: boolean;
  commercialUseAllowed: boolean;
}

export class EntitlementService {
  private readonly store: LicenseStore;
  private readonly trial: TrialService;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.store = new LicenseStore(context);
    this.trial = new TrialService(context);
  }

  async getBaseEntitlement(): Promise<Entitlement> {
    const key = await this.store.getLicenseKey();
    if (!key) return FREE_ENTITLEMENT;

    const ent = verifyLicenseKey(key, LICENSE_PUBLIC_KEY_PEM);
    if (!ent.valid) return ent;

    return ent;
  }

  async getEffectiveEntitlement(): Promise<EffectiveEntitlement> {
    const base = await this.getBaseEntitlement();
    const trialStatus = await this.trial.markConsumedIfExpired();
    const hasByoKey = await this.store.hasByoKey();

    if (isPaid(base)) {
      return {
        base,
        effectiveTier: base.tier,
        reason: 'licensed',
        trialActive: trialStatus.active,
        trialEndsAt: trialStatus.endsAt,
        hasByoKey,
        commercialUseAllowed: true,
      };
    }

    if (trialStatus.active) {
      return {
        base,
        effectiveTier: 'pro',
        reason: 'trial',
        trialActive: true,
        trialEndsAt: trialStatus.endsAt,
        hasByoKey,
        commercialUseAllowed: false,
      };
    }

    return {
      base,
      effectiveTier: 'free',
      reason: base.valid ? 'free' : 'expired-license',
      trialActive: false,
      trialEndsAt: trialStatus.endsAt,
      hasByoKey,
      commercialUseAllowed: false,
    };
  }

  async startTrialIfNeeded(reason: string) {
    return this.trial.startIfNeeded(reason);
  }

  async hasByoKey(): Promise<boolean> {
    return this.store.hasByoKey();
  }
}
```

Acceptance criteria:

- Paid license beats trial.
- Active trial grants effective Pro feature access but not commercial-use legal rights.
- Expired/invalid license falls back to Free.
- BYO key remains available for hosted features if allowed by design.

---

## Step 6: Add Gate Service

Create `src/licensing/gateService.ts`.

```ts
import * as vscode from 'vscode';
import { FEATURE_DEFINITIONS, FeatureId } from './features';
import { EntitlementService } from './entitlementService';
import { LicenseTier, tierRank } from './license';

export interface GateOptions {
  startTrial?: boolean;
  reason?: string;
  silent?: boolean;
  allowByoForHosted?: boolean;
}

export interface GateResult {
  allowed: boolean;
  feature: FeatureId;
  label: string;
  effectiveTier: LicenseTier;
  reason:
    | 'free'
    | 'trial'
    | 'licensed'
    | 'hosted-byo'
    | 'tier-too-low'
    | 'trial-expired'
    | 'missing-license';
  fallbackFeature?: FeatureId;
}

export class GateService {
  private readonly entitlements: EntitlementService;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.entitlements = new EntitlementService(context);
  }

  async check(feature: FeatureId, options: GateOptions = {}): Promise<GateResult> {
    const def = FEATURE_DEFINITIONS[feature];
    if (!def) throw new Error(`Unknown AutoClaw feature: ${feature}`);

    if (options.startTrial && def.trialAllowed) {
      await this.entitlements.startTrialIfNeeded(options.reason ?? def.label);
    }

    const effective = await this.entitlements.getEffectiveEntitlement();

    if (tierRank(effective.effectiveTier) >= tierRank(def.minimumTier)) {
      return {
        allowed: true,
        feature,
        label: def.label,
        effectiveTier: effective.effectiveTier,
        reason: effective.reason === 'trial' ? 'trial' : effective.reason === 'licensed' ? 'licensed' : 'free',
      };
    }

    if (def.hostedCost && options.allowByoForHosted && effective.hasByoKey) {
      return {
        allowed: true,
        feature,
        label: def.label,
        effectiveTier: effective.effectiveTier,
        reason: 'hosted-byo',
      };
    }

    return {
      allowed: false,
      feature,
      label: def.label,
      effectiveTier: effective.effectiveTier,
      reason: effective.trialEndsAt ? 'trial-expired' : 'missing-license',
      fallbackFeature: def.fallbackFeature,
    };
  }

  async require(feature: FeatureId, options: GateOptions = {}): Promise<GateResult> {
    const result = await this.check(feature, options);
    if (!result.allowed && !options.silent) {
      await this.showUpgradeOrFallback(result);
    }
    return result;
  }

  async showUpgradeOrFallback(result: GateResult): Promise<void> {
    const def = FEATURE_DEFINITIONS[result.feature];

    const actions = ['Compare Plans', 'Enter License'];
    if (result.fallbackFeature) actions.unshift('Use Free Fallback');
    actions.push('Not Now');

    const choice = await vscode.window.showInformationMessage(
      `${def.label} is available in AutoClaw ${def.minimumTier.toUpperCase()} or during the 7-day Pro trial. AutoClaw Free remains active.`,
      ...actions,
    );

    if (choice === 'Compare Plans') {
      await vscode.commands.executeCommand('autoclaw.support.open');
    } else if (choice === 'Enter License') {
      await vscode.commands.executeCommand('autoclaw.license.enter');
    }
  }
}
```

Acceptance criteria:

- Free features always pass.
- Pro features pass during trial.
- Pro features pass with Pro/Teams/Enterprise licenses.
- Team features pass with Teams/Enterprise licenses.
- Enterprise features pass only with Enterprise license.
- Hosted features can pass with BYO key if `allowByoForHosted` is true.
- Failed gates show one polite prompt, not repeated popups.

---

## Step 7: Add Nag Service

Create `src/licensing/nagService.ts`.

```ts
import * as vscode from 'vscode';

const NAG_STATE_KEY = 'autoclaw.nag.state';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

interface NagState {
  lastGlobalNagAt?: number;
  lastFeatureNagAt?: Record<string, number>;
}

export class NagService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private getState(): NagState {
    return this.context.globalState.get<NagState>(NAG_STATE_KEY, {});
  }

  private async saveState(state: NagState): Promise<void> {
    await this.context.globalState.update(NAG_STATE_KEY, state);
  }

  async shouldShowGlobalNag(now = Date.now()): Promise<boolean> {
    const state = this.getState();
    return !state.lastGlobalNagAt || now - state.lastGlobalNagAt > TWO_WEEKS_MS;
  }

  async markGlobalNagShown(now = Date.now()): Promise<void> {
    const state = this.getState();
    await this.saveState({ ...state, lastGlobalNagAt: now });
  }

  async shouldShowFeatureNag(featureId: string, now = Date.now()): Promise<boolean> {
    const state = this.getState();
    const last = state.lastFeatureNagAt?.[featureId];
    return !last || now - last > WEEK_MS;
  }

  async markFeatureNagShown(featureId: string, now = Date.now()): Promise<void> {
    const state = this.getState();
    await this.saveState({
      ...state,
      lastFeatureNagAt: {
        ...(state.lastFeatureNagAt ?? {}),
        [featureId]: now,
      },
    });
  }

  async showTrialEndedOnce(): Promise<void> {
    if (!(await this.shouldShowGlobalNag())) return;

    await this.markGlobalNagShown();
    vscode.window.showInformationMessage(
      'AutoClaw Pro trial ended. AutoClaw Free remains active. Upgrade anytime for Pro reports, advanced orchestration, and commercial use.',
      'Compare Plans',
      'Enter License',
      'Continue Free',
    ).then(choice => {
      if (choice === 'Compare Plans') {
        vscode.commands.executeCommand('autoclaw.support.open');
      } else if (choice === 'Enter License') {
        vscode.commands.executeCommand('autoclaw.license.enter');
      }
    });
  }
}
```

Acceptance criteria:

- No nag on every VS Code startup.
- No blocking modal.
- Global nags limited to no more than every 14 days.
- Feature nags limited to no more than weekly per feature.
- User can always continue free mode.

---

## Step 8: Add Status Bar Indicator

Create `src/licensing/statusBar.ts`.

```ts
import * as vscode from 'vscode';
import { EntitlementService } from './entitlementService';

export class LicenseStatusBar {
  private item: vscode.StatusBarItem;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.command = 'autoclaw.license.status';
    this.context.subscriptions.push(this.item);
  }

  async refresh(): Promise<void> {
    const svc = new EntitlementService(this.context);
    const ent = await svc.getEffectiveEntitlement();

    if (ent.reason === 'trial') {
      const days = ent.trialEndsAt
        ? Math.max(0, Math.ceil((ent.trialEndsAt - Date.now()) / (24 * 60 * 60 * 1000)))
        : 0;
      this.item.text = `$(rocket) AutoClaw Trial ${days}d`;
      this.item.tooltip = 'AutoClaw Pro trial is active. Click for license status.';
    } else if (ent.reason === 'licensed') {
      this.item.text = `$(verified) AutoClaw ${ent.effectiveTier}`;
      this.item.tooltip = 'AutoClaw commercial license active. Click for details.';
    } else {
      this.item.text = `$(zap) AutoClaw Free`;
      this.item.tooltip = 'AutoClaw Free Community mode. Click for license status.';
    }

    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
```

Modify `extension.ts` activation:

```ts
const licenseStatusBar = new LicenseStatusBar(context);
context.subscriptions.push({ dispose: () => licenseStatusBar.dispose() });
void licenseStatusBar.refresh();
```

Refresh status bar after:

- license enter
- license clear
- BYO key set/clear
- trial start
- trial expiration check

Acceptance criteria:

- Status bar appears after activation.
- Clicking opens license status.
- Status updates after license changes.

---

## Step 9: Refactor licensing.ts

Modify `src/licensing/licensing.ts`.

Goals:

- Use `LicenseStore`.
- Use `EntitlementService`.
- Keep existing command names stable.
- Add commands:
  - `autoclaw.license.comparePlans`
  - `autoclaw.trial.status`
  - `autoclaw.trial.start`
- Keep `requireHosted()` but implement using `GateService`.

Preserve existing exports:

```ts
export async function getEntitlement(context: vscode.ExtensionContext): Promise<Entitlement>;
export async function hasByoKey(context: vscode.ExtensionContext): Promise<boolean>;
export async function getByoKey(context: vscode.ExtensionContext): Promise<string | undefined>;
export async function requireHosted(context: vscode.ExtensionContext, featureLabel: string): Promise<boolean>;
```

Compatibility:

- Preserve current imports from existing code.
- Do not break existing hosted feature calls.

Updated `requireHosted()` behavior:

```ts
export async function requireHosted(
  context: vscode.ExtensionContext,
  featureLabel: string,
): Promise<boolean> {
  const gate = new GateService(context);
  const result = await gate.require('team.cloudRelay', {
    allowByoForHosted: true,
    reason: featureLabel,
  });
  return result.allowed;
}
```

Acceptance criteria:

- Existing hosted behavior remains.
- Existing license commands remain.
- New trial/status commands work.

---

## Step 10: Add Premium API Stubs

Create `src/premium/premiumApi.ts`.

```ts
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
```

Create `src/premium/unavailablePremium.ts`.

```ts
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
        `Created: ${new Date().toISOString()}`,
        '',
        '## Free Summary',
        '',
        '- Basic report generated from Free Community fallback.',
        '- Upgrade to Pro for agent run history, changed-file evidence, command log evidence, test evidence, and reviewer verdicts.',
      ].join('\n');

      return {
        markdown,
        createdAt: new Date().toISOString(),
        featureTier: 'pro',
      };
    },
  };
}
```

Create `src/premium/index.ts`.

```ts
import type { PremiumApi, PremiumApiFactoryContext } from './premiumApi';
import { createUnavailablePremiumApi } from './unavailablePremium';

export function createPremiumApi(ctx: PremiumApiFactoryContext): PremiumApi {
  return createUnavailablePremiumApi(ctx);
}

export type {
  PremiumApi,
  PremiumApiFactoryContext,
  PrEvidenceReport,
  PrEvidenceReportInput,
} from './premiumApi';
```

Later, in pro builds, this file can be replaced or aliased to a private premium implementation.

Acceptance criteria:

- Public repo builds without private premium package.
- Commands can call `createPremiumApi()` without import errors.
- Free fallback works.

---

## Step 11: Gate Existing Commands

Modify `extension.ts`.

Do not try to gate everything at once. Start with high-value candidate commands.

### Commands to keep free

Do not gate:

```text
autoclaw.enableAll
autoclaw.support.open
autoclaw.support.rate
autoclaw.license.enter
autoclaw.license.status
autoclaw.license.clear
autoclaw.byok.set
autoclaw.doctor
autoclaw.doctorJson
autoclaw.exportSnapshot
autoclaw.installAdapters
autoclaw.startKdream
autoclaw.launchSkill
kdream.showDashboard
kdream.refreshDashboard
kdream.addTask
```

### Commands to start trial on first meaningful use

These can start trial but not necessarily block:

```text
autoclaw.startKdream
autoclaw.installAdapters
autoclaw.launchSkill
autoclaw.intelligence.indexCode
autoclaw.orchestrate.plan
autoclaw.autobuild.runNow
```

### Commands to gate as Pro/Team

Gate initially:

```text
autoclaw.autobuild.runNow -> pro.autobuild.schedule
autoclaw.autobuild.tail -> pro.autobuild.schedule
autoclaw.orchestrate.plan -> pro.orchestrate.advanced
autoclaw.orchestrate.assign -> pro.orchestrate.advanced
autoclaw.orchestrate.review -> pro.orchestrate.advanced
autoclaw.orchestrate.merge -> pro.orchestrate.advanced
autoclaw.fleet.metrics -> pro.agentScorecards
autoclaw.voidspec.sync -> pro.orchestrate.advanced
autoclaw.program.create -> team.sharedMemory
autoclaw.program.join -> team.sharedMemory
autoclaw.program.leave -> team.sharedMemory
autoclaw.cloud.enableRelay -> team.cloudRelay
autoclaw.cloud.disableRelay -> team.cloudRelay
autoclaw.bridge.start -> team.sharedMemory
autoclaw.bridge.stop -> team.sharedMemory
autoclaw.bridge.addAgent -> team.sharedMemory
autoclaw.bridge.revokeToken -> team.sharedMemory
```

Example wrapper:

```ts
const gate = new GateService(context);

context.subscriptions.push(
  vscode.commands.registerCommand('autoclaw.orchestrate.plan', async () => {
    const access = await gate.require('pro.orchestrate.advanced', {
      startTrial: true,
      reason: 'Advanced Orchestration',
    });

    if (!access.allowed) {
      await vscode.commands.executeCommand('autoclaw.launchSkill');
      return;
    }

    // Existing implementation here.
  }),
);
```

Recommended helper:

```ts
async function withGate(
  context: vscode.ExtensionContext,
  feature: FeatureId,
  reason: string,
  runPaid: () => Promise<void>,
  runFallback?: () => Promise<void>,
): Promise<void> {
  const gate = new GateService(context);
  const result = await gate.require(feature, { startTrial: true, reason });
  if (result.allowed) {
    await runPaid();
  } else if (runFallback) {
    await runFallback();
  }
}
```

Acceptance criteria:

- Gated commands work during trial.
- Gated commands work with valid license.
- Gated commands fallback politely after trial.
- Free commands keep working.
- No command throws just because no license is present.

---

## Step 12: Add PR Evidence Report Command

Add command to `package.json`:

```json
{
  "command": "autoclaw.reports.prEvidence",
  "title": "AutoClaw: Reports — Generate PR Evidence Report"
}
```

Register command in `extension.ts`:

```ts
context.subscriptions.push(
  vscode.commands.registerCommand('autoclaw.reports.prEvidence', async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showWarningMessage('Open a workspace folder before generating a report.');
      return;
    }

    const gate = new GateService(context);
    const access = await gate.require('pro.reports.prEvidence', {
      startTrial: true,
      reason: 'PR Evidence Report',
    });

    const premium = createPremiumApi({ extensionPath: context.extensionPath });
    const report = await premium.generatePrEvidenceReport({ workspaceRoot });

    const doc = await vscode.workspace.openTextDocument({
      content: report.markdown,
      language: 'markdown',
    });
    await vscode.window.showTextDocument(doc);

    if (!access.allowed) {
      vscode.window.showInformationMessage(
        'Generated a basic free report. Unlock Pro for full evidence reports with tests, risks, changed files, agent history, and reviewer verdicts.',
        'Compare Plans',
        'Enter License',
      ).then(choice => {
        if (choice === 'Compare Plans') vscode.commands.executeCommand('autoclaw.support.open');
        if (choice === 'Enter License') vscode.commands.executeCommand('autoclaw.license.enter');
      });
    }
  }),
);
```

Note:

- In current public repo, `createPremiumApi()` returns a basic fallback.
- Later premium build can alias `createPremiumApi()` to a real premium module.

Acceptance criteria:

- Command appears in command palette.
- During trial/license, it is allowed.
- Without trial/license, it generates basic fallback report.
- It does not crash if premium module is unavailable.

---

## Step 13: Add Edition Build Structure

Create `src/edition.ts`.

```ts
export type AutoClawEdition = 'community' | 'marketplace' | 'enterprise';

export const AUTOCLAW_EDITION: AutoClawEdition =
  (process.env.AUTOCLAW_EDITION as AutoClawEdition) || 'community';

export function isCommunityEdition(): boolean {
  return AUTOCLAW_EDITION === 'community';
}

export function isMarketplaceEdition(): boolean {
  return AUTOCLAW_EDITION === 'marketplace';
}

export function isEnterpriseEdition(): boolean {
  return AUTOCLAW_EDITION === 'enterprise';
}
```

If TypeScript cannot see `process.env` because of bundling/type issues, either:

- use existing Node typings, or
- generate `src/generated/edition.ts` at build time.

Add scripts to `package.json` without breaking existing scripts:

```json
{
  "scripts": {
    "build:community": "cross-env AUTOCLAW_EDITION=community npm run compile",
    "build:marketplace": "cross-env AUTOCLAW_EDITION=marketplace npm run compile",
    "build:enterprise": "cross-env AUTOCLAW_EDITION=enterprise npm run compile",
    "package:community": "npm run build:community && vsce package --out dist/autoclaw-community.vsix",
    "package:marketplace": "npm run build:marketplace && vsce package --out dist/autoclaw.vsix"
  }
}
```

Only add `cross-env` if not already present.

Acceptance criteria:

- Existing `npm run compile` still works.
- New build scripts work or fail only because dependencies like `vsce` are missing.
- Community build does not require private packages.

---

## Step 14: Future Private Premium Module Hook

Do not implement private repo now unless available.

Prepare alias pattern in docs:

```text
@autoclaw/premium
```

Future paid build can replace:

```ts
import { createUnavailablePremiumApi } from './unavailablePremium';
```

with:

```ts
import { createPremiumApi } from '@autoclaw/premium';
```

Possible future `tsconfig` path alias:

```json
{
  "compilerOptions": {
    "paths": {
      "@autoclaw/premium": ["src/premium/unavailablePremium"]
    }
  }
}
```

Future pro build can override with bundler alias.

Acceptance criteria:

- Public repo has a documented premium interface.
- Public repo does not require private modules.
- Future premium repo can implement the same `PremiumApi` interface.

---

## Step 15: Update Docs

Create `docs/licensing.md`.

Content should explain:

- Free Community mode
- 7-day full Pro trial
- trial starts on first meaningful use
- commercial use requires Solo/Pro/Teams/Enterprise license
- one-time major-version license model
- updates included for 12 months
- user keeps last eligible major version
- Teams/Enterprise may require active subscription for hosted/team services
- no hidden source-code upload
- no secrets in VSIX
- BYO API key behavior

Create `docs/editions.md`.

Explain:

```text
Community:
  public/source-available core

Marketplace:
  same extension identity, free + trial + paid unlock

Enterprise:
  private/customer-specific build
```

Create `docs/build-editions.md`.

Explain:

- build scripts
- future private premium module alias
- how to package VSIX
- what must never be included in VSIX

Acceptance criteria:

- Docs are honest and consistent with code.
- Docs do not call AutoClaw “open source” unless license changes to OSI-approved.
- Use “source-available” or “free for personal/educational/evaluation use.”

---

## Step 16: Add COMMERCIAL_TERMS.md

Do not rewrite the entire legal license unless specifically instructed.

Add `COMMERCIAL_TERMS.md`:

```md
# AutoClaw Commercial Terms Summary

This is a plain-language summary, not a replacement for LICENSE.

- Free Community mode is available for personal, educational, open-source, and evaluation use.
- Commercial use requires a paid license.
- Solo/Pro licenses may be sold as one-time major-version licenses.
- Paid one-time licenses allow use of the purchased major version forever.
- Paid one-time licenses include updates for the stated update window, usually 12 months.
- After the update window ends, the user keeps using the last eligible version.
- Teams/Enterprise features may require active subscription or annual license.
- Hosted services may require active entitlement or BYO API key.
```

Acceptance criteria:

- Legal `LICENSE` remains source of truth.
- Summary does not conflict with `LICENSE`.
- If conflict is unavoidable, flag it in a TODO comment instead of silently changing legal terms.

---

## Step 17: Add Tests

Add or update tests for the following.

### License verification

Test file:

```text
src/test/licensing/license.test.ts
```

Cases:

- malformed key fails
- invalid signature fails
- expired key fails
- old pro key still works if compatible
- solo tier works
- perpetual-major with `exp: null` works
- wrong product fails
- `hasTierAtLeast()` ranking works

### Trial service

Test file:

```text
src/test/licensing/trialService.test.ts
```

Cases:

- initial state is not active
- `startIfNeeded()` starts trial
- second `startIfNeeded()` does not reset trial
- expired trial is consumed
- days remaining calculated

### Gate service

Test file:

```text
src/test/licensing/gateService.test.ts
```

Cases:

- free feature allowed without license
- pro feature allowed during trial
- pro feature denied after trial without license
- pro feature allowed with pro license
- team feature denied with pro license
- team feature allowed with teams license
- enterprise feature allowed only with enterprise
- hosted feature allowed with BYO when configured

Acceptance criteria:

- Existing test suite still passes.
- New tests pass.
- If test harness is missing, create minimal tests compatible with current project style.

---

## Step 18: Manual QA Checklist

After implementation, run:

```bash
npm install
npm run compile
npm test
```

If available:

```bash
npm run package:community
npm run package:marketplace
```

Manual VS Code test:

1. Install extension from local VSIX.
2. Confirm status bar shows `AutoClaw Free`.
3. Run `AutoClaw: License Status`.
4. Run a meaningful command and confirm trial starts.
5. Confirm status bar shows trial days.
6. Run a Pro-gated command during trial.
7. Simulate trial expiration by changing global state or test helper.
8. Run the same Pro command and confirm graceful fallback.
9. Enter invalid license key; confirm error.
10. Enter valid dev/test signed license key; confirm paid unlock.
11. Clear license; confirm Free mode returns.
12. Set BYO key; confirm hosted/BYO status.
13. Confirm user data is still visible after trial expiration.
14. Confirm no nags appear on every startup.

---

## Step 19: Developer Notes and Constraints

### Preserve current commands

Do not rename existing commands unless unavoidable.

### Keep backward compatibility

Do not break:

- existing skill launcher
- KDream dashboard
- Doctor
- adapter install
- intelligence commands
- orchestrate commands
- support commands

### Avoid large unrelated refactors

Do not reformat the entire repository.

### Keep changes reviewable

Prefer smaller commits/sections:

1. license type extension
2. feature registry
3. trial service
4. gate service
5. command wrapping
6. docs/tests

### Avoid intrusive telemetry

Do not add telemetry unless explicitly requested.

If basic local metrics are needed, store only local counts in `globalState` or workspace files and disclose them.

### Avoid dark patterns

Do not:

- show modal nags on every startup
- block basic free commands
- hide user-created data
- require credit card for trial
- require account for local trial
- phone home for local verification
- fingerprint aggressively

---

## Final Target User Experience

Fresh install:

```text
Status bar: AutoClaw Free
```

First meaningful use:

```text
AutoClaw Pro trial started: 7 days of full access. No account required.
```

During trial:

```text
Status bar: AutoClaw Trial 7d
All Pro local features work.
```

Trial expired:

```text
AutoClaw Pro trial ended. AutoClaw Free remains active.
```

After trial, when using a paid feature:

```text
PR Evidence Reports are available in AutoClaw Pro.
Generate a basic free summary, compare plans, or enter a license.
```

With paid license:

```text
Status bar: AutoClaw Pro
Commercial features unlocked.
```

With Teams license:

```text
Status bar: AutoClaw Teams
Team features unlocked.
```

---

## Suggested Commit Message

```text
feat(licensing): add trial, feature gates, and edition-ready premium architecture
```

---

## Claude Code Execution Instruction

Work incrementally. First inspect the current repository structure and existing licensing files. Then implement the services and refactors above while preserving current commands. After each major step, run TypeScript compile checks and fix type errors before continuing. Do not remove existing functionality. If a command is too complex to gate safely in the first pass, add a TODO and gate only the easiest commands first, but fully implement the licensing/trial/gate infrastructure.
