/**
 * LM Studio adapter.
 *
 * LM Studio serves an OpenAI-compatible `/v1` API on localhost by default.
 * Keeping it as a first-class provider lets the oracle's existing
 * `lmstudio-local` endpoint become an actual runnable pick instead of a
 * recommendation the registry has to skip.
 */

import { OpenAiCompatibleProvider, type OpenAiCompatibleOptions } from './openai-compatible';

const DEFAULT_HOST = 'http://127.0.0.1:1234';

export interface LmStudioOptions {
  /** Bare host without `/v1`; defaults to `LMSTUDIO_HOST` or localhost:1234. */
  host?: string;
  /** Test hook. */
  fetchImpl?: typeof fetch;
  /** Override the adapter id. */
  id?: string;
}

export class LmStudioProvider extends OpenAiCompatibleProvider {
  constructor(opts: LmStudioOptions = {}) {
    const host = stripTrailingSlash(opts.host ?? process.env.LMSTUDIO_HOST ?? DEFAULT_HOST);
    const config: OpenAiCompatibleOptions = {
      id: opts.id ?? 'lmstudio',
      baseUrl: `${host}/v1`,
      auth: { kind: 'none' },
      capabilities: {
        streaming: true,
        toolUse: true,
        jsonMode: true,
        embeddings: true,
        locality: 'local',
        reportsCost: false,
        contextWindow: 8192,
        modelFamilies: [],
      },
      fetchImpl: opts.fetchImpl,
    };
    super(config);
  }
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
