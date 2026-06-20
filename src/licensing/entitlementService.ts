// ZIPPY OPEN MATERIAL
//
// Resolves the EFFECTIVE entitlement = the stored license, plus the trial
// overlay, plus BYO-key awareness. Precedence: a valid paid license beats the
// trial; an active trial grants effective Pro (feature access, NOT commercial-use
// rights); otherwise Free (or expired-license → Free).

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
    if (!key) { return FREE_ENTITLEMENT; }
    return verifyLicenseKey(key, LICENSE_PUBLIC_KEY_PEM);
  }

  async getEffectiveEntitlement(): Promise<EffectiveEntitlement> {
    const base = await this.getBaseEntitlement();
    const trialStatus = await this.trial.markConsumedIfExpired();
    const hasByoKey = await this.store.hasByoKey();

    if (isPaid(base)) {
      return {
        base, effectiveTier: base.tier, reason: 'licensed',
        trialActive: trialStatus.active, trialEndsAt: trialStatus.endsAt,
        hasByoKey, commercialUseAllowed: true,
      };
    }

    if (trialStatus.active) {
      return {
        base, effectiveTier: 'pro', reason: 'trial',
        trialActive: true, trialEndsAt: trialStatus.endsAt,
        hasByoKey, commercialUseAllowed: false,
      };
    }

    return {
      base, effectiveTier: 'free',
      reason: base.valid ? 'free' : 'expired-license',
      trialActive: false, trialEndsAt: trialStatus.endsAt,
      hasByoKey, commercialUseAllowed: false,
    };
  }

  async startTrialIfNeeded(reason: string): ReturnType<TrialService['startIfNeeded']> {
    return this.trial.startIfNeeded(reason);
  }

  async hasByoKey(): Promise<boolean> {
    return this.store.hasByoKey();
  }
}
