// ZIPPY OPEN MATERIAL
//
// The always-available "Support AutoClaw" panel. Opened on demand via the
// `autoclaw.support.open` command — it never nags on its own. Shows in-panel
// star rating, marketplace review hand-off, donation (Square), crypto wallets,
// and commercial-license plans. All payment endpoints come from supportConfig
// and are placeholders until the maintainer fills them in.

import * as vscode from 'vscode';
import {
  getSupportLinks,
  isPlaceholder,
  detectMarketplace,
  reviewUrlFor,
  SupportLinks,
} from './supportConfig';
import { loadState, saveState } from './support';

let panel: vscode.WebviewPanel | undefined;

export function showSupportPanel(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'autoclaw.support',
    'Support AutoClaw',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  const links = getSupportLinks();
  panel.webview.html = renderHtml(panel.webview, links);

  panel.webview.onDidReceiveMessage(async (msg: { type: string; [k: string]: unknown }) => {
    switch (msg.type) {
      case 'openExternal':
        if (typeof msg.url === 'string') {
          await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
        break;
      case 'copy':
        if (typeof msg.text === 'string') {
          await vscode.env.clipboard.writeText(msg.text);
          vscode.window.showInformationMessage('Copied to clipboard.');
        }
        break;
      case 'rate': {
        const stars = Number(msg.stars) || 0;
        const state = loadState(context);
        const market = detectMarketplace(vscode.env.appName || '');
        if (stars >= 4) {
          // Happy → public review.
          await vscode.env.openExternal(vscode.Uri.parse(reviewUrlFor(links, market)));
          await saveState(context, { ...state, rating: stars, reviewed: true });
        } else {
          // Unhappy → private feedback, protects the public rating.
          await vscode.env.openExternal(vscode.Uri.parse(links.feedbackUrl));
          await saveState(context, { ...state, rating: stars });
        }
        break;
      }
      case 'donated': {
        const state = loadState(context);
        await saveState(context, { ...state, donated: true });
        break;
      }
    }
  }, undefined, context.subscriptions);

  panel.onDidDispose(() => { panel = undefined; }, undefined, context.subscriptions);
}

function nonce(): string {
  // Static-ish nonce is fine here: the webview content is fully trusted/local.
  return 'autoclaw' + 'support' + 'panel';
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string),
  );
}

/** A link button, or a muted "not set yet" note when the URL is a placeholder. */
function linkButton(label: string, url: string, kind = 'btn'): string {
  if (isPlaceholder(url)) {
    return `<span class="muted" title="The maintainer hasn't set this link yet">${esc(label)} — coming soon</span>`;
  }
  return `<button class="${kind}" data-open="${esc(url)}">${esc(label)}</button>`;
}

function walletRows(wallets: Record<string, string>): string {
  const entries = Object.entries(wallets);
  if (!entries.length) return '<p class="muted">No wallets configured.</p>';
  return entries
    .map(([sym, addr]) => {
      if (isPlaceholder(addr)) {
        return `<div class="wallet"><span class="sym">${esc(sym)}</span><span class="muted">coming soon</span></div>`;
      }
      return `<div class="wallet"><span class="sym">${esc(sym)}</span><code>${esc(addr)}</code><button class="mini" data-copy="${esc(addr)}">Copy</button></div>`;
    })
    .join('\n');
}

