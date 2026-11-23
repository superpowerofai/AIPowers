import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createWorkflow, getWorkflow, listWorkflows, approveWorkflow, approveWorkflowStep, startWorkflow,
  completeWorkflowStep, blockWorkflow, resumeWorkflow, cancelWorkflow, readWorkflowEvents,
  recordWorkflowStepExecution, retryWorkflowStep, getWorkflowSchedule,
  beginWorkflowStepExecution, attachWorkflowExecutionProcess, recoverWorkflowExecutions, auditWorkflowStore, migrateWorkflowCheckpoint, superviseWorkflowExecutions, restoreWorkflowSnapshot, replayWorkflowHistory
} from '../src/workflow.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'aipowers-workflow-'));
  return { root, rootDir: path.join(root, 'workflows'), eventPath: path.join(root, 'events.jsonl') };
}
function options(f) { return { rootDir: f.rootDir, eventPath: f.eventPath }; }
function create(f, steps = [{ id: 'plan', title: 'Plan implementation' }, { id: 'build', title: 'Build and verify' }]) {
  return createWorkflow({ task: 'Build a useful feature', steps }, options(f));
}

test('creates proposed workflows with pending steps and lists them', () => {
  const f = fixture();
  try {
    const workflow = create(f);
    assert.equal(workflow.status, 'proposed');
    assert.equal(workflow.approval.required, true);
    assert.equal(workflow.steps.length, 2);
    assert.equal(workflow.steps[0].status, 'pending');
    assert.equal(getWorkflow(workflow.id, options(f)).id, workflow.id);
    assert.equal(listWorkflows({ rootDir: f.rootDir }).length, 1);
    assert.equal(readWorkflowEvents({ eventPath: f.eventPath }).length, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('requires explicit approval before a workflow can start', () => {
  const f = fixture();
  try {
    const workflow = create(f);
    assert.throws(() => startWorkflow(workflow.id, options(f)), /explicitly approved/);
    const approved = approveWorkflow(workflow.id, options(f));
    assert.equal(approved.status, 'approved');
    assert.ok(approved.approval.approvedAt);
    assert.equal(startWorkflow(workflow.id, options(f)).status, 'active');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('completes steps in order and marks the workflow complete only when all steps finish', () => {
  const f = fixture();
  try {
    const workflow = create(f);
    approveWorkflow(workflow.id, options(f));
    startWorkflow(workflow.id, options(f));
    const first = completeWorkflowStep(workflow.id, 'plan', options(f));
    assert.equal(first.status, 'active');
    assert.equal(first.steps[0].status, 'completed');
    const done = completeWorkflowStep(workflow.id, 'build', options(f));
    assert.equal(done.status, 'completed');
    assert.throws(() => completeWorkflowStep(workflow.id, 'build', options(f)), /Only active|already completed/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('supports blocking and resuming an active workflow', () => {
  const f = fixture();
  try {
    const workflow = create(f);
    approveWorkflow(workflow.id, options(f));
    startWorkflow(workflow.id, options(f));
    const blocked = blockWorkflow(workflow.id, 'Waiting for access approval', options(f));
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockedReason, 'Waiting for access approval');
    const resumed = resumeWorkflow(workflow.id, options(f));
    assert.equal(resumed.status, 'active');
    assert.equal(resumed.blockedReason, null);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('allows cancellation and prevents invalid terminal-state transitions', () => {
  const f = fixture();
  try {
    const workflow = create(f);
    assert.equal(cancelWorkflow(workflow.id, 'User paused project', options(f)).status, 'cancelled');
    assert.throws(() => approveWorkflow(workflow.id, options(f)), /cancelled state/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('validates workflow tasks and unique step identifiers', () => {
  const f = fixture();
  try {
    assert.throws(() => createWorkflow({ task: ' ', steps: [{ id: 'x', title: 'X' }] }, options(f)), /task/);
    assert.throws(() => createWorkflow({ task: 'Task', steps: [{ id: 'x', title: 'X' }, { id: 'x', title: 'Duplicate' }] }, options(f)), /Duplicate/);
    assert.throws(() => createWorkflow({ task: 'Task', steps: [] }, options(f)), /At least one/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('detects tampering in the workflow event chain', () => {
  const f = fixture();
  try {
    const workflow = create(f);
    approveWorkflow(workflow.id, options(f));
    const lines = readFileSync(f.eventPath, 'utf8').trim().split(/\r?\n/);
    const event = JSON.parse(lines[0]);
    event.details.task = 'tampered';
    lines[0] = JSON.stringify(event);
    writeFileSync(f.eventPath, lines.join('\n') + '\n');
    assert.throws(() => readWorkflowEvents({ eventPath: f.eventPath }), /integrity check failed/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('detects tampering in persisted workflow state', () => {
  const f = fixture();
  try {
    const workflow = create(f);
    const file = path.join(f.rootDir, workflow.id + '.json');
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    stored.task = 'tampered state';
    writeFileSync(file, JSON.stringify(stored));
    assert.throws(() => getWorkflow(workflow.id, options(f)), /state integrity check failed/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('records agent execution separately from human-reviewed step completion', () => {
  const f = fixture();
  try {
    const workflow = create(f, [{ id: 'build', title: 'Build implementation' }]);
    approveWorkflow(workflow.id, options(f));
    startWorkflow(workflow.id, options(f));
    const execution = {
      provider: 'codex',
      exitCode: 0,
      durationMs: 1500,
      startedAt: '2026-11-23T00:00:00.000Z',
      completedAt: '2026-11-23T00:00:01.500Z',
      outputSha256: 'a'.repeat(64),
      outputBytes: 120
    };
    const executed = recordWorkflowStepExecution(workflow.id, 'build', execution, options(f));
    assert.equal(executed.steps[0].status, 'executed');
    assert.equal(executed.status, 'active');
    const reviewed = completeWorkflowStep(workflow.id, 'build', options(f));
    assert.equal(reviewed.steps[0].status, 'completed');
    assert.equal(reviewed.status, 'completed');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('failed agent steps require an explicit retry transition', () => {
  const f = fixture();
  try {
    const workflow = create(f, [{ id: 'build', title: 'Build implementation' }]);
    approveWorkflow(workflow.id, options(f));
    startWorkflow(workflow.id, options(f));
    const failed = recordWorkflowStepExecution(workflow.id, 'build', {
      provider: 'codex', exitCode: 1, durationMs: 200,
      startedAt: '2026-11-23T00:00:00.000Z',
      completedAt: '2026-11-23T00:00:00.200Z',
      outputSha256: 'b'.repeat(64), outputBytes: 50
    }, options(f));
    assert.equal(failed.steps[0].status, 'failed');
    assert.throws(() => completeWorkflowStep(workflow.id, 'build', options(f)), /already failed/);
    const retried = retryWorkflowStep(workflow.id, 'build', options(f));
    assert.equal(retried.steps[0].status, 'pending');
    assert.equal(retried.steps[0].execution, null);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('enforces dependencies and exposes ready, waiting, and dependency-blocked steps', () => {
  const f = fixture();
  try {
    const workflow = create(f, [
      { id: 'design', title: 'Design' },
      { id: 'build', title: 'Build', dependsOn: ['design'] },
      { id: 'docs', title: 'Document', dependsOn: ['build'] },
      { id: 'independent', title: 'Independent task' }
    ]);
    approveWorkflow(workflow.id, options(f));
    startWorkflow(workflow.id, options(f));
    let schedule = getWorkflowSchedule(workflow.id, options(f));
    assert.deepEqual(schedule.ready.map(step => step.id), ['design', 'independent']);
    assert.deepEqual(schedule.waiting.map(step => step.id), ['build', 'docs']);
    assert.throws(() => completeWorkflowStep(workflow.id, 'build', options(f)), /waiting for dependencies/);
    completeWorkflowStep(workflow.id, 'design', options(f));
    schedule = getWorkflowSchedule(workflow.id, options(f));
    assert.deepEqual(schedule.ready.map(step => step.id), ['build', 'independent']);
    assert.deepEqual(schedule.waiting.map(step => step.id), ['docs']);
    completeWorkflowStep(workflow.id, 'build', options(f));
    assert.deepEqual(getWorkflowSchedule(workflow.id, options(f)).ready.map(step => step.id), ['docs', 'independent']);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects unknown, self-referential, and cyclic workflow dependencies', () => {
  const f = fixture();
  try {
    assert.throws(() => create(f, [{ id: 'a', title: 'A', dependsOn: ['missing'] }]), /invalid dependency/);
    assert.throws(() => create(f, [{ id: 'a', title: 'A', dependsOn: ['a'] }]), /invalid dependency/);
    assert.throws(() => create(f, [
      { id: 'a', title: 'A', dependsOn: ['b'] },
      { id: 'b', title: 'B', dependsOn: ['a'] }
    ]), /cycles/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('failed dependencies prevent downstream steps from becoming ready', () => {
  const f = fixture();
  try {
    const workflow = create(f, [
      { id: 'first', title: 'First' },
      { id: 'second', title: 'Second', dependsOn: ['first'] }
    ]);
    approveWorkflow(workflow.id, options(f));
    startWorkflow(workflow.id, options(f));
    recordWorkflowStepExecution(workflow.id, 'first', {
      provider: 'mock', exitCode: 1, durationMs: 10,
      outputSha256: 'c'.repeat(64), outputBytes: 1
    }, options(f));
    const schedule = getWorkflowSchedule(workflow.id, options(f));
    assert.deepEqual(schedule.ready, []);
    assert.deepEqual(schedule.failed.map(step => step.id), ['first']);
    assert.deepEqual(schedule.blocked.map(step => step.id), ['second']);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('persists execution attempts before work starts and recovers orphaned running steps', () => {
  const f = fixture();
  try {
    const workflow = create(f, [{ id: 'build', title: 'Build feature' }]);
    approveWorkflow(workflow.id, options(f));
    startWorkflow(workflow.id, options(f));
    const running = beginWorkflowStepExecution(workflow.id, 'build', { provider: 'mock' }, options(f));
    assert.equal(running.steps[0].status, 'running');
    assert.equal(running.steps[0].executionAttempts[0].status, 'running');
    assert.deepEqual(getWorkflowSchedule(workflow.id, options(f)).running.map(step => step.id), ['build']);
    const supervision = superviseWorkflowExecutions(workflow.id, options(f));
    assert.deepEqual(supervision.untracked, ['build']);
    assert.deepEqual(supervision.interrupted, []);
    assert.throws(() => recoverWorkflowExecutions(workflow.id, options(f)), /confirmOrphaned/);
    const recovered = recoverWorkflowExecutions(workflow.id, { ...options(f), confirmOrphaned: true });
    assert.deepEqual(recovered.recovered, ['build']);
    assert.deepEqual(recovered.stillRunning, []);
    assert.equal(recovered.workflow.steps[0].status, 'failed');
    assert.equal(recovered.workflow.steps[0].executionAttempts[0].status, 'interrupted');
    assert.match(recovered.workflow.steps[0].interruptionReason, /inspect the workspace/);
    assert.equal(readWorkflowEvents({ eventPath: f.eventPath }).at(-1).type, 'execution-recovery');
    const retried = retryWorkflowStep(workflow.id, 'build', options(f));
    assert.equal(retried.steps[0].status, 'pending');
    assert.equal(retried.steps[0].executionAttempts.length, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('records execution completion against the durable running attempt', () => {
  const f = fixture();
  try {
    const workflow = create(f, [{ id: 'build', title: 'Build feature' }]);
    approveWorkflow(workflow.id, options(f));
    startWorkflow(workflow.id, options(f));
    beginWorkflowStepExecution(workflow.id, 'build', { provider: 'mock' }, options(f));
    const result = recordWorkflowStepExecution(workflow.id, 'build', {
      provider: 'mock', exitCode: 0, durationMs: 12,
      startedAt: '2026-11-23T00:00:00.000Z',
      completedAt: '2026-11-23T00:00:00.012Z',
      outputSha256: 'd'.repeat(64), outputBytes: 3
    }, options(f));
    assert.equal(result.steps[0].status, 'executed');
    assert.equal(result.steps[0].executionAttempts.length, 1);
    assert.equal(result.steps[0].executionAttempts[0].status, 'executed');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('audits workflow index, snapshot checkpoints and event consistency', () => {
  const f = fixture();
  try {
    const workflow = create(f, [{ id: 'build', title: 'Build' }]);
    approveWorkflow(workflow.id, options(f));
    startWorkflow(workflow.id, options(f));
    completeWorkflowStep(workflow.id, 'build', options(f));
    const healthy = auditWorkflowStore(options(f));
    assert.equal(healthy.healthy, true);
    assert.equal(healthy.workflowCount, 1);
    assert.equal(healthy.eventCount, 4);

    const lines = readFileSync(f.eventPath, 'utf8').trim().split(/\r?\n/);
    lines.pop();
    writeFileSync(f.eventPath, lines.join('\n') + '\n');
    const damaged = auditWorkflowStore(options(f));
    assert.equal(damaged.healthy, false);
    assert.match(damaged.issues.join(' '), /does not match its latest audit checkpoint/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('warns about running steps without automatically recovering or changing them', () => {
  const f = fixture();
  try {
    const workflow = create(f, [{ id: 'build', title: 'Build' }]);
    approveWorkflow(workflow.id, options(f));
    startWorkflow(workflow.id, options(f));
    beginWorkflowStepExecution(workflow.id, 'build', { provider: 'mock' }, options(f));
    const audit = auditWorkflowStore(options(f));
    assert.equal(audit.healthy, true);
    assert.match(audit.warnings.join(' '), /verify the provider process before recovery/);
    assert.equal(getWorkflow(workflow.id, options(f)).steps[0].status, 'running');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('enforces per-step provider assignment at execution start and result recording', () => {
  const f = fixture();
  try {
    const workflow = create(f, [{ id: 'build', title: 'Build', provider: 'codex' }]);
    approveWorkflow(workflow.id, options(f));
    startWorkflow(workflow.id, options(f));
    assert.throws(() => beginWorkflowStepExecution(workflow.id, 'build', { provider: 'other' }, options(f)), /assigned to provider codex/);
    assert.throws(() => recordWorkflowStepExecution(workflow.id, 'build', {
      provider: 'other', exitCode: 0, durationMs: 1,
      outputSha256: 'e'.repeat(64), outputBytes: 0
    }, options(f)), /assigned to provider codex/);
    assert.equal(getWorkflow(workflow.id, options(f)).steps[0].status, 'pending');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('detects a broken state-checkpoint chain even when an event hash is recomputed', () => {
  const f = fixture();
  try {
    const workflow = create(f, [{ id: 'build', title: 'Build' }]);
    approveWorkflow(workflow.id, options(f));
    const lines = readFileSync(f.eventPath, 'utf8').trim().split(/\r?\n/);
    const entry = JSON.parse(lines[1]);
    const { hash: _storedHash, ...payload } = entry;
    payload.previousStateHash = 'f'.repeat(64);
    const digest = createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
    lines[1] = JSON.stringify({ ...payload, hash: digest });
    writeFileSync(f.eventPath, lines.join('\n') + '\n');
    assert.throws(() => readWorkflowEvents({ eventPath: f.eventPath }), /state checkpoint chain failed/);
    assert.equal(getWorkflow(workflow.id, options(f)).status, 'approved');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('migrates a valid legacy workflow audit history without changing workflow state', () => {
  const f = fixture();
  try {
    const workflow = create(f, [{ id: 'build', title: 'Build' }]);
    const lines = readFileSync(f.eventPath, 'utf8').trim().split(/\r?\n/);
    const legacyEntry = JSON.parse(lines[0]);
    const { hash: _oldHash, ...legacyPayload } = legacyEntry;
    delete legacyPayload.stateHash;
    delete legacyPayload.previousStateHash;
    const legacyHash = createHash('sha256').update(JSON.stringify(legacyPayload), 'utf8').digest('hex');
    writeFileSync(f.eventPath, JSON.stringify({ ...legacyPayload, hash: legacyHash }) + '\n');

    const migrated = migrateWorkflowCheckpoint(workflow.id, options(f));
    assert.equal(migrated.migrated, true);
    assert.equal(migrated.workflow.status, 'proposed');
    const events = readWorkflowEvents({ eventPath: f.eventPath });
    assert.equal(events.at(-1).type, 'state-checkpoint-migrated');
    assert.equal(events.at(-1).stateHash, getWorkflow(workflow.id, options(f))._baseStateHash);
    assert.equal(auditWorkflowStore(options(f)).healthy, true);
    assert.equal(migrateWorkflowCheckpoint(workflow.id, options(f)).migrated, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('bounds workflow size and untrusted step metadata before persisting', () => {
  const f = fixture();
  try {
    const tooMany = Array.from({ length: 101 }, (_, index) => ({ id: 'step-' + index, title: 'Step ' + index }));
    assert.throws(() => createWorkflow({ task: 'Too many', steps: tooMany }, options(f)), /more than 100 steps/);
    assert.throws(() => createWorkflow({ task: 'Too long title', steps: [{ id: 'build', title: 'x'.repeat(201) }] }, options(f)), /title must not exceed 200/);
    assert.throws(() => createWorkflow({ task: 'Too many instructions', steps: [{ id: 'build', title: 'Build', instructions: 'x'.repeat(20_001) }] }, options(f)), /instructions must be text/);
    assert.throws(() => createWorkflow({ task: 'Bad priority', steps: [{ id: 'build', title: 'Build', priority: 1001 }] }, options(f)), /priority must be an integer/);
    assert.throws(() => createWorkflow({ task: 'Bad dependencies', steps: [{ id: 'build', title: 'Build', dependsOn: 'step-a' }] }, options(f)), /dependencies must be an array/);
    assert.equal(listWorkflows({ rootDir: f.rootDir }).length, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('never recovers a running attempt while its attached provider process is alive', () => {
  const f = fixture();
  try {
    const workflow = create(f, [{ id: 'build', title: 'Build feature' }]);
    approveWorkflow(workflow.id, options(f));
    startWorkflow(workflow.id, options(f));
    beginWorkflowStepExecution(workflow.id, 'build', { provider: 'mock' }, options(f));
    attachWorkflowExecutionProcess(workflow.id, 'build', { provider: 'mock', processId: process.pid }, options(f));
    const audit = auditWorkflowStore(options(f));
    assert.match(audit.warnings.join(' '), /still appears alive; recovery will skip it/);
    const supervised = superviseWorkflowExecutions(workflow.id, options(f));
    assert.deepEqual(supervised.stillRunning, ['build']);
    assert.deepEqual(supervised.interrupted, []);
    const result = recoverWorkflowExecutions(workflow.id, { ...options(f), confirmOrphaned: true });
    assert.deepEqual(result.recovered, []);
    assert.deepEqual(result.stillRunning, ['build']);
    assert.equal(result.workflow.steps[0].status, 'running');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('automatically marks a running attempt failed when its attached provider process has exited', () => {
  const f = fixture();
  try {
    const workflow = create(f, [{ id: 'build', title: 'Build feature' }]);
    approveWorkflow(workflow.id, options(f));
    startWorkflow(workflow.id, options(f));
    beginWorkflowStepExecution(workflow.id, 'build', { provider: 'mock' }, options(f));
    attachWorkflowExecutionProcess(workflow.id, 'build', { provider: 'mock', processId: 999999999 }, options(f));
    const result = superviseWorkflowExecutions(workflow.id, options(f));
    assert.deepEqual(result.interrupted, ['build']);
    assert.deepEqual(result.stillRunning, []);
    assert.deepEqual(result.untracked, []);
    assert.equal(result.workflow.steps[0].status, 'failed');
    assert.equal(result.workflow.steps[0].executionAttempts[0].status, 'interrupted');
    assert.equal(readWorkflowEvents({ eventPath: f.eventPath }).at(-1).type, 'process-supervision');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('restores a corrupted workflow snapshot from the latest immutable audited checkpoint', () => {
  const f = fixture();
  try {
    const workflow = create(f, [{ id: 'build', title: 'Build' }]);
    approveWorkflow(workflow.id, options(f));
    startWorkflow(workflow.id, options(f));
    completeWorkflowStep(workflow.id, 'build', options(f));
    const currentFile = path.join(f.rootDir, workflow.id + '.json');
    const damaged = JSON.parse(readFileSync(currentFile, 'utf8'));
    damaged.status = 'blocked';
    writeFileSync(currentFile, JSON.stringify(damaged));
    assert.equal(auditWorkflowStore(options(f)).healthy, false);

    const restored = restoreWorkflowSnapshot(workflow.id, options(f));
    assert.equal(restored.restored, true);
    assert.equal(restored.workflow.status, 'completed');
    assert.equal(getWorkflow(workflow.id, options(f)).status, 'completed');
    assert.equal(readWorkflowEvents({ eventPath: f.eventPath }).at(-1).type, 'snapshot-restored');
    assert.equal(auditWorkflowStore(options(f)).healthy, true);
    assert.equal(restoreWorkflowSnapshot(workflow.id, options(f)).restored, false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('audits every immutable checkpoint snapshot, not only the current workflow file', () => {
  const f = fixture();
  try {
    const workflow = create(f, [{ id: 'build', title: 'Build' }]);
    approveWorkflow(workflow.id, options(f));
    const events = readWorkflowEvents({ eventPath: f.eventPath }).filter(event => event.workflowId === workflow.id);
    const firstSnapshot = path.join(f.rootDir, '.snapshots', workflow.id, events[0].stateHash + '.json');
    unlinkSync(firstSnapshot);
    const audit = auditWorkflowStore(options(f));
    assert.equal(audit.healthy, false);
    assert.match(audit.issues.join(' '), /immutable snapshot is unavailable or invalid/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('replays the complete workflow state sequence from immutable event-linked snapshots', () => {
  const f = fixture();
  try {
    const workflow = create(f, [{ id: 'build', title: 'Build' }]);
    approveWorkflow(workflow.id, options(f));
    startWorkflow(workflow.id, options(f));
    completeWorkflowStep(workflow.id, 'build', options(f));
    const history = replayWorkflowHistory(workflow.id, options(f));
    assert.deepEqual(history.map(event => event.status), ['proposed', 'approved', 'active', 'completed']);
    assert.deepEqual(history.map(event => event.snapshot.status), ['proposed', 'approved', 'active', 'completed']);
    assert.ok(history.every(event => event.legacy === false));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('requires separate approval for sensitive permissions and resets it after retry', () => {
  const f = fixture();
  try {
    const workflow = create(f, [
      { id: 'plan', title: 'Plan safely' },
      { id: 'publish', title: 'Publish externally', dependsOn: ['plan'], permissions: ['workspace-read', 'external-side-effect'] }
    ]);
    assert.equal(workflow.steps[0].approvalRequired, false);
    assert.equal(workflow.steps[1].approvalRequired, true);
    assert.equal(workflow.steps[1].approvalStatus, 'pending');
    approveWorkflow(workflow.id, options(f));
    startWorkflow(workflow.id, options(f));
    let schedule = getWorkflowSchedule(workflow.id, options(f));
    assert.deepEqual(schedule.ready.map(step => step.id), ['plan']);
    assert.deepEqual(schedule.approvalPending, []);
    assert.throws(() => approveWorkflowStep(workflow.id, 'publish', options(f)), /Approve dependencies first/);
    completeWorkflowStep(workflow.id, 'plan', options(f));
    schedule = getWorkflowSchedule(workflow.id, options(f));
    assert.deepEqual(schedule.approvalPending.map(step => step.id), ['publish']);
    assert.throws(() => beginWorkflowStepExecution(workflow.id, 'publish', { provider: 'mock' }, options(f)), /requires separate approval/);
    assert.throws(() => completeWorkflowStep(workflow.id, 'publish', options(f)), /requires separate approval/);
    approveWorkflowStep(workflow.id, 'publish', options(f));
    let current = getWorkflow(workflow.id, options(f));
    assert.equal(current.steps[1].approvalStatus, 'approved');
    beginWorkflowStepExecution(workflow.id, 'publish', { provider: 'mock' }, options(f));
    current = recordWorkflowStepExecution(workflow.id, 'publish', {
      provider: 'mock', exitCode: 1, durationMs: 5,
      outputSha256: 'f'.repeat(64), outputBytes: 0
    }, options(f));
    assert.equal(current.steps[1].status, 'failed');
    current = retryWorkflowStep(workflow.id, 'publish', options(f));
    assert.equal(current.steps[1].status, 'pending');
    assert.equal(current.steps[1].approvalStatus, 'pending');
    assert.equal(current.steps[1].approvedAt, null);
    assert.deepEqual(getWorkflowSchedule(workflow.id, options(f)).approvalPending.map(step => step.id), ['publish']);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
