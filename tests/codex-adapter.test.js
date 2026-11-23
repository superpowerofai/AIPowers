import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkflow, approveWorkflow, startWorkflow, completeWorkflowStep } from '../src/workflow.js';
import { buildCodexStepPrompt, runCodexWorkflowStep } from '../src/adapters/codex.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'aipowers-codex-adapter-'));
  const rootDir = path.join(root, '.aipowers', 'workflows');
  const eventPath = path.join(root, '.aipowers', 'workflow-events.jsonl');
  const workflow = createWorkflow({
    task: 'Implement a small feature',
    steps: [{ id: 'build', title: 'Build the feature', skillId: 'test-driven-development', instructions: 'Write a failing test first.' }]
  }, { rootDir, eventPath });
  return { root, rootDir, eventPath, workflow };
}
function fakeSpawn({ code = 0, stdout = '{"type":"turn.completed"}', stderr = '', pid } = {}) {
  let prompt = '';
  const spawnImpl = (command, args, options) => {
    assert.equal(command, 'codex.exe');
    assert.ok(args.includes('--ephemeral'));
    assert.ok(args.includes('--sandbox'));
    assert.ok(args.includes('workspace-write'));
    assert.equal(args.at(-1), '-');
    assert.equal(options.shell, false);
    const child = new EventEmitter();
    if (pid !== undefined) child.pid = pid;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', chunk => { prompt += chunk.toString(); });
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      setImmediate(() => child.emit('close', code, null));
    });
    return child;
  };
  return { spawnImpl, getPrompt: () => prompt };
}

