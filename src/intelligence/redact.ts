/**
 * redact.ts — regex-based secret redaction for the Intelligence Layer.
 *
 * Called BEFORE any text is embedded, stored, or logged. Replaces recognised
 * secret patterns with `‹redacted:kind›` tokens so sensitive material never
 * reaches disk/vector/memory.
 *
 * Pure module — no `vscode` import, no I/O, fully unit-testable.
 */

/** The replacement token format: `‹redacted:<kind>›`. */
function tag(kind: string): string {
  return `\u2039redacted:${kind}\u203a`;
}

// --- Pattern definitions ---------------------------------------------------

/**
 * PEM private key blocks (multi-line). Must be checked first because the
 * base64 body would otherwise match the generic-token pattern.
 */
const PEM_RE =
  /-----BEGIN[\w\s]*PRIVATE KEY-----[\s\S]*?-----END[\w\s]*PRIVATE KEY-----/g;

/**
 * Bearer tokens in Authorization headers or standalone `Bearer <token>`.
 * Captures the token value (non-whitespace run after "Bearer ").
 */
const BEARER_RE = /\b(Bearer\s+)\S+/gi;

/**
 * Known API-key prefixes: AWS (`AKIA`), GitHub tokens (`ghp_`, `gho_`,
 * `ghs_`, `ghr_`), OpenAI/Stripe (`sk-`, `pk_live_`, `pk_test_`), etc.
 */
const API_KEY_RE =
  /\b(AKIA[0-9A-Z]{16}|gh[posh]_[A-Za-z0-9_]{36,}|sk-[A-Za-z0-9]{20,}|pk_(live|test)_[A-Za-z0-9]{20,}|xox[bpars]-[A-Za-z0-9\-]{10,})\b/g;

/**
 * `.env`-style lines where the key name suggests a secret: KEY, SECRET, TOKEN,
 * PASSWORD, CREDENTIAL, API, AUTH. Matches the full `KEY=VALUE` (captures
 * everything after `=`, trimming optional quotes).
 */
const ENV_SECRET_RE =
  /^([ \t]*(?:export\s+)?[A-Z_]*(?:SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL|API|AUTH)[A-Z_0-9]*\s*=\s*).+$/gm;

/**
 * Generic long hex/base64 tokens — 40+ alphanumeric characters that are NOT
 * obviously a file path or English text. Word-boundary anchored to avoid
 * splitting identifiers.
 */
const GENERIC_TOKEN_RE = /\b[A-Za-z0-9+/=_\-]{40,}\b/g;

/** Options controlling {@link redactSecrets}. */
export interface RedactOptions {
  /**
   * Skip the catch-all generic long-token pass (rule 5). The targeted secret
   * patterns (PEM, Bearer, known API-key prefixes, `.env` values) still run.
   *
   * Codebase RAG passes this so legitimate 40+ char runs that are NOT
   * secrets — base64 blobs, content hashes, long import URLs, minified vendor
   * lines, integrity strings — survive into the embedding and the stored chunk
   * instead of being blanket-rewritten to `‹redacted:token›`. Real secrets in
   * code are still caught by the targeted prefixes/PEM/Bearer/.env rules.
   *
   * COVERAGE TRADEOFF — this is NOT full secret coverage for code. With this
   * option set, a bare high-entropy literal that does NOT match a targeted
   * pattern (PEM block, `Bearer` header, a known API-key prefix like
   * `AKIA`/`ghp_`/`sk-`, or a secret-named `.env`-style `KEY=VALUE` line) is
   * NOT redacted in code chunks. For example a 50-char credential assigned to a
   * non-secret-named variable survives into the embedding/stored chunk. This is
   * a deliberate retrieval-quality tradeoff for code; do not mistake it for
   * complete secret redaction. The default (non-code) path keeps rule 5 on and
   * therefore catches such literals.
   */
  skipGenericToken?: boolean;
}

// --- Public API ------------------------------------------------------------

/**
 * Redact recognised secrets from `text`, returning a copy with sensitive spans
 * replaced by `‹redacted:kind›` markers.
 *
 * Patterns are applied in order of specificity:
 * 1. PEM private-key blocks → `‹redacted:private-key›`
 * 2. Bearer tokens → `‹redacted:bearer›`
 * 3. Known API-key prefixes → `‹redacted:api-key›`
 * 4. `.env`-style secret lines → `‹redacted:env-secret›`
 * 5. Generic long tokens → `‹redacted:token›` (skippable via
 *    {@link RedactOptions.skipGenericToken})
 */
export function redactSecrets(text: string, options?: RedactOptions): string {
  // 1. PEM blocks
  let result = text.replace(PEM_RE, tag('private-key'));

  // 2. Bearer tokens (preserve the "Bearer " prefix for readability)
  result = result.replace(BEARER_RE, `$1${tag('bearer')}`);

  // 3. Known API-key prefixes
  result = result.replace(API_KEY_RE, tag('api-key'));

  // 4. .env-style secret lines (keep the key name, redact value)
  result = result.replace(ENV_SECRET_RE, `$1${tag('env-secret')}`);

  // 5. Generic long tokens (only if not already redacted by earlier passes).
  //    Skipped for code-RAG chunks, which routinely contain benign long runs.
  if (!options?.skipGenericToken) {
    result = result.replace(GENERIC_TOKEN_RE, (match) => {
      // Skip if it was already replaced (contains the redaction marker)
      if (match.includes('\u2039redacted:')) {
        return match;
      }
      return tag('token');
    });
  }

  return result;
}
