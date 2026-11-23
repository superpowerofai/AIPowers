import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createWorkflow, approveWorkflow, startWorkflow, beginWorkflowStepExecution,
  recordWorkflowStepExecution, completeWorkflowStep
} from '../src/workflow.js';
import { runReadyWorkflowSteps } from '../src/orchestrator.js';
import { registerExecutionAdapter } from '../src/adapters/registry.js';

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'aipowers-orchestrator-'));
  const options = { rootDir: path.join(root, '.aipowers', 'workflows'), eventPath: path.join(root, '.aipowers', 'events.jsonl') };
  const workflow = createWorkflow({
    task: 'Execute dependency-aware work',
    steps: [
      { id: 'alpha', title: 'Independent alpha' },
      { id: 'beta', title: 'Independent beta' },
      { id: 'gamma', title: 'Depends on alpha', dependsOn: ['alpha'] }
    ]
  }, options);
  approveWorkflow(workflow.id, options);
  startWorkflow(workflow.id, options);
  return { root, options, workflow };
}

function successfulRunner(options) {
  return async (_provider, workflowId, stepId) => {
    beginWorkflowStepExecution(workflowId, stepId, { provider: 'fixture' }, options);
    const workflow = recordWorkflowStepExecution(workflowId, stepId, {
      provider: 'fixture', exitCode: 0, durationMs: 1,
      outputSha256: 'e'.repeat(64), outputBytes: 1
    }, options);
    return { step: workflow.steps.find(step => step.id === stepId), execution: { exitCode: 0 } };
  };
}

