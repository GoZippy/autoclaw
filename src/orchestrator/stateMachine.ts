export enum SprintStatus {
  pending    = 'pending',
  assigned   = 'assigned',
  in_progress = 'in_progress',
  review     = 'review',
  approved   = 'approved',
  merged     = 'merged',
}

const ALLOWED_TRANSITIONS: ReadonlyMap<SprintStatus, readonly SprintStatus[]> = new Map([
  [SprintStatus.pending,     [SprintStatus.assigned]],
  [SprintStatus.assigned,    [SprintStatus.in_progress]],
  [SprintStatus.in_progress, [SprintStatus.review]],
  [SprintStatus.review,      [SprintStatus.approved]],
  [SprintStatus.approved,    [SprintStatus.merged]],
  [SprintStatus.merged,      []],
]);

export class StateMachine {
  private statuses: Map<number, SprintStatus>;

  constructor(initial: Record<number, SprintStatus> = {}) {
    this.statuses = new Map(Object.entries(initial).map(([k, v]) => [Number(k), v as SprintStatus]));
  }

  get(sprint: number): SprintStatus | undefined {
    return this.statuses.get(sprint);
  }

  set(sprint: number, status: SprintStatus): void {
    this.statuses.set(sprint, status);
  }

  transition(sprint: number, next: SprintStatus): void {
    const current = this.statuses.get(sprint);
    if (current === undefined) {
      throw new Error(`Sprint ${sprint} not registered in state machine`);
    }
    const allowed: readonly SprintStatus[] = ALLOWED_TRANSITIONS.get(current) ?? [];
    if (!allowed.includes(next)) {
      throw new Error(
        `Invalid transition for sprint ${sprint}: ${current} → ${next}. ` +
        `Allowed from ${current}: [${allowed.join(', ')}]`
      );
    }
    this.statuses.set(sprint, next);
  }

  canTransition(sprint: number, next: SprintStatus): boolean {
    const current = this.statuses.get(sprint);
    if (current === undefined) { return false; }
    const allowed: readonly SprintStatus[] = ALLOWED_TRANSITIONS.get(current) ?? [];
    return allowed.includes(next);
  }

  snapshot(): Record<number, SprintStatus> {
    const out: Record<number, SprintStatus> = {};
    for (const [k, v] of this.statuses) { out[k] = v; }
    return out;
  }
}
