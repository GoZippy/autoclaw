// Dev-only helper: build a sample snapshot from a synthetic fixture and print
// it to stdout. Used to spot-check the snapshot format without needing a real
// VS Code host. Not invoked by `npm test` or `npm run adapters:check`.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildSnapshot } = require('../out/snapshot');
const { getTodayLogPath } = require('../out/kdream-helpers');

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-snap-'));
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-ext-'));
  fs.writeFileSync(
    path.join(ext, 'package.json'),
    JSON.stringify({ name: 'autoclaw', version: '1.2.5' })
  );

  const k = path.join(ws, '.autoclaw', 'kdream');
  fs.mkdirSync(k, { recursive: true });
  fs.writeFileSync(
    path.join(k, 'state.json'),
    JSON.stringify(
      {
        status: 'running',
        tick: 7,
        started: '2026-04-29T08:00:00Z',
        lastDream: '2026-04-29T09:30:00Z'
      },
      null,
      2
    )
  );

  fs.mkdirSync(path.join(k, 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(k, 'memory', 'MEMORY.md'),
    '# KDream Memory\n\n## Follow-ups\n- [ ] Task A\n- [ ] Task B\n- [x] Done\n'
  );

  fs.mkdirSync(path.join(k, 'logs'), { recursive: true });
  fs.writeFileSync(
    getTodayLogPath(ws),
    '## sample\n- entry 1\n- entry 2\n- entry 3\n- entry 4\n- entry 5\n'
  );

  const snap = await buildSnapshot(ws, ext, {
    workspaceRoot: ws,
    isExtensionInstalled: () => false,
    zippymeshUrl: 'http://127.0.0.1:1'
  });
  process.stdout.write(snap);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
