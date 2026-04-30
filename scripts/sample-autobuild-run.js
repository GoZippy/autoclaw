// Sample one-shot run for the AutoBuild scheduler — used by the dev sample
// (`npm run sample:autobuild`) to demo `runWorkflow` end-to-end against a
// throwaway temp workspace.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runWorkflow } = require('../out/autobuild.js');

(async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclaw-sample-'));
  const wfDir = path.join(ws, '.autoclaw', 'autobuild', 'workflows');
  fs.mkdirSync(wfDir, { recursive: true });
  const wfPath = path.join(wfDir, 'sample.yaml');
  fs.writeFileSync(wfPath, [
    'name: sample',
    'cron: "* * * * *"',
    'steps:',
    '  - id: greet',
    '    run: echo hello',
    '  - id: noop',
    '    run: node -e "process.exit(0)"',
    ''
  ].join('\n'));

  const runsDir = path.join(ws, '.autoclaw', 'autobuild', 'runs');
  const result = await runWorkflow(wfPath, runsDir);
  console.log('--- result ---');
  console.log(JSON.stringify({
    workflow: result.workflow,
    status: result.status,
    steps: result.steps
  }, null, 2));
  console.log('--- log: ' + result.logPath + ' ---');
  console.log(fs.readFileSync(result.logPath, 'utf8'));
  fs.rmSync(ws, { recursive: true, force: true });
})();
