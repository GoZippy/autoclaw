import { defineConfig } from '@vscode/test-cli';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheRoot = path.join(here, '.vscode-test', 'integration');

export default defineConfig({
  files: 'out/test/**/*.test.js',
  version: 'insiders',
  extensions: [],
  launchArgs: [
    '--no-sandbox',
    `--user-data-dir=${path.join(cacheRoot, 'user-data')}`,
    `--extensions-dir=${path.join(cacheRoot, 'extensions')}`,
    '--disable-extensions',
    '--disable-workspace-trust'
  ],
  mocha: {
    ui: 'tdd',
    timeout: 60000
  }
});
