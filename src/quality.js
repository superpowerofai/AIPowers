import path from 'node:path';
import { getWorkflow, readWorkflowEvents } from './workflow.js';
import { readExecutionLedger } from './evidence.js';

export function evaluateWorkflowCompletion(workflowId, {
  rootDir = path.join(process.cwd(), '.aipowers', 'workflows'),
  eventPath = path.join(process.cwd(), '.aipowers', 'workflow-events.jsonl'),
  evidencePath = path.join(process.cwd(), '.aipowers', 'execution-ledger.jsonl')
} = {}) {
  const blockers = [];
  const workflow = getWorkflow(workflowId, { rootDir });
  const events = readWorkflowEvents({ eventPath });
  const workflowEvents = events.filter(event => event.workflowId === workflowId);

  if (!workflowEvents.length) blockers.push('Workflow has no valid audit events.');
  else if (workflowEvents.at(-1).stateHash !== workflow._baseStateHash) {
    blockers.push('Workflow state and audit history are out of sync; inspect the last transition before accepting completion.');
  }
  if (workflow.status !== 'completed') blockers.push(`Workflow status is "${workflow.status}", not "completed".`);
  const unfinished = workflow.steps.filter(step => step.status !== 'completed');
  if (unfinished.length) blockers.push(`Unfinished steps: ${unfinished.map(step => step.id).join(', ')}.`);

  const evidence = readExecutionLedger({ ledgerPath: evidencePath, limit: 100 });
  const latest = evidence.at(-1) ?? null;
  if (!latest) blockers.push('No verification evidence has been recorded.');
  else {
    if (latest.status !== 'passed' || latest.exitCode !== 0) blockers.push('The latest verification did not pass.');
    if (latest.timedOut) blockers.push('The latest verification timed out.');
    if (latest.outputTruncated) blockers.push('The latest verification output was truncated.');
    if (Date.parse(latest.completedAt) < Date.parse(workflow.updatedAt)) {
      blockers.push('Verification evidence is older than the latest workflow update; rerun verification.');
    }
  }

  return {
    workflowId,
    ready: blockers.length === 0,
    workflowStatus: workflow.status,
    completedSteps: workflow.steps.filter(step => step.status === 'completed').length,
    totalSteps: workflow.steps.length,
    latestEvidenceHash: latest?.hash ?? null,
    latestEvidenceStatus: latest?.status ?? 'missing',
    blockers,
    evaluatedAt: new Date().toISOString()
  };
}