test('builds a focused prompt from the approved workflow step', () => {
  const f = fixture();
  try {
    const prompt = buildCodexStepPrompt(f.workflow, f.workflow.steps[0]);
    assert.match(prompt, /Implement a small feature/);
    assert.match(prompt, /test-driven-development/);
    assert.match(prompt, /Write a failing test first/);
    assert.match(prompt, /Do not claim tests passed/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('refuses to run Codex until workflow is explicitly approved and started', async () => {
  const f = fixture();
  try {
    await assert.rejects(() => runCodexWorkflowStep(f.workflow.id, 'build', {
      cwd: f.root, rootDir: f.rootDir, eventPath: f.eventPath,
      spawnImpl: () => { throw new Error('must not spawn'); }
    }), /approved and started/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('captures Codex completion and records an executed step pending human review', async () => {
  const f = fixture();
  try {
    approveWorkflow(f.workflow.id, { rootDir: f.rootDir, eventPath: f.eventPath });
    startWorkflow(f.workflow.id, { rootDir: f.rootDir, eventPath: f.eventPath });
    const fake = fakeSpawn();
    const result = await runCodexWorkflowStep(f.workflow.id, 'build', {
      cwd: f.root, rootDir: f.rootDir, eventPath: f.eventPath, codexPath: 'codex.exe', spawnImpl: fake.spawnImpl
    });
    assert.equal(result.step.status, 'executed');
    assert.equal(result.workflow.status, 'active');
    assert.match(fake.getPrompt(), /Write a failing test first/);
    assert.match(result.stdout, /turn.completed/);
    const reviewed = completeWorkflowStep(f.workflow.id, 'build', { rootDir: f.rootDir, eventPath: f.eventPath });
    assert.equal(reviewed.status, 'completed');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('records failed Codex execution and does not mark the step complete', async () => {
  const f = fixture();
  try {
    approveWorkflow(f.workflow.id, { rootDir: f.rootDir, eventPath: f.eventPath });
    startWorkflow(f.workflow.id, { rootDir: f.rootDir, eventPath: f.eventPath });
    const fake = fakeSpawn({ code: 1, stderr: 'authentication failed' });
    const result = await runCodexWorkflowStep(f.workflow.id, 'build', {
      cwd: f.root, rootDir: f.rootDir, eventPath: f.eventPath, codexPath: 'codex.exe', spawnImpl: fake.spawnImpl
    });
    assert.equal(result.step.status, 'failed');
    assert.equal(result.workflow.status, 'active');
    assert.throws(() => completeWorkflowStep(f.workflow.id, 'build', { rootDir: f.rootDir, eventPath: f.eventPath }), /already failed/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('does not launch a provider for a step whose dependencies are incomplete', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aipowers-codex-dependency-'));
  const rootDir = path.join(root, '.aipowers', 'workflows');
  const eventPath = path.join(root, '.aipowers', 'workflow-events.jsonl');
  try {
    const workflow = createWorkflow({
      task: 'Build dependent tasks',
      steps: [
        { id: 'first', title: 'First step' },
        { id: 'second', title: 'Second step', dependsOn: ['first'] }
      ]
    }, { rootDir, eventPath });
    approveWorkflow(workflow.id, { rootDir, eventPath });
    startWorkflow(workflow.id, { rootDir, eventPath });
    await assert.rejects(() => runCodexWorkflowStep(workflow.id, 'second', {
      cwd: root, rootDir, eventPath,
      spawnImpl: () => { throw new Error('provider must not launch'); }
    }), /not ready; waiting for: first/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('records a synchronous process-launch failure instead of leaving an orphaned running step', async () => {
  const f = fixture();
  try {
    approveWorkflow(f.workflow.id, { rootDir: f.rootDir, eventPath: f.eventPath });
    startWorkflow(f.workflow.id, { rootDir: f.rootDir, eventPath: f.eventPath });
    await assert.rejects(() => runCodexWorkflowStep(f.workflow.id, 'build', {
      cwd: f.root, rootDir: f.rootDir, eventPath: f.eventPath,
      spawnImpl: () => { throw new Error('executable missing'); }
    }), /Unable to launch Codex CLI: executable missing/);
    const stored = (await import('../src/workflow.js')).getWorkflow(f.workflow.id, { rootDir: f.rootDir });
    assert.equal(stored.steps[0].status, 'failed');
    assert.equal(stored.steps[0].executionAttempts[0].status, 'failed');
    assert.equal(stored.steps[0].execution.exitCode, 127);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('records an asynchronous child process error instead of leaving an orphaned running step', async () => {
  const f = fixture();
  try {
    approveWorkflow(f.workflow.id, { rootDir: f.rootDir, eventPath: f.eventPath });
    startWorkflow(f.workflow.id, { rootDir: f.rootDir, eventPath: f.eventPath });
    await assert.rejects(() => runCodexWorkflowStep(f.workflow.id, 'build', {
      cwd: f.root, rootDir: f.rootDir, eventPath: f.eventPath,
      spawnImpl: () => {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        setImmediate(() => child.emit('error', new Error('spawn ENOENT')));
        return child;
      }
    }), /Unable to launch Codex CLI: spawn ENOENT/);
    const stored = (await import('../src/workflow.js')).getWorkflow(f.workflow.id, { rootDir: f.rootDir });
    assert.equal(stored.steps[0].status, 'failed');
    assert.equal(stored.steps[0].executionAttempts[0].status, 'failed');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('attaches the spawned Codex process ID to its durable workflow attempt', async () => {
  const f = fixture();
  try {
    approveWorkflow(f.workflow.id, { rootDir: f.rootDir, eventPath: f.eventPath });
    startWorkflow(f.workflow.id, { rootDir: f.rootDir, eventPath: f.eventPath });
    const fake = fakeSpawn({ pid: process.pid });
    const result = await runCodexWorkflowStep(f.workflow.id, 'build', {
      cwd: f.root, rootDir: f.rootDir, eventPath: f.eventPath, spawnImpl: fake.spawnImpl
    });
    const attempt = result.step.executionAttempts[0];
    assert.equal(attempt.processId, process.pid);
    assert.equal(attempt.status, 'executed');
    assert.ok(attempt.processAttachedAt);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
