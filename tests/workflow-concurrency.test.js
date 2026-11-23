import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createWorkflow, getWorkflow, approveWorkflow, startWorkflow, beginWorkflowStepExecution,
  recordWorkflowStepExecution, completeWorkflowStep, listWorkflows, readWorkflowEvents
} from '../src/workflow.js';

function runWorker(moduleUrl, workerData) {
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.moduleUrl).then(module => {
      try {
        if (workerData.action === 'create') {
          const workflow = module.createWorkflow({
            task: 'Concurrent workflow ' + workerData.index,
            steps: [{ id: 'work', title: 'Work' }]
          }, workerData.options);
          parentPort.postMessage({ ok: true, id: workflow.id });
        } else if (workerData.action === 'approve') {
          const workflow = module.approveWorkflow(workerData.workflowId, workerData.options);
          parentPort.postMessage({ ok: true, status: workflow.status });
        } else if (workerData.action === 'begin') {
          const workflow = module.beginWorkflowStepExecution(workerData.workflowId, workerData.stepId, { provider: 'worker' }, workerData.options);
          parentPort.postMessage({ ok: true, status: workflow.steps.find(step => step.id === workerData.stepId).status });
        } else if (workerData.action === 'record') {
          const workflow = module.recordWorkflowStepExecution(workerData.workflowId, workerData.stepId, workerData.execution, workerData.options);
          parentPort.postMessage({ ok: true, status: workflow.steps.find(step => step.id === workerData.stepId).status });
        }
        else if (workerData.action === 'done') {
          const workflow = module.completeWorkflowStep(workerData.workflowId, workerData.stepId, workerData.options);
          parentPort.postMessage({ ok: true, status: workflow.status });
        }
      } catch (error) {
        parentPort.postMessage({ ok: false, error: error.message });
      }
    }).catch(error => parentPort.postMessage({ ok: false, error: error.message }));
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { ...workerData, moduleUrl } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error('Worker exited with code ' + code)); });
  });
}

test('serializes concurrent workflow creation and preserves the index and event chain', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aipowers-workflow-concurrency-'));
  const options = { rootDir: path.join(root, '.aipowers', 'workflows'), eventPath: path.join(root, '.aipowers', 'events.jsonl') };
  const moduleUrl = pathToFileURL(path.resolve('src/workflow.js')).href;
  try {
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      runWorker(moduleUrl, { action: 'create', index, options })
    ));
    assert.equal(results.filter(result => result.ok).length, 8);
    assert.equal(listWorkflows({ rootDir: options.rootDir }).length, 8);
    assert.equal(readWorkflowEvents({ eventPath: options.eventPath }).length, 8);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects a stale concurrent workflow update instead of overwriting the winning state', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aipowers-workflow-race-'));
  const options = { rootDir: path.join(root, '.aipowers', 'workflows'), eventPath: path.join(root, '.aipowers', 'events.jsonl') };
  const moduleUrl = pathToFileURL(path.resolve('src/workflow.js')).href;
  try {
    const workflow = createWorkflow({ task: 'Concurrent approval', steps: [{ id: 'work', title: 'Work' }] }, options);
    const results = await Promise.all([0, 1].map(index =>
      runWorker(moduleUrl, { action: 'approve', index, workflowId: workflow.id, options })
    ));
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.filter(result => !result.ok).length, 1);
    assert.equal(getWorkflow(workflow.id, options).status, 'approved');
    assert.equal(readWorkflowEvents({ eventPath: options.eventPath }).length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('merges concurrent execution starts and completions for independent steps', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aipowers-parallel-steps-'));
  const options = { rootDir: path.join(root, '.aipowers', 'workflows'), eventPath: path.join(root, '.aipowers', 'events.jsonl') };
  const moduleUrl = pathToFileURL(path.resolve('src/workflow.js')).href;
  try {
    const workflow = createWorkflow({
      task: 'Concurrent independent execution',
      steps: [{ id: 'alpha', title: 'Alpha' }, { id: 'beta', title: 'Beta' }]
    }, options);
    approveWorkflow(workflow.id, options);
    startWorkflow(workflow.id, options);

    const starts = await Promise.all(['alpha', 'beta'].map(stepId =>
      runWorker(moduleUrl, { action: 'begin', workflowId: workflow.id, stepId, options })
    ));
    assert.equal(starts.filter(result => result.ok && result.status === 'running').length, 2, JSON.stringify(starts));

    const completions = await Promise.all(['alpha', 'beta'].map(stepId =>
      runWorker(moduleUrl, {
        action: 'record', workflowId: workflow.id, stepId, options,
        execution: {
          provider: 'worker', exitCode: 0, durationMs: 10,
          outputSha256: '9'.repeat(64), outputBytes: 10
        }
      })
    ));
    assert.equal(completions.filter(result => result.ok && result.status === 'executed').length, 2);
    const finalState = getWorkflow(workflow.id, options);
    assert.deepEqual(finalState.steps.map(step => step.status), ['executed', 'executed']);
    assert.equal(readWorkflowEvents({ eventPath: options.eventPath }).length, 7);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('retries concurrent human completion decisions without losing the final workflow state', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'aipowers-human-review-race-'));
  const options = { rootDir: path.join(root, '.aipowers', 'workflows'), eventPath: path.join(root, '.aipowers', 'events.jsonl') };
  const moduleUrl = pathToFileURL(path.resolve('src/workflow.js')).href;
  try {
    const workflow = createWorkflow({
      task: 'Concurrent human review',
      steps: [{ id: 'alpha', title: 'Alpha' }, { id: 'beta', title: 'Beta' }]
    }, options);
    approveWorkflow(workflow.id, options);
    startWorkflow(workflow.id, options);
    for (const stepId of ['alpha', 'beta']) {
      beginWorkflowStepExecution(workflow.id, stepId, { provider: 'fixture' }, options);
      recordWorkflowStepExecution(workflow.id, stepId, {
        provider: 'fixture', exitCode: 0, durationMs: 1,
        outputSha256: 'b'.repeat(64), outputBytes: 1
      }, options);
    }
    const decisions = await Promise.all(['alpha', 'beta'].map(stepId =>
      runWorker(moduleUrl, { action: 'done', workflowId: workflow.id, stepId, options })
    ));
    assert.equal(decisions.filter(result => result.ok).length, 2);
    assert.equal(getWorkflow(workflow.id, options).status, 'completed');
    assert.deepEqual(getWorkflow(workflow.id, options).steps.map(step => step.status), ['completed', 'completed']);
    assert.equal(readWorkflowEvents({ eventPath: options.eventPath }).length, 9);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
