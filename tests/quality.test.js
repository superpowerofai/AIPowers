import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorkflow, approveWorkflow, startWorkflow, completeWorkflowStep } from '../src/workflow.js';
import { recordVerification } from '../src/evidence.js';
import { evaluateWorkflowCompletion } from '../src/quality.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'aipowers-quality-'));
  return {
    root,
    rootDir: path.join(root, 'workflows'),
    eventPath: path.join(root, 'workflow-events.jsonl'),
    evidencePath: path.join(root, 'execution-ledger.jsonl')
  };
}
function opts(f) { return { rootDir: f.rootDir, eventPath: f.eventPath }; }
function finishWorkflow(f) {
  const workflow = createWorkflow({ task: 'Deliver feature', steps: [{ id: 'build', title: 'Build feature' }] }, opts(f));
  approveWorkflow(workflow.id, opts(f));
  startWorkflow(workflow.id, opts(f));
  completeWorkflowStep(workflow.id, 'build', opts(f));
  return workflow.id;
}
function record(f, values = {}) {
  return recordVerification({
    command: 'npm run check',
    exitCode: 0,
    durationMs: 100,
    startedAt: '2026-11-23T00:00:00.000Z',
    completedAt: new Date(Date.now() + 1000).toISOString(),
    stdout: 'all checks passed',
    stderr: '',
    ...values
  }, { ledgerPath: f.evidencePath });
}

test('blocks completion when verification evidence is missing', () => {
  const f = fixture();
  try {
    const id = finishWorkflow(f);
    const result = evaluateWorkflowCompletion(id, f);
    assert.equal(result.ready, false);
    assert.match(result.blockers.join(' '), /No verification evidence/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('approves completion when all steps and fresh verification pass', () => {
  const f = fixture();
  try {
    const id = finishWorkflow(f);
    record(f);
    const result = evaluateWorkflowCompletion(id, f);
    assert.equal(result.ready, true);
    assert.equal(result.completedSteps, 1);
    assert.equal(result.latestEvidenceStatus, 'passed');
    assert.deepEqual(result.blockers, []);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('blocks completion when latest verification failed or output was truncated', () => {
  const f = fixture();
  try {
    const id = finishWorkflow(f);
    record(f, { exitCode: 3, completedAt: new Date(Date.now() + 1000).toISOString() });
    const failed = evaluateWorkflowCompletion(id, f);
    assert.equal(failed.ready, false);
    assert.match(failed.blockers.join(' '), /did not pass/);
    record(f, { outputTruncated: true, completedAt: new Date(Date.now() + 2000).toISOString() });
    const truncated = evaluateWorkflowCompletion(id, f);
    assert.match(truncated.blockers.join(' '), /output was truncated/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('requires verification evidence newer than the final workflow update', () => {
  const f = fixture();
  try {
    const id = createWorkflow({ task: 'Deliver feature', steps: [{ id: 'build', title: 'Build feature' }] }, opts(f)).id;
    record(f, { completedAt: '2020-01-01T00:00:00.000Z' });
    approveWorkflow(id, opts(f));
    startWorkflow(id, opts(f));
    completeWorkflowStep(id, 'build', opts(f));
    const result = evaluateWorkflowCompletion(id, f);
    assert.equal(result.ready, false);
    assert.match(result.blockers.join(' '), /older than the latest workflow update/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('blocks completion when the persisted workflow snapshot has no matching final audit checkpoint', () => {
  const f = fixture();
  try {
    const id = finishWorkflow(f);
    record(f);
    const lines = readFileSync(f.eventPath, 'utf8').trim().split(/\r?\n/);
    lines.pop();
    writeFileSync(f.eventPath, lines.join('\n') + '\n');
    const result = evaluateWorkflowCompletion(id, f);
    assert.equal(result.ready, false);
    assert.match(result.blockers.join(' '), /state and audit history are out of sync/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
