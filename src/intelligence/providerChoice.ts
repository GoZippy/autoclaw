/**
 * providerChoice.ts — the PURE decision logic behind the "Set Embedding
 * Provider" picker. Kept vscode-free so it is unit-testable: given a live
 * probe of each rung, it builds the annotated, self-explaining option list and
 * marks exactly ONE rung as recommended.
 *
 * The command layer (`runSetEmbeddingProvider`) runs the real detectors, fills
 * a {@link ProviderProbe}, calls {@link buildProviderOptions}, then maps the
 * result onto vscode QuickPickItems. None of that vscode glue lives here.
 *
 * Recommendation order (best AVAILABLE rung wins):
 *   1. router      — a reachable service means one geometry across every tool
 *                    and machine (team/fleet), so it edges out local Ollama.
 *   2. ollama      — best private quality, free, fully local (solo dev) — but
 *                    only when an embedding model is actually pulled.
 *   3. transformers — installed offline peer; airgap-friendly, no service.
 *   4. none        — keyword-only fallback; recommended only as a last resort.
 */

/** Live reachability of each rung, as captured by the command's parallel probe. */
export interface ProviderProbe {
  router: { reachable: boolean };
  ollama: { reachable: boolean; embedModel?: string };
  transformers: { installed: boolean };
}

/** One annotated picker row: a live status glyph + a "why pick this" reason. */
export interface ProviderOption {
  id: 'auto' | 'router' | 'ollama' | 'transformers' | 'none';
  label: string; // human label, prefixed with "★ " when recommended
  description: string; // live status glyph + reason
  recommended: boolean;
}

/**
 * Decide which rung to recommend from a probe. Returns the winning id, or
 * `'none'` when nothing real is available. Mirrors the order documented above:
 * a reachable router wins, then a usable Ollama (running WITH an embed model),
 * then an installed transformers peer.
 */
function recommendedId(probe: ProviderProbe): ProviderOption['id'] {
  if (probe.router.reachable) {
    return 'router';
  }
  if (probe.ollama.reachable && probe.ollama.embedModel) {
    return 'ollama';
  }
  if (probe.transformers.installed) {
    return 'transformers';
  }
  return 'none';
}

/** Live status + reason for the Ollama rung. */
function ollamaDescription(o: ProviderProbe['ollama']): string {
  if (o.reachable && o.embedModel) {
    return `✓ ${o.embedModel} ready — best private quality, free, fully local`;
  }
  if (o.reachable) {
    return '⚠ running, no embed model — run `ollama pull nomic-embed-text`';
  }
  return '✗ not running — best private quality, free, fully local once started';
}

/** Live status + reason for the router rung. */
function routerDescription(r: ProviderProbe['router']): string {
  const why = 'best for teams/fleets: one service → identical geometry across every tool & machine';
  return r.reachable ? `✓ reachable — ${why}` : `✗ not running — ${why}`;
}

/** Live status + reason for the offline transformers rung. */
function transformersDescription(t: ProviderProbe['transformers']): string {
  const why = 'zero services, airgap-friendly; slower CPU embed';
  return t.installed
    ? `✓ installed — ${why}`
    : `not installed (~135 MB) — ${why}`;
}

/**
 * Build the annotated, ordered picker options from a live probe. Exactly one
 * option carries `recommended: true` (the best available rung per the order
 * above); its label is prefixed with "★ ". `auto` stays an explicit option and
 * is never the auto-recommendation (the user opts into detection deliberately).
 *
 * @param probe   live reachability of router/ollama/transformers
 * @param current the current provider id (for a "(current)" hint), e.g. "auto"
 */
export function buildProviderOptions(probe: ProviderProbe, current: string): ProviderOption[] {
  const winner = recommendedId(probe);
  const currentId = current.split(' ')[0]; // tolerate "auto" or "ollama (model, 768-dim)"

  const rows: Array<Omit<ProviderOption, 'recommended' | 'label'> & { baseLabel: string }> = [
    {
      id: 'router',
      baseLabel: 'Zippy Mesh router',
      description: routerDescription(probe.router),
    },
    {
      id: 'ollama',
      baseLabel: 'Ollama (local)',
      description: ollamaDescription(probe.ollama),
    },
    {
      id: 'transformers',
      baseLabel: 'Offline (transformers)',
      description: transformersDescription(probe.transformers),
    },
    {
      id: 'none',
      baseLabel: "Basic ('none')",
      description: 'always works — keyword-only, degraded recall, temporary only',
    },
    {
      id: 'auto',
      baseLabel: 'Auto-detect',
      description: 'probe Router → Ollama → offline → basic and pin the best',
    },
  ];

  return rows.map((row) => {
    const recommended = row.id === winner;
    const currentSuffix = row.id === currentId ? ' (current)' : '';
    const label = `${recommended ? '★ ' : ''}${row.baseLabel}${currentSuffix}`;
    return { id: row.id, label, description: row.description, recommended };
  });
}
