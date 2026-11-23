import { getWorkflowSchedule } from './workflow.js';
import { executeWorkflowStep, getExecutionAdapter } from './adapters/registry.js';

export async function runReadyWorkflowSteps(provider, workflowId, options = {}, {
  runStep = executeWorkflowStep,
  maxSteps = 25,
  maxConcurrency
} = {}) {
  if (typeof provider !== 'string' || !/^[a-z][a-z0-9-]*$/.test(provider)) throw new TypeError('A valid default execution provider is required.');
  if (typeof workflowId !== 'string' || !workflowId.trim()) throw new TypeError('A workflow ID is required.');
  if (typeof runStep !== 'function') throw new TypeError('runStep must be a function.');
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) {
    throw new TypeError('maxSteps must be an integer from 1 to 100.');
  }
  if (maxConcurrency !== undefined && (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 32)) {
    throw new TypeError('maxConcurrency must be an integer from 1 to 32.');
  }

  let schedule = getWorkflowSchedule(workflowId, options);
  if (schedule.workflowStatus !== 'active') {
    throw new Error('The workflow must be active before ready steps can run.');
  }

  const results = [];
  while (schedule.ready.length && results.length < maxSteps) {
    const batch = [];
    const providerCounts = new Map();
    const globalCapacity = maxConcurrency ?? 32;

    for (const step of schedule.ready) {
      if (batch.length >= Math.min(globalCapacity, maxSteps - results.length)) break;
      const stepProvider = step.provider ?? provider;
      const adapter = getExecutionAdapter(stepProvider);
      if (maxConcurrency !== undefined && adapter && maxConcurrency > adapter.maxConcurrency) {
        throw new Error('Requested concurrency exceeds the registered provider capability for ' + stepProvider + '.');
      }
      if (runStep === executeWorkflowStep && !adapter) {
        throw new Error('No execution adapter is registered for provider: ' + stepProvider + ' (step ' + step.id + ').');
      }
      const providerCapacity = adapter?.maxConcurrency ?? (maxConcurrency ?? 1);
      const effectiveCapacity = maxConcurrency === undefined
        ? providerCapacity
        : Math.min(providerCapacity, maxConcurrency);
      if ((providerCounts.get(stepProvider) ?? 0) >= effectiveCapacity) continue;
      providerCounts.set(stepProvider, (providerCounts.get(stepProvider) ?? 0) + 1);
      batch.push({ ...step, executionProvider: stepProvider });
    }

    if (!batch.length) break;
    const outcomes = await Promise.all(batch.map(async step => {
      try {
        const result = await runStep(step.executionProvider, workflowId, step.id, options);
        return { stepId: step.id, provider: step.executionProvider, status: result.step?.status ?? 'unknown', result };
      } catch (error) {
        return { stepId: step.id, provider: step.executionProvider, status: 'interrupted', error: error.message };
      }
    }));
    results.push(...outcomes);

    const failed = outcomes.some(item =>
      item.error || item.result.execution?.exitCode !== 0 || item.status !== 'executed'
    );
    if (failed) break;

    schedule = getWorkflowSchedule(workflowId, options);
    for (const step of batch) {
      if (schedule.ready.some(item => item.id === step.id)) {
        throw new Error('Execution adapter returned without advancing step ' + step.id + '.');
      }
    }
  }

  schedule = getWorkflowSchedule(workflowId, options);
  return {
    workflowId,
    provider,
    results,
    readyStepIds: schedule.ready.map(step => step.id),
    approvalPendingStepIds: schedule.approvalPending.map(step => step.id),
    waitingStepIds: schedule.waiting.map(step => step.id),
    blockedStepIds: schedule.blocked.map(step => step.id),
    runningStepIds: schedule.running.map(step => step.id),
    reviewStepIds: schedule.review.map(step => step.id),
    failedStepIds: schedule.failed.map(step => step.id),
    completedStepIds: schedule.completed.map(step => step.id),
    limitReached: results.length >= maxSteps && schedule.ready.length > 0
  };
}
