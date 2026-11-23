import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
const runIn = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });

test('help identifies AIPowers as a coding-agent development system', () => {
  const r = run('help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Original AI Coding Agent Development System/);
  assert.match(r.stdout, /skills activate/);
  assert.match(r.stdout, /memory set/);
  assert.match(r.stdout, /memory prune/);
  assert.match(r.stdout, /verify <test\|check>/);
  assert.match(r.stdout, /workflow run-codex/);
  assert.match(r.stdout, /workflow run <provider>/);
  assert.match(r.stdout, /workflow run-ready/);
  assert.match(r.stdout, /workflow recover/);
  assert.match(r.stdout, /workflow audit/);
  assert.match(r.stdout, /workflow restore/);
  assert.match(r.stdout, /workflow replay/);
  assert.match(r.stdout, /workflow providers/);
  assert.match(r.stdout, /workflow supervise/);
  assert.match(r.stdout, /quality check/);
});
test('version is reported', () => { const r = run('version'); assert.equal(r.status, 0); assert.equal(r.stdout.trim(), '0.1.0'); });
test('doctor checks runtime', () => { const r = run('doctor'); assert.equal(r.status, 0); assert.match(r.stdout, /Node.js:/); });
test('agents distinguishes implemented and planned modules', () => {
  const r = run('agents');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Skills Engine \(initial implementation\)/);
  assert.match(r.stdout, /Verification Runner \(implemented/);
  assert.match(r.stdout, /Codex Workflow Execution Adapter \(implemented/);
  assert.match(r.stdout, /Completion Quality Gate \(implemented/);
  assert.match(r.stdout, /Dependency-aware Workflow Orchestrator \(implemented\)/);
});
test('unknown command exits nonzero and reports the actual command', () => {
  const r = run('nope', 'extra');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Unknown command: nope/);
});
test('workflow CLI enforces approval before start and tracks completion', () => {
  const project = mkdtempSync(path.join(tmpdir(), 'aipowers-cli-workflow-'));
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: project });
  try {
    const created = invoke('workflow', 'create', 'write tests first');
    assert.equal(created.status, 0, created.stderr);
    const id = created.stdout.match(/[0-9a-f-]{36}/)?.[0];
    assert.ok(id, created.stdout);
    const denied = invoke('workflow', 'start', id);
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /explicitly approved/);
    assert.equal(invoke('workflow', 'approve', id).status, 0);
    assert.equal(invoke('workflow', 'start', id).status, 0);
    const schedule = invoke('workflow', 'next', id);
    assert.equal(schedule.status, 0, schedule.stderr);
    assert.match(schedule.stdout, /Ready steps:/);
    const stepId = 'test-driven-development';
    const completed = invoke('workflow', 'step', 'done', id, stepId);
    assert.equal(completed.status, 0, completed.stderr);
    assert.match(completed.stdout, /Workflow status: completed/);
    const history = invoke('workflow', 'events', id);
    assert.equal(history.status, 0, history.stderr);
    assert.match(history.stdout, /created/);
    assert.match(history.stdout, /step-completed/);
    const providers = invoke('workflow', 'providers');
    assert.equal(providers.status, 0, providers.stderr);
    assert.match(providers.stdout, /codex \(max concurrency: 1; permissions: workspace-read, workspace-write\)/);
    const replay = invoke('workflow', 'replay', id);
    assert.equal(replay.status, 0, replay.stderr);
    assert.match(replay.stdout, /Workflow replay:/);
    assert.match(replay.stdout, /snapshot verified/);
    const restored = invoke('workflow', 'restore', id);
    assert.equal(restored.status, 0, restored.stderr);
    assert.match(restored.stdout, /already current/);
    const audit = invoke('workflow', 'audit');
    assert.equal(audit.status, 0, audit.stdout + audit.stderr);
    assert.match(audit.stdout, /Workflow store: HEALTHY/);
    assert.doesNotMatch(audit.stdout, /\\\\n/);
    const supervision = invoke('workflow', 'supervise', id);
    assert.equal(supervision.status, 0, supervision.stderr);
    assert.match(supervision.stdout, /No running workflow attempts/);
    const blockedQuality = invoke('quality', 'check', id);
    assert.equal(blockedQuality.status, 1);
    assert.match(blockedQuality.stdout, /No verification evidence/);
    writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'quality-cli-fixture', private: true, scripts: { check: 'node --version' } }));
    const verified = invoke('verify', 'check');
    assert.equal(verified.status, 0, verified.stderr);
    const ready = invoke('quality', 'check', id);
    assert.equal(ready.status, 0, ready.stdout + ready.stderr);
    assert.match(ready.stdout, /Completion readiness: READY/);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('verify rejects arbitrary command profiles', () => {
  const r = run('verify', 'anything', 'C:\\');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage: aipowers verify/);
});

