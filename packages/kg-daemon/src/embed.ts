/**
 * Embedding client — POSTs to ZippyMesh on :20128 and returns a float
 * vector, or `null` if anything goes wrong. Never throws. The daemon
 * treats missing embeddings as a normal degraded mode (FTS-only).
 */

const DEFAULT_ZMLR = process.env.ZIPPYMESH_URL || "http://localhost:20128";
const EMBED_TIMEOUT_MS = 5_000;

export interface EmbedResult {
  vector: number[] | null;
  reachable: boolean;
}

/**
 * Returns `null` on any failure (network, non-2xx, malformed body,
 * timeout). Callers must tolerate `null` and persist the thought
 * anyway.
 */
export async function embed(
  text: string,
  baseUrl: string = DEFAULT_ZMLR,
): Promise<number[] | null> {
  if (!text || text.length === 0) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT_MS);
  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: text }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as unknown;
    const v = extractVector(body);
    if (!v || v.length === 0) return null;
    return v;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cheap reachability check used by /health. Issues a HEAD/GET to the
 * base URL with a short timeout. Returns `true` only on a 2xx-3xx.
 */
export async function pingZippyMesh(
  baseUrl: string = DEFAULT_ZMLR,
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1_500);
  try {
    const resp = await fetch(baseUrl, { method: "GET", signal: ctrl.signal });
    return resp.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tolerate several plausible response shapes:
 *   - { embedding: number[] }
 *   - { data: [{ embedding: number[] }] }   (OpenAI-ish)
 *   - { vector: number[] }
 *   - number[]
 */
function extractVector(body: unknown): number[] | null {
  if (Array.isArray(body) && body.every((x) => typeof x === "number")) {
    return body as number[];
  }
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    if (Array.isArray(o.embedding) && o.embedding.every((x) => typeof x === "number")) {
      return o.embedding as number[];
    }
    if (Array.isArray(o.vector) && o.vector.every((x) => typeof x === "number")) {
      return o.vector as number[];
    }
    if (Array.isArray(o.data) && o.data[0] && typeof o.data[0] === "object") {
      const inner = (o.data[0] as Record<string, unknown>).embedding;
      if (Array.isArray(inner) && inner.every((x) => typeof x === "number")) {
        return inner as number[];
      }
    }
  }
  return null;
}