function renderHtml(webview: vscode.Webview, links: SupportLinks): string {
  const n = nonce();
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${n}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 18px 22px; line-height: 1.5; }
  h1 { font-size: 1.4em; margin: 0 0 4px; }
  h2 { font-size: 1.05em; margin: 22px 0 8px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
  p { margin: 6px 0; }
  .lead { color: var(--vscode-descriptionForeground); }
  .muted { color: var(--vscode-descriptionForeground); font-style: italic; }
  button { font-family: inherit; cursor: pointer; border: none; border-radius: 4px; }
  .btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 7px 14px; margin: 4px 6px 4px 0; }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .mini { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 2px 8px; margin-left: 8px; font-size: 0.85em; }
  .stars { font-size: 1.9em; user-select: none; }
  .star { cursor: pointer; opacity: 0.45; transition: opacity .1s; }
  .star.on, .star:hover { opacity: 1; }
  .wallet { display: flex; align-items: center; gap: 6px; margin: 5px 0; flex-wrap: wrap; }
  .wallet .sym { font-weight: 600; min-width: 52px; }
  code { background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 3px; font-size: 0.9em; word-break: break-all; }
  table { border-collapse: collapse; margin: 8px 0; }
  td, th { text-align: left; padding: 4px 14px 4px 0; }
  .heart { color: #e25555; }
</style>
</head>
<body>
  <h1>Support AutoClaw <span class="heart">&#10084;</span></h1>
  <p class="lead">AutoClaw is free for personal &amp; educational use, forever. It's built by a tiny team — your support decides whether it becomes a full-time project. All of this is optional.</p>

  <h2>&#11088; Rate it (free, helps the most)</h2>
  <p>Tap a rating. 4&ndash;5 stars opens the marketplace review page; fewer opens a quick private feedback form so we can fix things.</p>
  <div class="stars" id="stars">
    <span class="star" data-n="1">&#9733;</span><span class="star" data-n="2">&#9733;</span><span class="star" data-n="3">&#9733;</span><span class="star" data-n="4">&#9733;</span><span class="star" data-n="5">&#9733;</span>
  </div>
  <p>
    ${linkButton('Review on VS Code Marketplace', links.reviewVscode, 'btn secondary')}
    ${linkButton('Review on Open VSX', links.reviewOpenVsx, 'btn secondary')}
  </p>

  <h2>&#9749; Donate</h2>
  <p>One-time, goes straight to keeping the lights on and the work going.</p>
  <p>
    ${linkButton('Support on Ko-fi ☕', links.koFiUrl, 'btn')}
    ${linkButton('Donate $10', links.donationUrl, 'btn secondary')}
    ${linkButton('Custom amount', links.customAmountUrl, 'btn secondary')}
  </p>
  <h3 style="font-size:.95em;margin:14px 0 4px;">Crypto</h3>
  ${walletRows(links.cryptoWallets)}

  <h2>&#128188; Using AutoClaw at work?</h2>
  <p>Personal use is free. Commercial use requires a paid license — it keeps you compliant and directly funds development.</p>
  <table>
    <tr><th>Tier</th><th>Seats</th><th>Price</th></tr>
    <tr><td>Pro</td><td>1</td><td>$15/mo or $150/yr</td></tr>
    <tr><td>Teams</td><td>up to 5</td><td>$25/seat/mo or $250/seat/yr</td></tr>
    <tr><td>Enterprise</td><td>unlimited</td><td>Custom</td></tr>
  </table>
  <p>
    ${linkButton('Get a commercial license', links.proUrl, 'btn')}
    <button class="btn secondary" data-open="mailto:${esc(links.contactEmail)}?subject=AutoClaw%20commercial%20license">Contact ${esc(links.contactEmail)}</button>
  </p>

  <p class="muted" style="margin-top:24px;">Thank you. Every review and every dollar genuinely helps. 🙏</p>

<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('[data-open]').forEach(el => {
    el.addEventListener('click', () => vscode.postMessage({ type: 'openExternal', url: el.getAttribute('data-open') }));
  });
  document.querySelectorAll('[data-copy]').forEach(el => {
    el.addEventListener('click', () => vscode.postMessage({ type: 'copy', text: el.getAttribute('data-copy') }));
  });
  const stars = Array.from(document.querySelectorAll('#stars .star'));
  function paint(n) { stars.forEach(s => s.classList.toggle('on', Number(s.getAttribute('data-n')) <= n)); }
  stars.forEach(s => {
    const n = Number(s.getAttribute('data-n'));
    s.addEventListener('mouseenter', () => paint(n));
    s.addEventListener('click', () => { paint(n); vscode.postMessage({ type: 'rate', stars: n }); });
  });
  document.getElementById('stars').addEventListener('mouseleave', () => paint(0));
</script>
</body>
</html>`;
}
