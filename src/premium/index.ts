// ZIPPY OPEN MATERIAL
//
// Premium API entry point. The community build returns the free fallback. A
// future paid build can replace this factory (or alias `@autoclaw/premium`) with
// a real implementation of the same PremiumApi interface — no caller changes.

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
