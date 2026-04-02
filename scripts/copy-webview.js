const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src', 'webview');
const outDir = path.join(__dirname, '..', 'out', 'webview');

// Create output directory if it doesn't exist
fs.mkdirSync(outDir, { recursive: true });

// Copy webview CSS and JS files
// NOTE: The HTML template is inline in extension.ts (_getHtmlForWebview method),
// so only CSS and JS files need to be copied here.
const files = ['kdream-dashboard.css', 'kdream-dashboard.js'];
for (const file of files) {
  const src = path.join(srcDir, file);
  const dest = path.join(outDir, file);
  fs.copyFileSync(src, dest);
  console.log(`Copied ${file} to out/webview/`);
}

console.log('Webview files copied successfully.');