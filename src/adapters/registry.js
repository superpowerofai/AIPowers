import { runCodexWorkflowStep } from './codex.js';
import { getWorkflow } from '../workflow.js';

const adapters = new Map();

export function registerExecutionAdapter(adapter) {
  if (!adapter || typeof adapter.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(adapter.id)) {
    throw new TypeError('Execution adapter needs a lowercase provider id.');
  }
  if (typeof adapter.runStep !== 'function') throw new TypeError('Execution adapter must implement runStep().');
  const maxConcurrency = adapter.maxConcurrency ?? 1;
  const declaredPermissions = adapter.permissions ?? ['workspace-read', 'workspace-write'];
  if (!Array.isArray(declaredPermissions) || declaredPermissions.length > 20 || declaredPermissions.some(permission => typeof permission !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(permission))) {
    throw new TypeError('Adapter permissions must be up to 20 lowercase slugs.');
  }
  const permissions = [...new Set(declaredPermissions)];
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 32) {
    throw new TypeError('Adapter maxConcurrency must be an integer from 1 to 32.');
  }
  if (adapters.has(adapter.id)) throw new Error('Execution adapter already registered: ' + adapter.id);
  adapters.set(adapter.id, Object.freeze({ id: adapter.id, runStep: adapter.runStep, maxConcurrency, permissions }));
  return adapters.get(adapter.id);
}

export function getExecutionAdapter(provider) {
  return adapters.get(provider) ?? null;
}

export function listExecutionAdapters() {
  return [...adapters.values()].map(adapter => ({ id: adapter.id, maxConcurrency: adapter.maxConcurrency, permissions: [...adapter.permissions] }));
}

export async function executeWorkflowStep(provider, workflowId, stepId, options = {}) {
  const adapter = getExecutionAdapter(provider);
  if (!adapter) throw new Error('No execution adapter is registered for provider: ' + provider);
  const workflow = getWorkflow(workflowId, { rootDir: options.rootDir });
  const step = workflow.steps.find(item => item.id === stepId);
  if (!step) throw new Error('Workflow step not found: ' + stepId);
  const unsupported = (step.permissions ?? ['workspace-read', 'workspace-write']).filter(permission => !adapter.permissions.includes(permission));
  if (unsupported.length) throw new Error('Provider ' + provider + ' does not grant required permissions: ' + unsupported.join(', ') + '.');
  return adapter.runStep(workflowId, stepId, options);
}

registerExecutionAdapter({ id: 'codex', runStep: runCodexWorkflowStep });
