/**
 * vsixGuard.ts — pure decision logic for the packaging guard.
 *
 * Background: a 680 MB untracked `research/` scratch tree was once packaged into
 * the `.vsix` because `vsce` honours `.vscodeignore` (not `.gitignore`) and the
 * directory had not been excluded. The artifact shipped bloated before anyone
 * noticed. This guard makes that class of mistake fail the build loudly:
 *   1. a coarse SIZE cap (a clean build is ~1.5 MB; CI ~4.5 MB), and
 *   2. a precise CONTAMINATION check for known scratch/never-ship path prefixes.
 *
 * The logic here is intentionally side-effect free (no fs, no zip parsing) so it
 * is unit-testable; the CLI wrapper (`scripts/check-vsix-size.js`) supplies the
 * real size and entry names.
 */

/** Inputs describing a built `.vsix`. */
export interface VsixCheckInput {
  /** Total artifact size in bytes (from `fs.statSync`). */
  sizeBytes: number;
  /**
   * Paths contained in the archive (e.g. `extension/out/extension.js`). The CLI
   * may pass the matched forbidden prefixes directly when it only does a cheap
   * substring scan rather than a full central-directory parse.
   */
  entryNames: string[];
  /** Size ceiling; defaults to {@link DEFAULT_MAX_BYTES}. */
  maxBytes?: number;
  /** Path prefixes that must never appear; defaults to {@link DEFAULT_FORBIDDEN_PREFIXES}. */
  forbiddenPrefixes?: string[];
  /** Sensitive content markers detected inside the archive payload. */
  contentFindings?: string[];
}

/** Verdict from {@link evaluateVsix}. */
export interface VsixCheckResult {
  ok: boolean;
  sizeBytes: number;
  maxBytes: number;
  /** Human-readable failure reasons; empty when `ok`. */
  reasons: string[];
  /** Forbidden prefixes that matched at least one entry. */
  offenders: string[];
  /** Sensitive content findings supplied by the CLI wrapper. */
  contentFindings: string[];
}

/**
 * 20 MB. Comfortably above a legitimate build (~1.5 MB local, ~4.5 MB CI) and
 * catastrophically below a scratch-contaminated artifact (the original scare was
 * 680 MB). Override per-invocation with the `VSIX_MAX_MB` env var in the CLI.
 */
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Path prefixes (as they appear inside the archive, under `extension/`) that are
 * scratch or never-ship content. Keep this focused on real contamination vectors
 * — `research/` is the one that actually shipped.
 */
export const DEFAULT_FORBIDDEN_PREFIXES = [
  'extension/research/',
  'extension/semantic-review/',
  'extension/docs/research/',
  'extension/.git/',
  'extension/node_modules/.cache/',
  'extension/premium-impl/',
  'extension/src/premium-private/',
  'extension/packages/premium/',
  'extension/packages/autoclaw-premium/',
  'extension/node_modules/@autoclaw/premium/',
  'extension/out/node_modules/@autoclaw/premium/',
];

/** Format a byte count as a short human string (e.g. `4.5 MB`). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) { return String(n); }
  if (n < 1024) { return `${n} B`; }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || Number.isInteger(v) ? 0 : 1)} ${units[i]}`;
}

/**
 * Decide whether a built `.vsix` is acceptable to ship. Pure: no I/O.
 * Returns `ok: false` with one reason per violation (over-size and/or
 * contaminated) so the CLI can print all problems at once.
 */
export function evaluateVsix(input: VsixCheckInput): VsixCheckResult {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const forbidden = input.forbiddenPrefixes ?? DEFAULT_FORBIDDEN_PREFIXES;
  const reasons: string[] = [];

  if (input.sizeBytes > maxBytes) {
    reasons.push(
      `.vsix is ${formatBytes(input.sizeBytes)} which exceeds the ${formatBytes(maxBytes)} cap — ` +
      `likely scratch/untracked files leaked in (check .vscodeignore), or raise VSIX_MAX_MB if intentional`
    );
  }

  const offenders = forbidden.filter(p => input.entryNames.some(n => n.startsWith(p)));
  if (offenders.length > 0) {
    reasons.push(
      `.vsix contains scratch/private/never-ship paths: ${offenders.join(', ')} — add them to .vscodeignore or move them to the private build`
    );
  }

  const contentFindings = input.contentFindings ?? [];
  if (contentFindings.length > 0) {
    reasons.push(
      `.vsix contains sensitive content markers: ${contentFindings.join(', ')} — remove secrets/private material before publishing`
    );
  }

  return {
    ok: reasons.length === 0,
    sizeBytes: input.sizeBytes,
    maxBytes,
    reasons,
    offenders,
    contentFindings,
  };
}
