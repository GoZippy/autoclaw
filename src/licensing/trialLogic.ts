// ZIPPY OPEN MATERIAL
//
// Pure trial state logic — NO `vscode` import, so it unit-tests directly. The
// TrialService is a thin vscode wrapper (globalState + a toast) over these.

export const TRIAL_DAYS = 7;
export const DAY_MS = 24 * 60 * 60 * 1000;

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

/** Compute the user-facing trial status from stored state at time `now`. */
export function computeTrialStatus(state: TrialState, now: number): TrialStatus {
  if (!state.firstMeaningfulUseAt || !state.trialEndsAt) {
    return { active: false, consumed: !!state.trialConsumed, started: false };
  }
  const active = now <= state.trialEndsAt;
  const daysRemaining = active ? Math.max(0, Math.ceil((state.trialEndsAt - now) / DAY_MS)) : 0;
  return {
    active,
    consumed: !!state.trialConsumed || !active,
    started: true,
    startedAt: state.firstMeaningfulUseAt,
    endsAt: state.trialEndsAt,
    daysRemaining,
  };
}

/**
 * Return the next state when the trial should start, or null when it must NOT
 * start (already started, or already consumed — i.e. no restart on reinstall).
 */
export function startedTrialState(state: TrialState, now: number, trialDays = TRIAL_DAYS): TrialState | null {
  if ((state.firstMeaningfulUseAt && state.trialEndsAt) || state.trialConsumed) {
    return null;
  }
  return {
    ...state,
    firstMeaningfulUseAt: now,
    trialEndsAt: now + trialDays * DAY_MS,
    trialConsumed: false,
  };
}

/** Return the next state when an expired trial should be marked consumed, else null. */
export function consumedIfExpiredState(state: TrialState, now: number): TrialState | null {
  if (state.trialEndsAt && now > state.trialEndsAt && !state.trialConsumed) {
    return { ...state, trialConsumed: true };
  }
  return null;
}