test('evidence list reports the honest empty state without fabricating verification', () => {
  const project = mkdtempSync(path.join(tmpdir(), 'aipowers-cli-evidence-'));
  try {
    const r = spawnSync(process.execPath, [cli, 'evidence', 'list'], { encoding: 'utf8', cwd: project });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Execution evidence ledger is empty/);
    assert.doesNotMatch(r.stdout, /\\\\n/);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

test('skills list discovers bundled skills and displays priorities', () => {
  const r = run('skills', 'list');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Discovered 6 skill\(s\)/);
  assert.match(r.stdout, /test-driven-development \[priority 80\]/);
});
test('skills activate resolves, explains, and records matching workflows', () => {
  const r = run('skills', 'activate', 'write tests first using test driven development');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Activated 1 skill/);
  assert.match(r.stdout, /Matched trigger/);
  assert.match(r.stdout, /RED/);
  assert.match(r.stdout, /Decision saved to/);
});
test('skills activate reports when no workflow matches', () => {
  const r = run('skills', 'activate', 'choose a shade of blue for the page');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No matching skills activated/);
});
test('skills ledger displays saved activation decisions', () => {
  run('skills', 'activate', 'write tests first using test driven development');
  const r = run('skills', 'ledger', '2');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /write tests first using test driven development/);
  assert.match(r.stdout, /test-driven-development/);
});

test('agent prepare creates a skill-aware context handoff', () => {
  const r = run('agent', 'prepare', 'debug this bug and write tests first');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Prepared agent context/);
  assert.match(r.stdout, /systematic-debugging/);
  assert.match(r.stdout, /test-driven-development/);
  assert.match(r.stdout, /No agent was launched or automatically injected/);
});

test('codex install exports native project skills into the target workspace', () => {
  const project = mkdtempSync(path.join(tmpdir(), 'aipowers-cli-codex-'));
  try {
    const r = spawnSync(process.execPath, [cli, 'codex', 'install'], { encoding: 'utf8', cwd: project });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Installed 6 AIPowers skill/);
    const skill = readFileSync(path.join(project, '.agents', 'skills', 'aipowers-test-driven-development', 'SKILL.md'), 'utf8');
    assert.match(skill, /RED/);
    assert.equal(JSON.parse(readFileSync(path.join(project, '.aipowers', 'codex-integration.json'), 'utf8')).host, 'codex');
  } finally { rmSync(project, { recursive: true, force: true }); }
});


test('workflow run reports an unavailable provider without launching a process', () => {
  const result = run('workflow', 'run', 'provider-that-is-not-installed', 'workflow-id', 'step-id');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No execution adapter is registered/);
});


test('memory CLI manages project memories with explicit retention and deletion', () => {
  const project = mkdtempSync(path.join(tmpdir(), 'aipowers-memory-cli-'));
  try {
    const saved = runIn(project, 'memory', 'set', 'api-design', 'architecture', '180', 'Use', 'versioned', 'REST', 'endpoints.');
    assert.equal(saved.status, 0, saved.stderr);
    assert.match(saved.stdout, /Saved project memory: api-design/);

    const fetched = runIn(project, 'memory', 'get', 'api-design');
    assert.equal(fetched.status, 0, fetched.stderr);
    assert.match(fetched.stdout, /Use versioned REST endpoints/);

    const searched = runIn(project, 'memory', 'search', 'REST', 'API');
    assert.equal(searched.status, 0, searched.stderr);
    assert.match(searched.stdout, /api-design/);

    const audit = runIn(project, 'memory', 'audit');
    assert.equal(audit.status, 0, audit.stderr);
    assert.match(audit.stdout, /Project memory: HEALTHY/);

    const events = runIn(project, 'memory', 'events');
    assert.equal(events.status, 0, events.stderr);
    assert.match(events.stdout, /set/);

    const denied = runIn(project, 'memory', 'remove', 'api-design');
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /--confirm/);

    const removed = runIn(project, 'memory', 'remove', 'api-design', '--confirm');
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(removed.stdout, /Removed project memory/);
    assert.match(runIn(project, 'memory', 'list').stdout, /No active project memories/);
  } finally { rmSync(project, { recursive: true, force: true }); }
});
