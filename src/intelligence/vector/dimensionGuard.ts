/**
 * vector/dimensionGuard.ts — embedding-signature migration guard for the
 * AutoClaw Intelligence Layer (R3.1-R3.3, risk R-dimension).
 *
 * Switching the embedding model (or its dimension) silently corrupts search:
 * vectors produced by different models share no geometry, so cosine scores
 * across the boundary are meaningless. This module is the gate that prevents
 * that:
 *   - {@link checkSignature} compares the stored `{model, dimension}` against the
 *     active configuration and reports `'ok'` or `'mismatch'`.
 *   - {@link requireForceOnMismatch} blocks a mismatched search with a clear,
 *     actionable error UNLESS the caller passes `force` (the `--force` reindex).
 *   - {@link migrateToNewSignature} reindexes the corpus into a FRESH namespace
 *     under the active signature and only retires the old namespace AFTER the new
 *     one succeeds — so a failed migration never destroys the working index.
 *
 * The reindex + retire steps are injected as callbacks, so this module stays
 * pure/host-free (no `vscode`, no I/O, no native deps) and fully unit-testable.
 */

import { EmbeddingSignature } from '../types';
import { LogFn } from '../config';

// ---------------------------------------------------------------------------
// Signature comparison
// ---------------------------------------------------------------------------

/** Result of {@link checkSignature}. */
export type SignatureCheck = 'ok' | 'mismatch';

/**
 * Compare the `stored` embedding signature (read from the vector store's meta)
 * against the `active` one (from config). Returns `'mismatch'` when EITHER the
 * model id or the dimension differs, `'ok'` otherwise.
 */
export function checkSignature(
  stored: EmbeddingSignature,
  active: EmbeddingSignature,
): SignatureCheck {
  if (stored.model !== active.model || stored.dimension !== active.dimension) {
    return 'mismatch';
  }
  return 'ok';
}

/**
 * A short, stable tag identifying an embedding signature, e.g.
 * `Xenova/nomic-embed-text-v1.5@768`. Used to derive a fresh, collision-free
 * namespace for a migration target.
 */
export function signatureTag(sig: EmbeddingSignature): string {
  return `${sig.model}@${sig.dimension}`;
}

// ---------------------------------------------------------------------------
// Mismatch gate (R3.2)
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link requireForceOnMismatch} when the active embedding signature
 * differs from the stored one and `force` was not supplied. Carries both
 * signatures so the command layer can render precise guidance.
 */
export class SignatureMismatchError extends Error {
  readonly stored: EmbeddingSignature;
  readonly active: EmbeddingSignature;

  constructor(stored: EmbeddingSignature, active: EmbeddingSignature) {
    super(
      `embedding signature changed: the index was built with ` +
        `"${stored.model}" (dim ${stored.dimension}) but the active config uses ` +
        `"${active.model}" (dim ${active.dimension}). Vectors from different ` +
        `models do not compare meaningfully, so search is blocked. Re-run with ` +
        `--force to reindex into a fresh namespace under the new model.`,
    );
    this.name = 'SignatureMismatchError';
    this.stored = stored;
    this.active = active;
  }
}

/**
 * Block a mismatched search unless `force` is set. Returns the {@link
 * SignatureCheck} so callers can branch (`'ok'` ⇒ proceed normally; `'mismatch'`
 * with `force` ⇒ proceed into a migration). Throws {@link SignatureMismatchError}
 * on an unforced mismatch (R3.2).
 */
