import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createProgram, joinProgram, leaveProgram, listPrograms,
  readRegistry, readProgramLink, touchParticipant, fanInCommsLog,
  programsRoot, registryPath, linkPath, programDir,
} from '../program-plane';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-test-'));
}

suite('Program-Plane Registry', () => {

  test('createProgram writes registry.json with correct schema', async () => {
    const home = makeTmpDir();
    const reg = await createProgram({ programName: 'My Test Program', homeDir: home });
    assert.strictEqual(reg.schema_version, '1.0');
    assert.ok(reg.program_id.startsWith('prog_'));
    assert.strictEqual(reg.program_name, 'My Test Program');
    assert.strictEqual(reg.bus_driver, 'fs');
    assert.deepStrictEqual(reg.participants, []);

    const onDisk = await readRegistry(home, reg.program_id);
    assert.strictEqual(onDisk.program_id, reg.program_id);
    assert.strictEqual(onDisk.program_name, 'My Test Program');
  });

  test('createProgram respects busDriver and kgDaemonUrl opts', async () => {
    const home = makeTmpDir();
    const reg = await createProgram({
      programName: 'NATS Stack',
      homeDir: home,
      busDriver: 'nats',
      kgDaemonUrl: 'http://127.0.0.1:21128',
    });
    assert.strictEqual(reg.bus_driver, 'nats');
    assert.strictEqual(reg.kg_daemon_url, 'http://127.0.0.1:21128');
  });

  test('listPrograms returns all programs sorted by name', async () => {
    const home = makeTmpDir();
    await createProgram({ programName: 'Zebra', homeDir: home });
    await createProgram({ programName: 'Alpha', homeDir: home });
    const list = await listPrograms(home);
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].program_name, 'Alpha');
    assert.strictEqual(list[1].program_name, 'Zebra');
  });

  test('listPrograms returns empty array when programs dir absent', async () => {
    const home = makeTmpDir();
    const list = await listPrograms(home);
    assert.deepStrictEqual(list, []);
  });

  test('joinProgram adds participant and writes program-link.json', async () => {
    const home = makeTmpDir();
    const repo = makeTmpDir();
    const reg = await createProgram({ programName: 'Test', homeDir: home });

    const updated = await joinProgram({ programId: reg.program_id, repoPath: repo, homeDir: home });
    assert.strictEqual(updated.participants.length, 1);
    assert.strictEqual(updated.participants[0].repo_path, repo);
    assert.strictEqual(updated.participants[0].role, 'orchestrator');

    const link = await readProgramLink(repo);
    assert.ok(link);
    assert.strictEqual(link!.program_id, reg.program_id);
  });

  test('joinProgram with role=observer stores correct role', async () => {
    const home = makeTmpDir();
    const repo = makeTmpDir();
    const reg = await createProgram({ programName: 'Test', homeDir: home });
    const updated = await joinProgram({ programId: reg.program_id, repoPath: repo, homeDir: home, role: 'observer' });
    assert.strictEqual(updated.participants[0].role, 'observer');
  });

  test('joinProgram a second time updates last_seen without duplicating', async () => {
    const home = makeTmpDir();
    const repo = makeTmpDir();
    const reg = await createProgram({ programName: 'Test', homeDir: home });
    await joinProgram({ programId: reg.program_id, repoPath: repo, homeDir: home });
    const updated = await joinProgram({ programId: reg.program_id, repoPath: repo, homeDir: home });
    assert.strictEqual(updated.participants.length, 1);
  });

  test('leaveProgram removes participant and deletes program-link.json', async () => {
    const home = makeTmpDir();
    const repo = makeTmpDir();
    const reg = await createProgram({ programName: 'Test', homeDir: home });
    await joinProgram({ programId: reg.program_id, repoPath: repo, homeDir: home });
    await leaveProgram(repo, home);
    const after = await readRegistry(home, reg.program_id);
    assert.strictEqual(after.participants.length, 0);
    const link = await readProgramLink(repo);
    assert.strictEqual(link, null);
  });

  test('leaveProgram is a no-op when no link exists', async () => {
    const home = makeTmpDir();
    const repo = makeTmpDir();
    await assert.doesNotReject(() => leaveProgram(repo, home));
  });

  test('touchParticipant updates last_seen in registry', async () => {
    const home = makeTmpDir();
    const repo = makeTmpDir();
    const reg = await createProgram({ programName: 'Test', homeDir: home });
    await joinProgram({ programId: reg.program_id, repoPath: repo, homeDir: home });
    const before = (await readRegistry(home, reg.program_id)).participants[0].last_seen;
    await new Promise(r => setTimeout(r, 10)); // ensure time passes
    await touchParticipant(repo, home);
    const after = (await readRegistry(home, reg.program_id)).participants[0].last_seen;
    assert.ok(after >= before, 'last_seen should be updated');
  });

  test('touchParticipant is a no-op when no link exists', async () => {
    const home = makeTmpDir();
    const repo = makeTmpDir();
    await assert.doesNotReject(() => touchParticipant(repo, home));
  });

  test('fanInCommsLog merges entries from participants with _repo field', async () => {
    const home = makeTmpDir();
    const repo = makeTmpDir();
    const reg = await createProgram({ programName: 'Test', homeDir: home });
    await joinProgram({ programId: reg.program_id, repoPath: repo, homeDir: home });

    const logDir = path.join(repo, '.autoclaw', 'orchestrator');
    fs.mkdirSync(logDir, { recursive: true });
    const entry = { timestamp: '2026-05-16T00:00:00Z', type: 'task_complete', from: 'kiro', to: 'shared', message: 'done' };
    fs.writeFileSync(path.join(logDir, 'comms-log.jsonl'), JSON.stringify(entry) + '\n');

    const added = await fanInCommsLog(reg.program_id, home);
    assert.strictEqual(added, 1);

    const merged = fs.readFileSync(path.join(programDir(home, reg.program_id), 'comms-log.jsonl'), 'utf8');
    const parsed = JSON.parse(merged.trim());
    assert.strictEqual(parsed._repo, repo);
    assert.strictEqual(parsed.type, 'task_complete');
  });

  test('fanInCommsLog is idempotent — does not re-append already-read lines', async () => {
    const home = makeTmpDir();
    const repo = makeTmpDir();
    const reg = await createProgram({ programName: 'Test', homeDir: home });
    await joinProgram({ programId: reg.program_id, repoPath: repo, homeDir: home });
    const logDir = path.join(repo, '.autoclaw', 'orchestrator');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'comms-log.jsonl'), JSON.stringify({ type: 'ping' }) + '\n');

    await fanInCommsLog(reg.program_id, home);
    const count2 = await fanInCommsLog(reg.program_id, home);
    assert.strictEqual(count2, 0, 'second run should add 0 lines');
  });

  test('fanInCommsLog returns 0 for program with no log files', async () => {
    const home = makeTmpDir();
    const reg = await createProgram({ programName: 'Test', homeDir: home });
    const count = await fanInCommsLog(reg.program_id, home);
    assert.strictEqual(count, 0);
  });
});
