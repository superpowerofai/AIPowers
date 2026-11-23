import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeWorkflowStep, getExecutionAdapter, registerExecutionAdapter, listExecutionAdapters } from '../src/adapters/registry.js';
import { createWorkflow } from '../src/workflow.js';

test('registers and dispatches provider-neutral execution adapters with workflow permission checks', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'aipowers-registry-'));
  const eventPath = path.join(rootDir, 'events.jsonl');
  try {
    const workflow = createWorkflow({ task: 'fixture', steps: [{ id: 'step-1', title: 'Fixture step' }] }, { rootDir, eventPath });
    const adapter = registerExecutionAdapter({
      id: 'fixture-provider',
      async runStep(workflowId, stepId, options) {
        return { workflowId, stepId, option: options.marker };
      }
    });
    assert.equal(adapter.id, 'fixture-provider');
    assert.equal(adapter.maxConcurrency, 1);
    assert.deepEqual(adapter.permissions, ['workspace-read', 'workspace-write']);
    assert.equal(getExecutionAdapter('fixture-provider'), adapter);
    assert.ok(listExecutionAdapters().some(item => item.id === 'codex' && item.maxConcurrency === 1));
    assert.ok(listExecutionAdapters().some(item => item.id === 'fixture-provider' && item.maxConcurrency === 1));
    assert.deepEqual(await executeWorkflowStep('fixture-provider', workflow.id, 'step-1', { marker: 'passed', rootDir }), {
      workflowId: workflow.id, stepId: 'step-1', option: 'passed'
    });
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('rejects invalid and duplicate adapter registrations', () => {
  assert.throws(() => registerExecutionAdapter({ id: 'Bad Provider', runStep() {} }), /lowercase provider id/);
  assert.throws(() => registerExecutionAdapter({ id: 'missing-runner' }), /runStep/);
  assert.throws(() => registerExecutionAdapter({ id: 'bad-capacity', runStep() {}, maxConcurrency: 0 }), /maxConcurrency/);
  assert.throws(() => registerExecutionAdapter({ id: 'bad-permissions', runStep() {}, permissions: ['Workspace-Write'] }), /permissions/);
  const parallel = registerExecutionAdapter({ id: 'parallel-fixture', runStep() {}, maxConcurrency: 2 });
  assert.equal(parallel.maxConcurrency, 2);
  assert.throws(() => registerExecutionAdapter({ id: 'codex', runStep() {} }), /already registered/);
});

test('rejects adapter execution when its capabilities do not cover the step permissions', async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'aipowers-registry-deny-'));
  const eventPath = path.join(rootDir, 'events.jsonl');
  try {
    const workflow = createWorkflow({ task: 'sensitive', steps: [{ id: 'step-1', title: 'External action', permissions: ['workspace-read', 'external-side-effect'] }] }, { rootDir, eventPath });
    await assert.rejects(
      () => executeWorkflowStep('codex', workflow.id, 'step-1', { rootDir }),
      /does not grant required permissions: external-side-effect/
    );
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test('reports unsupported providers without pretending execution occurred', async () => {
  assert.equal(getExecutionAdapter('not-installed'), null);
  await assert.rejects(() => executeWorkflowStep('not-installed', 'wf', 'step'), /No execution adapter/);
});