test('runs every currently ready step sequentially but waits for human review before dependents', async () => {
  const f = setup();
  try {
    const first = await runReadyWorkflowSteps('fixture', f.workflow.id, f.options, { runStep: successfulRunner(f.options) });
    assert.deepEqual(first.results.map(item => item.stepId), ['alpha', 'beta']);
    assert.deepEqual(first.waitingStepIds, ['gamma']);
    assert.deepEqual(first.reviewStepIds, ['alpha', 'beta']);
    assert.deepEqual(first.readyStepIds, []);
    completeWorkflowStep(f.workflow.id, 'alpha', f.options);
    const second = await runReadyWorkflowSteps('fixture', f.workflow.id, f.options, { runStep: successfulRunner(f.options) });
    assert.deepEqual(second.results.map(item => item.stepId), ['gamma']);
    assert.equal(second.workflowId, f.workflow.id);
    assert.deepEqual(second.readyStepIds, []);
    assert.deepEqual(second.waitingStepIds, []);
    assert.equal(second.results[0].status, 'executed');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('enforces a bounded number of steps per orchestration call', async () => {
  const f = setup();
  try {
    const result = await runReadyWorkflowSteps('fixture', f.workflow.id, f.options, {
      runStep: successfulRunner(f.options), maxSteps: 1
    });
    assert.equal(result.results.length, 1);
    assert.equal(result.limitReached, true);
    assert.deepEqual(result.readyStepIds, ['beta']);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('requires an active workflow and validates the execution limit', async () => {
  const f = setup();
  try {
    await assert.rejects(() => runReadyWorkflowSteps('codex', '00000000-0000-4000-8000-000000000000', f.options), /Workflow not found/);
    const proposed = createWorkflow({ task: 'Not started', steps: [{ id: 'pending', title: 'Pending' }] }, f.options);
    await assert.rejects(() => runReadyWorkflowSteps('codex', proposed.id, f.options), /must be active/);
    await assert.rejects(() => runReadyWorkflowSteps('fixture', f.workflow.id, f.options, { maxSteps: 0 }), /maxSteps/);
    await assert.rejects(() => runReadyWorkflowSteps('codex', f.workflow.id, f.options, { maxConcurrency: 2 }), /exceeds the registered provider capability/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('stops a run-ready pass after provider failure and reports remaining work', async () => {
  const f = setup();
  try {
    const failingRunner = async (_provider, workflowId, stepId) => {
      beginWorkflowStepExecution(workflowId, stepId, { provider: 'fixture' }, f.options);
      const workflow = recordWorkflowStepExecution(workflowId, stepId, {
        provider: 'fixture', exitCode: 1, durationMs: 1,
        outputSha256: 'f'.repeat(64), outputBytes: 1
      }, f.options);
      return { step: workflow.steps.find(step => step.id === stepId), execution: { exitCode: 1 } };
    };
    const result = await runReadyWorkflowSteps('fixture', f.workflow.id, f.options, { runStep: failingRunner });
    assert.deepEqual(result.results.map(item => item.stepId), ['alpha']);
    assert.deepEqual(result.failedStepIds, ['alpha']);
    assert.deepEqual(result.readyStepIds, ['beta']);
    assert.deepEqual(result.blockedStepIds, ['gamma']);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects an adapter that reports success without persisting a step transition', async () => {
  const f = setup();
  try {
    await assert.rejects(() => runReadyWorkflowSteps('fixture', f.workflow.id, f.options, {
      runStep: async () => ({ step: { status: 'executed' }, execution: { exitCode: 0 } })
    }), /without advancing step alpha/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('runs independent ready steps in parallel only up to the configured provider capacity', async () => {
  const f = setup();
  let active = 0;
  let peak = 0;
  const runner = async (_provider, workflowId, stepId) => {
    beginWorkflowStepExecution(workflowId, stepId, { provider: 'fixture' }, f.options);
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 25));
    const workflow = recordWorkflowStepExecution(workflowId, stepId, {
      provider: 'fixture', exitCode: 0, durationMs: 25,
      outputSha256: 'a'.repeat(64), outputBytes: 1
    }, f.options);
    active -= 1;
    return { step: workflow.steps.find(step => step.id === stepId), execution: { exitCode: 0 } };
  };
  try {
    const result = await runReadyWorkflowSteps('fixture', f.workflow.id, f.options, {
      runStep: runner, maxConcurrency: 2
    });
    assert.equal(peak, 2);
    assert.deepEqual(result.results.map(item => item.stepId), ['alpha', 'beta']);
    assert.deepEqual(result.reviewStepIds, ['alpha', 'beta']);
    assert.deepEqual(result.waitingStepIds, ['gamma']);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('routes independent workflow steps to different providers and coordinates their concurrency', async () => {
  const f = setup();
  let active = 0;
  let peak = 0;
  const register = id => registerExecutionAdapter({
    id,
    maxConcurrency: 1,
    async runStep(workflowId, stepId, options) {
      beginWorkflowStepExecution(workflowId, stepId, { provider: id }, options);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 30));
      const workflow = recordWorkflowStepExecution(workflowId, stepId, {
        provider: id, exitCode: 0, durationMs: 30,
        outputSha256: (id === 'provider-a' ? 'c' : 'd').repeat(64), outputBytes: 1
      }, options);
      active -= 1;
      return { step: workflow.steps.find(step => step.id === stepId), execution: { exitCode: 0 } };
    }
  });
  register('provider-a');
  register('provider-b');
  try {
    const workflow = createWorkflow({
      task: 'Route work across independent providers',
      steps: [
        { id: 'alpha', title: 'Provider A work', provider: 'provider-a' },
        { id: 'beta', title: 'Provider B work', provider: 'provider-b' }
      ]
    }, f.options);
    approveWorkflow(workflow.id, f.options);
    startWorkflow(workflow.id, f.options);
    const result = await runReadyWorkflowSteps('codex', workflow.id, f.options);
    assert.equal(peak, 2);
    assert.deepEqual(result.results.map(item => item.provider), ['provider-a', 'provider-b']);
    assert.deepEqual(result.reviewStepIds, ['alpha', 'beta']);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects invalid per-step provider identifiers at workflow creation', () => {
  const f = setup();
  try {
    assert.throws(() => createWorkflow({
      task: 'Invalid provider',
      steps: [{ id: 'alpha', title: 'Alpha', provider: 'Bad Provider' }]
    }, f.options), /invalid provider id/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
