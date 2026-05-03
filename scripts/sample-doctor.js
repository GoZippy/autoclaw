#!/usr/bin/env node
/**
 * Sample: run runDoctor() against the autoclaw repo itself and print the
 * rendered text + JSON forms. Useful for human-in-the-loop verification of
 * new sections without booting VS Code.
 *
 * Usage:
 *   npm run sample:doctor
 */
const path = require('path');
const { runDoctor, renderReport, renderReportJson } = require('../out/doctor');

async function main() {
  const ext = path.resolve(__dirname, '..');
  const ws = ext;
  const report = await runDoctor(ext, {
    workspaceRoot: ws,
    isExtensionInstalled: () => false,
    isAntigravityHost: false,
    zippymeshUrl: 'http://127.0.0.1:1'
  });
  process.stdout.write(renderReport(report));
  process.stdout.write('\n--- JSON ---\n');
  process.stdout.write(renderReportJson(report).slice(0, 800));
  process.stdout.write('\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
