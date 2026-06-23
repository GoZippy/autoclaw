// ZIPPY OPEN MATERIAL
//
// Premium API entry point. The real engines live in the PRIVATE `@autoclaw/premium`
// package, which is present ONLY in licensed/enterprise builds. We load it
// optionally at runtime: when present, the real implementation runs (gated by
// license/trial); when absent — the public/community build, or any contributor
// without access — we fall back to the free implementation so the app always
// builds and runs. No private code is in this public repo; only this seam.

import type { PremiumApi, PremiumApiFactoryContext } from './premiumApi';
import { createUnavailablePremiumApi } from './unavailablePremium';

/** True once a real premium engine has been loaded (vs. the free fallback). */
let premiumLoaded = false;

export function isPremiumImplementationPresent(): boolean {
  return premiumLoaded;
}

export function createPremiumApi(ctx: PremiumApiFactoryContext): PremiumApi {
  try {
    // Indirect (variable) require so tsc does NOT statically resolve an optional
    // module that isn't installed in the public build. Present only when the
    // maintainer's licensed build has installed @autoclaw/premium.
    const moduleName = '@autoclaw/premium';
    const req: NodeRequire = require;
    const mod = req(moduleName) as { createPremiumApi?: (c: PremiumApiFactoryContext) => PremiumApi };
    if (mod && typeof mod.createPremiumApi === 'function') {
      premiumLoaded = true;
      return mod.createPremiumApi(ctx);
    }
  } catch {
    // Not installed → free fallback (the expected path in the public build).
  }
  premiumLoaded = false;
  return createUnavailablePremiumApi(ctx);
}

export type {
  PremiumApi,
  PremiumApiFactoryContext,
  PrEvidenceReport,
  PrEvidenceReportInput,
  AdvancedOrchestrationInput,
  AdvancedOrchestrationResult,
  AdvancedOrchestrationTask,
  AdvancedOrchestrationAgent,
  AdvancedOrchestrationAssignment,
} from './premiumApi';
