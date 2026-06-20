// ZIPPY OPEN MATERIAL
//
// Build edition marker. Lets a future enterprise/customer build flip behavior
// (e.g. swap in a real @autoclaw/premium) without changing the public core.
// Read from AUTOCLAW_EDITION at module load; the published Marketplace VSIX and
// the source-available community build are functionally identical (free + trial
// + paid unlock) and both resolve to 'community' when the env is unset.

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
