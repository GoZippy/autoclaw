/**
 * auth.ts — bearer-token → account resolution for the relay server (AF-10).
 *
 * Self-host model: a token maps to an account, and an account is the set of a
 * user's machines that can exchange messages. Define tokens in the server
 * config (a JSON file or env). The HOSTED variant swaps this for a real
 * subscription lookup per docs/specs/relay-entitlement.spec.md — same seam.
 */

export interface RelayServerConfig {
  /** token → accountId. Every machine that shares an account uses one of its tokens. */
  tokens: Record<string, string>;
  /** Where the file store lives. */
  dataDir: string;
  /** Listen port (default 8787). */
  port: number;
}

/** Resolve the account for an `Authorization: Bearer <token>` header, or null. */
export function resolveAccount(authHeader: string | undefined, tokens: Record<string, string>): string | null {
  if (!authHeader) { return null; }
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!m) { return null; }
  const account = tokens[m[1].trim()];
  return account ?? null;
}

/**
 * Build a config from env + an optional JSON file. Env wins. Tokens come from
 * `AUTOCLAW_RELAY_TOKENS` as `token1:account1,token2:account2`, or the file's
 * `tokens` map.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv,
  fileJson?: Partial<RelayServerConfig> | null,
): RelayServerConfig {
  const tokens: Record<string, string> = { ...(fileJson?.tokens ?? {}) };
  const envTokens = (env.AUTOCLAW_RELAY_TOKENS ?? '').trim();
  if (envTokens) {
    for (const pair of envTokens.split(',')) {
      const [tok, acct] = pair.split(':').map(s => s.trim());
      if (tok && acct) { tokens[tok] = acct; }
    }
  }
  return {
    tokens,
    dataDir: env.AUTOCLAW_RELAY_DATA_DIR?.trim() || fileJson?.dataDir || './relay-data',
    port: Number(env.AUTOCLAW_RELAY_PORT) || fileJson?.port || 8787,
  };
}
