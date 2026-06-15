// ZIPPY OPEN MATERIAL
//
// Pure scheduling logic for the support prompts — deliberately free of any
// `vscode` import so it can be unit-tested outside the extension host.
// The VS Code glue lives in support.ts.

export interface SupportState {
  /** Epoch-day of first recorded activity. */
  firstUseDay: number | null;
  /** Count of distinct days the extension has been active. */
  activeDays: number;
  /** Epoch-day most recently counted (dedups multiple activations per day). */
  lastActiveDay: number | null;
  /** activeDays value when we last showed a prompt (0 = never). */
  lastPromptAtActiveDay: number;
  /** Total prompts shown. */
  promptsShown: number;
  /** User chose "Don't ask again". */
  dismissedForever: boolean;
  /** User clicked through to post a review. */
  reviewed: boolean;
  /** User clicked through to donate. */
  donated: boolean;
  /** Last in-panel star rating (1-5), if any. */
  rating: number | null;
}

export function defaultState(): SupportState {
  return {
    firstUseDay: null,
    activeDays: 0,
    lastActiveDay: null,
    lastPromptAtActiveDay: 0,
    promptsShown: 0,
    dismissedForever: false,
    reviewed: false,
    donated: false,
    rating: null,
  };
}

const MS_PER_DAY = 86_400_000;

/** Epoch day number (UTC) for a timestamp in ms. */
export function epochDay(nowMs: number): number {
  return Math.floor(nowMs / MS_PER_DAY);
}

/**
 * Count today as an active day if it hasn't been counted yet. Returns a NEW
 * state object (does not mutate). Idempotent within the same calendar day.
 */
export function recordActiveDay(state: SupportState, todayDay: number): SupportState {
  if (state.lastActiveDay === todayDay) return state;
  return {
    ...state,
    firstUseDay: state.firstUseDay ?? todayDay,
    activeDays: state.activeDays + 1,
    lastActiveDay: todayDay,
  };
}

/** Milestone day-counts crossed at or before `activeDays`: 15, 30, 90, 180, ... */
export function milestonesUpTo(activeDays: number): number[] {
  const out: number[] = [];
  for (const m of [15, 30]) {
    if (activeDays >= m) out.push(m);
  }
  for (let m = 90; m <= activeDays; m += 90) {
    out.push(m);
  }
  return out;
}

/**
 * The highest milestone the user has reached but not yet been prompted for, or
 * null if none is due (or prompts are permanently dismissed).
 */
export function dueMilestone(state: SupportState): number | null {
  if (state.dismissedForever) return null;
  const crossed = milestonesUpTo(state.activeDays);
  for (let i = crossed.length - 1; i >= 0; i--) {
    if (crossed[i] > state.lastPromptAtActiveDay) return crossed[i];
  }
  return null;
}

export type AskKind = 'rate' | 'donate' | 'pro';

/**
 * Which ask to lead with at a given milestone. Early milestones solicit a
 * review (cheapest ask, grows the funnel); later ones rotate donate / pro /
 * review, skipping a review ask once the user has already reviewed.
 */
export function askKindFor(milestone: number, state: SupportState): AskKind {
  if (milestone <= 30) {
    return state.reviewed ? 'donate' : 'rate';
  }
  // 90, 180, 270, 360, ... -> donate, pro, rate, donate, ...
  const cycle: AskKind[] = ['donate', 'pro', 'rate'];
  const idx = Math.floor((milestone - 90) / 90) % cycle.length;
  let kind = cycle[idx];
  if (kind === 'rate' && state.reviewed) kind = 'donate';
  return kind;
}