export function requireForceOnMismatch(
  stored: EmbeddingSignature,
  active: EmbeddingSignature,
  force: boolean,
  log?: LogFn,
): SignatureCheck {
  const result = checkSignature(stored, active);
  if (result === 'mismatch' && !force) {
    throw new SignatureMismatchError(stored, active);
  }
  if (result === 'mismatch' && force) {
    (log ?? (() => undefined))(
      `dimensionGuard: signature mismatch overridden by --force; ` +
        `reindexing from "${stored.model}@${stored.dimension}" to ` +
        `"${active.model}@${active.dimension}"`,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Forced migration (R3.3)
// ---------------------------------------------------------------------------

/**
 * Reindex the corpus that lives under the current namespace into `newNamespace`,
 * embedding it with the `active` signature. MUST resolve with the number of
 * records written. If it rejects, the migration aborts and the old namespace is
 * left untouched (R3.3).
 */
export type ReindexFn = (
  newNamespace: string,
  active: EmbeddingSignature,
) => Promise<number>;

/**
 * Retire the old namespace's vectors. Invoked by {@link migrateToNewSignature}
 * ONLY after {@link ReindexFn} has succeeded. Resolves with the number of
 * records removed. Omit it to keep the old namespace on disk (e.g. for an
 * inspectable rollback window).
 */
export type DropNamespaceFn = (oldNamespace: string) => Promise<number>;

/** Options controlling {@link migrateToNewSignature}. */
export interface MigrateOptions {
  /** Project key whose namespaces are being migrated. */
  projectKey: string;
  /** Signature currently stored in the index. */
  stored: EmbeddingSignature;
  /** Signature the index should be rebuilt under. */
  active: EmbeddingSignature;
  /** Must be `true` to proceed — mirrors the `--force` flag (R3.2/R3.3). */
  force: boolean;
  /** Rebuild the corpus under the new signature. */
  reindex: ReindexFn;
  /** Retire the old namespace AFTER a successful reindex. Optional. */
  dropOld?: DropNamespaceFn;
  /**
   * Derive a namespace for a `(projectKey, signature)` pair. Defaults to
   * {@link defaultNamespaceFor}. Injectable so callers can align the target
   * with their own namespace scheme (e.g. `namespaces.ts`).
   */
  namespaceFor?: (projectKey: string, sig: EmbeddingSignature) => string;
  /** Optional warning sink (logger-injection convention). */
  log?: LogFn;
}

/** Outcome of a {@link migrateToNewSignature} run. */
export interface MigrationResult {
  /** True when a reindex actually ran (false when signatures already matched). */
  migrated: boolean;
  /** Namespace the old vectors lived under. */
  oldNamespace: string;
  /** Namespace the corpus was rebuilt into. */
  newNamespace: string;
  /** Records written into `newNamespace`. */
  reindexed: number;
  /** Records removed from `oldNamespace` (0 when `dropOld` was not supplied). */
  oldDropped: number;
  /** True when the old namespace was retained (no `dropOld` provided). */
  oldKept: boolean;
}

/**
 * Default namespace derivation: append the signature tag to the project key so
 * each `(project, model@dim)` combination occupies a private namespace and a
 * model switch always targets a brand-new one.
 */
export function defaultNamespaceFor(projectKey: string, sig: EmbeddingSignature): string {
  return `${projectKey}::${signatureTag(sig)}`;
}

/**
 * Migrate a project's index from its `stored` signature to the `active` one by
 * reindexing into a FRESH namespace, keeping the old namespace intact until the
 * reindex succeeds (R3.3).
 *
 * Sequence:
 *   1. If the signatures already match → no-op (`migrated: false`); never
 *      touches either namespace.
 *   2. Enforce `force` (throws {@link SignatureMismatchError} otherwise) — a
 *      migration is destructive enough to require the explicit flag.
 *   3. Run {@link ReindexFn} into the NEW namespace. If it rejects, the error
 *      propagates and `dropOld` is NEVER called — the old namespace survives so
 *      the user can retry without data loss.
 *   4. Only after the reindex resolves, optionally retire the old namespace via
 *      {@link DropNamespaceFn}.
 */
export async function migrateToNewSignature(opts: MigrateOptions): Promise<MigrationResult> {
  const warn: LogFn = opts.log ?? (() => undefined);
  const namespaceFor = opts.namespaceFor ?? defaultNamespaceFor;
  const oldNamespace = namespaceFor(opts.projectKey, opts.stored);
  const newNamespace = namespaceFor(opts.projectKey, opts.active);

  // (1) Signatures match — nothing to migrate.
  if (checkSignature(opts.stored, opts.active) === 'ok') {
    return {
      migrated: false,
      oldNamespace,
      newNamespace,
      reindexed: 0,
      oldDropped: 0,
      oldKept: true,
    };
  }

  // (2) A mismatch migration must be explicitly forced.
  requireForceOnMismatch(opts.stored, opts.active, opts.force, warn);

  // (3) Rebuild into the fresh namespace FIRST. A rejection here aborts the
  //     migration with the old namespace fully intact (dropOld not reached).
  const reindexed = await opts.reindex(newNamespace, opts.active);

  // (4) The new namespace is live — only now is it safe to retire the old one.
  let oldDropped = 0;
  let oldKept = true;
  if (opts.dropOld) {
    oldDropped = await opts.dropOld(oldNamespace);
    oldKept = false;
    warn(
      `dimensionGuard: migration complete — reindexed ${reindexed} record(s) into ` +
        `"${newNamespace}" and retired ${oldDropped} from "${oldNamespace}"`,
    );
  } else {
    warn(
      `dimensionGuard: migration complete — reindexed ${reindexed} record(s) into ` +
        `"${newNamespace}"; old namespace "${oldNamespace}" retained`,
    );
  }

  return {
    migrated: true,
    oldNamespace,
    newNamespace,
    reindexed,
    oldDropped,
    oldKept,
  };
}
