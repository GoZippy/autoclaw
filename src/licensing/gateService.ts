// ZIPPY OPEN MATERIAL
//
// The one place feature access is decided. `check()` is pure-ish (resolves the
// effective entitlement, no UI); `require()` adds a single polite upgrade/fallback
// prompt on denial. Client-side gate = UX/compliance, NOT DRM — see the refactor
// spec rules. Free features always pass; paid features pass during the trial.

import * as vscode from 'vscode';
import { FEATURE_DEFINITIONS, FeatureId } from './features';
import { EntitlementService } from './entitlementService';
import { LicenseTier } from './license';
import { decideGate, type GateReason } from './gateLogic';

/**
 * Whether tiered feature-gate ENFORCEMENT is on. Default **false** — the gates
 * are built but dormant until the maintainer enables enforcement (which should
 * only happen once a real purchase path exists). This is a maintainer/product
 * flag, not an end-user setting, so it is NOT shown in the Settings UI — flip it
 * with the hidden `autoclaw.licensing.enforceGates` key in settings.json.
 */
export function gateEnforcementEnabled(): boolean {
  try {
    return vscode.workspace.getConfiguration('autoclaw').get<boolean>('licensing.enforceGates', false) === true;
  } catch {
    return false;
  }
}

export interface GateOptions {
  /** Start the trial (if eligible + the feature allows it) before checking. */
  startTrial?: boolean;
  reason?: string;
  /** Don't show the upgrade/fallback prompt on denial. */
  silent?: boolean;
  /** For hosted-cost features, allow a BYO API key to satisfy the gate. */
  allowByoForHosted?: boolean;
}

export interface GateResult {
  allowed: boolean;
  feature: FeatureId;
  label: string;
  effectiveTier: LicenseTier;
  reason: GateReason;
  fallbackFeature?: FeatureId;
}

export class GateService {
  private readonly entitlements: EntitlementService;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.entitlements = new EntitlementService(context);
  }

  async check(feature: FeatureId, options: GateOptions = {}): Promise<GateResult> {
    const def = FEATURE_DEFINITIONS[feature];
    if (!def) { throw new Error(`Unknown AutoClaw feature: ${feature}`); }

    // Monetization master switch. Gates are BUILT but DORMANT until the maintainer
    // turns enforcement on (which should only happen once a real purchase path
    // exists). Default OFF → every feature is allowed, so shipping the gates can
    // never strand a user behind an upgrade prompt with nowhere to buy.
    if (!gateEnforcementEnabled()) {
      return { allowed: true, feature, label: def.label, effectiveTier: 'free', reason: 'free' };
    }

    if (options.startTrial && def.trialAllowed) {
      await this.entitlements.startTrialIfNeeded(options.reason ?? def.label);
    }

    const effective = await this.entitlements.getEffectiveEntitlement();
    const decision = decideGate(def, {
      effectiveTier: effective.effectiveTier,
      reason: effective.reason,
      hasByoKey: effective.hasByoKey,
      trialEndsAt: effective.trialEndsAt,
    }, { allowByoForHosted: options.allowByoForHosted });

    return {
      allowed: decision.allowed,
      feature,
      label: def.label,
      effectiveTier: effective.effectiveTier,
      reason: decision.reason,
      fallbackFeature: decision.fallbackFeature,
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
    const actions: string[] = ['Compare Plans', 'Enter License'];
    if (result.fallbackFeature) { actions.unshift('Use Free Fallback'); }
    actions.push('Not Now');

    const choice = await vscode.window.showInformationMessage(
      `${def.label} is available in AutoClaw ${def.minimumTier.toUpperCase()} or during the 7-day Pro trial. AutoClaw Free remains active.`,
      ...actions,
    );

    if (choice === 'Compare Plans') {
      await vscode.commands.executeCommand('autoclaw.license.comparePlans');
    } else if (choice === 'Enter License') {
      await vscode.commands.executeCommand('autoclaw.license.enter');
    }
  }
}
