import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultWorkflowRoot = path.join(projectRoot, '.aipowers', 'workflows');
export const defaultWorkflowEventPath = path.join(projectRoot, '.aipowers', 'workflow-events.jsonl');

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function acquireLock(lockPath, { timeoutMs = 5000, staleMs = 300000 } = {}) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let descriptor;
    try {
      descriptor = openSync(lockPath, 'wx');
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      return () => {
        closeSync(descriptor);
        try { unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        try { unlinkSync(lockPath); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
      }
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const owner = JSON.parse(readFileSync(lockPath, 'utf8'));
        stale = Date.now() - Number(owner.createdAt) > staleMs && !processIsAlive(owner.pid);
      } catch {
        try { stale = Date.now() - statSync(lockPath).mtimeMs > staleMs; }
        catch (statError) { if (statError.code === 'ENOENT') continue; throw statError; }
      }
      if (stale) {
        try { unlinkSync(lockPath); } catch (unlinkError) { if (unlinkError.code !== 'ENOENT') throw unlinkError; }
        continue;
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for workflow lock: ' + lockPath);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

function withLocks(lockPaths, callback) {
  const releases = [];
  try {
    for (const lockPath of [...new Set(lockPaths)].sort()) releases.push(acquireLock(lockPath));
    return callback();
  } finally {
    for (const release of releases.reverse()) release();
  }
}
function safeId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw new TypeError('A valid workflow ID is required.');
  return id;
}
function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Unable to read workflow state: ${error.message}`, { cause: error });
  }
}
function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w' });
  renameSync(temporary, file);
}
function workflowFile(id, rootDir) {
  return path.join(rootDir, `${safeId(id)}.json`);
}
function workflowSnapshotFile(id, stateHash, rootDir) {
  if (typeof stateHash !== 'string' || !/^[a-f0-9]{64}$/.test(stateHash)) throw new TypeError('A valid workflow state hash is required.');
  return path.join(rootDir, '.snapshots', safeId(id), `${stateHash}.json`);
}
function writeWorkflowAtomic(file, workflow) {
  const stateHash = hash(JSON.stringify(workflow));
  const stored = { ...workflow, stateHash };
  const snapshotFile = workflowSnapshotFile(workflow.id, stateHash, path.dirname(file));
  mkdirSync(path.dirname(snapshotFile), { recursive: true });
  const existing = readJson(snapshotFile);
  if (existing) {
    const verified = decodeWorkflowStored(existing, workflow.id);
    if (verified._baseStateHash !== stateHash) throw new Error('Immutable workflow snapshot conflict: ' + workflow.id);
  } else {
    writeJsonAtomic(snapshotFile, stored);
  }
  writeJsonAtomic(file, stored);
  return stateHash;
}
function appendEvent(event, eventPath, { expectedPreviousStateHash } = {}) {
  mkdirSync(path.dirname(eventPath), { recursive: true });
  const existingEvents = readWorkflowEvents({ eventPath });
  const previousHash = existingEvents.length ? existingEvents.at(-1).hash : null;
  const previousWorkflowEvent = [...existingEvents].reverse().find(entry => entry.workflowId === event.workflowId);
  const previousStateHash = previousWorkflowEvent?.stateHash ?? null;
  if (expectedPreviousStateHash !== undefined && previousStateHash !== expectedPreviousStateHash) {
    throw new Error('Workflow event checkpoint is out of sync with the previous persisted state.');
  }
  const payload = { ...event, previousHash, previousStateHash };
  const entry = { ...payload, hash: hash(JSON.stringify(payload)) };
  appendFileSync(eventPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' });
  return entry;
}
function decodeWorkflowStored(stored, id) {
  if (!stored) throw new Error(`Workflow not found: ${id}`);
  const { stateHash, ...workflow } = stored;
  if (workflow.id !== id || typeof stateHash !== 'string' || stateHash !== hash(JSON.stringify(workflow))) {
    throw new Error(`Workflow state integrity check failed: ${id}`);
  }
  Object.defineProperty(workflow, '_baseStateHash', { value: stateHash, writable: true, configurable: true, enumerable: false });
  return workflow;
}
function load(id, rootDir) {
  return decodeWorkflowStored(readJson(workflowFile(id, rootDir)), id);
}
function saveAndRecord(workflow, eventType, details, rootDir, eventPath) {
  const file = workflowFile(workflow.id, rootDir);
  return withLocks([file + '.lock', eventPath + '.lock'], () => {
    const current = readJson(file);
    if (!current || current.stateHash !== workflow._baseStateHash) {
      throw new Error('Workflow changed in another process. Reload the workflow and retry this action.');
    }
    const priorEvents = readWorkflowEvents({ eventPath });
    const priorWorkflowEvent = [...priorEvents].reverse().find(event => event.workflowId === workflow.id);
    const previousStateHash = priorWorkflowEvent?.stateHash ?? null;
    if (previousStateHash && previousStateHash !== current.stateHash) {
      throw new Error('Workflow event checkpoint is out of sync with the persisted state. Run workflow audit before continuing.');
    }
    workflow.updatedAt = new Date().toISOString();
    const nextStateHash = writeWorkflowAtomic(file, workflow);
    appendEvent({
      schemaVersion: 1,
      workflowId: workflow.id,
      type: eventType,
      status: workflow.status,
      details,
      timestamp: workflow.updatedAt,
      stateHash: nextStateHash
    }, eventPath, { expectedPreviousStateHash: previousStateHash });
    workflow._baseStateHash = hash(JSON.stringify(workflow));
    return workflow;
  });
}

function mutateWorkflowWithRetry(id, rootDir, eventPath, mutate, maxAttempts = 32) {
  let conflict;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const workflow = load(id, rootDir);
    const event = mutate(workflow);
    if (!event) return workflow;
    try {
      return saveAndRecord(workflow, event.type, event.details, rootDir, eventPath);
    } catch (error) {
      if (!error.message.startsWith('Workflow changed in another process.')) throw error;
      conflict = error;
    }
  }
  throw new Error('Workflow kept changing during update; retry the action.', { cause: conflict });
}

export function createWorkflow({ task, steps }, {
  rootDir = defaultWorkflowRoot,
  eventPath = defaultWorkflowEventPath
} = {}) {
  if (typeof task !== 'string' || !task.trim()) throw new TypeError('A non-empty workflow task is required.');
  if (task.length > 10_000) throw new TypeError('Workflow task must not exceed 10000 characters.');
  if (!Array.isArray(steps) || steps.length === 0) throw new TypeError('At least one workflow step is required.');
  if (steps.length > 100) throw new TypeError('A workflow cannot contain more than 100 steps.');
  const seen = new Set();
  const normalizedSteps = steps.map((step, index) => {
    if (!step || typeof step.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(step.id)) {
      throw new TypeError(`Workflow step ${index + 1} needs a lowercase slug id.`);
    }
    if (seen.has(step.id)) throw new TypeError(`Duplicate workflow step id: ${step.id}`);
    seen.add(step.id);
    if (typeof step.title !== 'string' || !step.title.trim()) throw new TypeError(`Workflow step ${step.id} needs a title.`);
    if (step.title.length > 200) throw new TypeError(`Workflow step ${step.id} title must not exceed 200 characters.`);
    if (step.skillId !== undefined && step.skillId !== null && (typeof step.skillId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(step.skillId))) {
      throw new TypeError(`Workflow step ${step.id} has an invalid skill ID.`);
    }
    if (step.priority !== undefined && (!Number.isInteger(step.priority) || step.priority < -1000 || step.priority > 1000)) {
      throw new TypeError(`Workflow step ${step.id} priority must be an integer from -1000 to 1000.`);
    }
    if (step.reason !== undefined && (typeof step.reason !== 'string' || step.reason.length > 2000)) {
      throw new TypeError(`Workflow step ${step.id} reason must be text no longer than 2000 characters.`);
    }
    if (step.instructions !== undefined && (typeof step.instructions !== 'string' || step.instructions.length > 20_000)) {
      throw new TypeError(`Workflow step ${step.id} instructions must be text no longer than 20000 characters.`);
    }
    if (step.dependsOn !== undefined && !Array.isArray(step.dependsOn)) throw new TypeError(`Workflow step ${step.id} dependencies must be an array.`);
    if (Array.isArray(step.dependsOn) && step.dependsOn.length > 100) throw new TypeError(`Workflow step ${step.id} cannot have more than 100 dependencies.`);
    if (step.provider !== undefined && step.provider !== null && (typeof step.provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(step.provider))) {
      throw new TypeError(`Workflow step ${step.id} has an invalid provider id.`);
    }
    if (step.permissions !== undefined && (!Array.isArray(step.permissions) || step.permissions.length > 10 || step.permissions.some(permission => typeof permission !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(permission)))) {
      throw new TypeError(`Workflow step ${step.id} permissions must be up to 10 lowercase slugs.`);
    }
    if (step.approvalRequired !== undefined && typeof step.approvalRequired !== 'boolean') throw new TypeError(`Workflow step ${step.id} approvalRequired must be a boolean.`);
    const permissions = [...new Set(step.permissions ?? ['workspace-read', 'workspace-write'])];
    const sensitivePermissions = new Set(['network-access', 'external-side-effect', 'database-write', 'deployment', 'destructive', 'secrets-access']);
    const approvalRequired = step.approvalRequired === true || permissions.some(permission => sensitivePermissions.has(permission));
    return {
      id: step.id,
      title: step.title.trim(),
      skillId: typeof step.skillId === 'string' ? step.skillId : null,
      provider: step.provider === undefined || step.provider === null ? null : step.provider,
      permissions,
      approvalRequired,
      approvalStatus: approvalRequired ? 'pending' : 'not-required',
      approvedAt: null,
      priority: Number.isInteger(step.priority) ? step.priority : 0,
      reason: typeof step.reason === 'string' ? step.reason : '',
      instructions: typeof step.instructions === 'string' ? step.instructions : '',
      dependsOn: Array.isArray(step.dependsOn) ? [...new Set(step.dependsOn)] : [],
      status: 'pending',
      completedAt: null,
      executionAttempts: []
    };
  });
  for (const step of normalizedSteps) {
    if (step.dependsOn.some(id => typeof id !== 'string' || !seen.has(id) || id === step.id)) {
      throw new TypeError(`Workflow step ${step.id} has an invalid dependency.`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(normalizedSteps.map(step => [step.id, step]));
  function visit(stepId) {
    if (visiting.has(stepId)) throw new TypeError('Workflow step dependencies must not contain cycles.');
    if (visited.has(stepId)) return;
    visiting.add(stepId);
    for (const dependency of byId.get(stepId).dependsOn) visit(dependency);
    visiting.delete(stepId);
    visited.add(stepId);
  }
  for (const step of normalizedSteps) visit(step.id);
  const now = new Date().toISOString();
  const workflow = {
    schemaVersion: 1,
    id: randomUUID(),
    task: task.trim(),
    status: 'proposed',
    approval: { required: true, approvedAt: null },
    createdAt: now,
    updatedAt: now,
    steps: normalizedSteps
  };
  const indexPath = path.join(rootDir, '.index');
  return withLocks([indexPath + '.lock', eventPath + '.lock'], () => {
    mkdirSync(rootDir, { recursive: true });
    const stateHash = writeWorkflowAtomic(workflowFile(workflow.id, rootDir), workflow);
    addToIndex(workflow.id, rootDir);
    appendEvent({ schemaVersion: 1, workflowId: workflow.id, type: 'created', status: workflow.status, details: { task: workflow.task, stepCount: normalizedSteps.length }, timestamp: now, stateHash }, eventPath, { expectedPreviousStateHash: null });
    return workflow;
  });
}

export function getWorkflow(id, { rootDir = defaultWorkflowRoot } = {}) {
  return load(id, rootDir);
}

export function getWorkflowSchedule(id, options = {}) {
  const workflow = getWorkflow(id, options);
  const steps = workflow.steps.map(step => ({ ...step, dependsOn: step.dependsOn ?? [] }));
  const byId = new Map(steps.map(step => [step.id, step]));
  const dependenciesReady = step => step.dependsOn.every(dep => byId.get(dep)?.status === 'completed');
  const approvalPending = steps.filter(step => step.status === 'pending' && dependenciesReady(step) && step.approvalRequired && step.approvalStatus !== 'approved');
  const ready = steps.filter(step => step.status === 'pending' && dependenciesReady(step) && (!step.approvalRequired || step.approvalStatus === 'approved'));
  const blocked = steps.filter(step => ['pending', 'failed'].includes(step.status) && step.dependsOn.some(dep => ['failed', 'cancelled'].includes(byId.get(dep)?.status)));
  const waiting = steps.filter(step => step.status === 'pending' && !ready.some(item => item.id === step.id) && !approvalPending.some(item => item.id === step.id) && !blocked.some(item => item.id === step.id));
  const running = steps.filter(step => step.status === 'running');
  const review = steps.filter(step => step.status === 'executed');
  const failed = steps.filter(step => step.status === 'failed' && !blocked.some(item => item.id === step.id));
  const completed = steps.filter(step => step.status === 'completed');
  return { workflowId: workflow.id, workflowStatus: workflow.status, ready, approvalPending, waiting, blocked, running, review, failed, completed, steps };
}

export function listWorkflows({ rootDir = defaultWorkflowRoot } = {}) {
  let files;
  try { files = readFileSync(path.join(rootDir, '.index'), 'utf8').split(/\r?\n/).filter(Boolean); }
  catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
  // State files are enumerated by the maintained index to avoid scanning unrelated files.
  return files.map(id => load(id, rootDir)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function addToIndex(id, rootDir) {
  const index = path.join(rootDir, '.index');
  let ids = [];
  try { ids = readFileSync(index, 'utf8').split(/\r?\n/).filter(Boolean); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!ids.includes(id)) appendFileSync(index, `${id}\n`, 'utf8');
}

export function approveWorkflow(id, options = {}) {
  const rootDir = options.rootDir ?? defaultWorkflowRoot;
  const eventPath = options.eventPath ?? defaultWorkflowEventPath;
  return mutateWorkflowWithRetry(id, rootDir, eventPath, workflow => {
    if (workflow.status !== 'proposed') throw new Error(`Cannot approve a workflow in ${workflow.status} state.`);
    workflow.status = 'approved';
    workflow.approval.approvedAt = new Date().toISOString();
    return { type: 'approved', details: {} };
  });
}

export function startWorkflow(id, options = {}) {
  const rootDir = options.rootDir ?? defaultWorkflowRoot;
  const eventPath = options.eventPath ?? defaultWorkflowEventPath;
  return mutateWorkflowWithRetry(id, rootDir, eventPath, workflow => {
    if (workflow.status !== 'approved') throw new Error('Workflow must be explicitly approved before it can start.');
    workflow.status = 'active';
    return { type: 'started', details: {} };
  });
}

export function completeWorkflowStep(id, stepId, options = {}) {
  const rootDir = options.rootDir ?? defaultWorkflowRoot;
  const eventPath = options.eventPath ?? defaultWorkflowEventPath;
  return mutateWorkflowWithRetry(id, rootDir, eventPath, workflow => {
    if (workflow.status !== 'active') throw new Error('Only active workflows can advance steps.');
    const step = workflow.steps.find(item => item.id === stepId);
    if (!step) throw new Error(`Workflow step not found: ${stepId}`);
    if (!['pending', 'executed'].includes(step.status)) throw new Error(`Workflow step ${stepId} is already ${step.status}.`);
    if (step.approvalRequired && step.approvalStatus !== 'approved') throw new Error(`Workflow step ${stepId} requires separate approval before completion.`);
    const incompleteDependencies = (step.dependsOn ?? []).filter(dep => workflow.steps.find(item => item.id === dep)?.status !== 'completed');
    if (incompleteDependencies.length) throw new Error(`Workflow step ${stepId} is waiting for dependencies: ${incompleteDependencies.join(', ')}.`);
    step.status = 'completed';
    step.completedAt = new Date().toISOString();
    if (workflow.steps.every(item => item.status === 'completed')) workflow.status = 'completed';
    return { type: 'step-completed', details: { stepId, workflowCompleted: workflow.status === 'completed' } };
  });
}

export function blockWorkflow(id, reason, options = {}) {
  const rootDir = options.rootDir ?? defaultWorkflowRoot;
  const eventPath = options.eventPath ?? defaultWorkflowEventPath;
  if (typeof reason !== 'string' || !reason.trim()) throw new TypeError('A blocking reason is required.');
  return mutateWorkflowWithRetry(id, rootDir, eventPath, workflow => {
    if (workflow.status !== 'active') throw new Error('Only active workflows can be blocked.');
    workflow.status = 'blocked';
    workflow.blockedReason = reason.trim();
    return { type: 'blocked', details: { reason: workflow.blockedReason } };
  });
}

export function resumeWorkflow(id, options = {}) {
  const rootDir = options.rootDir ?? defaultWorkflowRoot;
  const eventPath = options.eventPath ?? defaultWorkflowEventPath;
  return mutateWorkflowWithRetry(id, rootDir, eventPath, workflow => {
    if (workflow.status !== 'blocked') throw new Error('Only blocked workflows can be resumed.');
    workflow.status = 'active';
    workflow.blockedReason = null;
    return { type: 'resumed', details: {} };
  });
}

export function cancelWorkflow(id, reason = 'Cancelled by user', options = {}) {
  const rootDir = options.rootDir ?? defaultWorkflowRoot;
  const eventPath = options.eventPath ?? defaultWorkflowEventPath;
  return mutateWorkflowWithRetry(id, rootDir, eventPath, workflow => {
    if (!['proposed', 'approved', 'active', 'blocked'].includes(workflow.status)) {
      throw new Error(`Cannot cancel a workflow in ${workflow.status} state.`);
    }
    workflow.status = 'cancelled';
    return { type: 'cancelled', details: { reason } };
  });
}

export function readWorkflowEvents({ eventPath = defaultWorkflowEventPath } = {}) {
  let lines;
  try { lines = readFileSync(eventPath, 'utf8').split(/\r?\n/).filter(Boolean); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const events = [];
  const stateHashes = new Map();
  for (const [index, line] of lines.entries()) {
    let entry;
    try { entry = JSON.parse(line); } catch { throw new Error(`Invalid workflow event JSON at row ${index + 1}.`); }
    const { hash: storedHash, ...payload } = entry;
    const expectedPrevious = index === 0 ? null : events[index - 1].hash;
    if (payload.previousHash !== expectedPrevious || storedHash !== hash(JSON.stringify(payload))) {
      throw new Error(`Workflow event ledger integrity check failed at row ${index + 1}.`);
    }
    if (typeof entry.stateHash === 'string') {
      const expectedStateParent = stateHashes.get(entry.workflowId) ?? null;
      if (!/^[a-f0-9]{64}$/.test(entry.stateHash) || entry.previousStateHash !== expectedStateParent) {
        throw new Error(`Workflow state checkpoint chain failed at row ${index + 1}.`);
      }
      stateHashes.set(entry.workflowId, entry.stateHash);
    } else if (entry.previousStateHash !== undefined) {
      throw new Error(`Workflow state checkpoint is incomplete at row ${index + 1}.`);
    }
    events.push(entry);
  }
  return events;
}

export function beginWorkflowStepExecution(id, stepId, { provider = 'codex' } = {}, options = {}) {
  const rootDir = options.rootDir ?? defaultWorkflowRoot;
  const eventPath = options.eventPath ?? defaultWorkflowEventPath;
  if (typeof provider !== 'string' || !provider.trim()) throw new TypeError('Execution provider is required.');
  return mutateWorkflowWithRetry(id, rootDir, eventPath, workflow => {
    if (workflow.status !== 'active') throw new Error('Only active workflows can run agent steps.');
    const step = workflow.steps.find(item => item.id === stepId);
    if (!step) throw new Error(`Workflow step not found: ${stepId}`);
    if (step.status !== 'pending') throw new Error(`Workflow step ${stepId} is not pending.`);
    if (step.approvalRequired && step.approvalStatus !== 'approved') throw new Error(`Workflow step ${stepId} requires separate approval before execution.`);
    if (step.provider && step.provider !== provider) throw new Error(`Workflow step ${stepId} is assigned to provider ${step.provider}, not ${provider}.`);
    const incompleteDependencies = (step.dependsOn ?? []).filter(dep => workflow.steps.find(item => item.id === dep)?.status !== 'completed');
    if (incompleteDependencies.length) throw new Error(`Workflow step ${stepId} is waiting for dependencies: ${incompleteDependencies.join(', ')}.`);
    step.executionAttempts ??= [];
    const attempt = { attempt: step.executionAttempts.length + 1, provider, status: 'running', startedAt: new Date().toISOString(), completedAt: null };
    step.executionAttempts.push(attempt);
    step.status = 'running';
    return { type: 'step-execution-started', details: { stepId, ...attempt } };
  });
}

export function recoverWorkflowExecutions(id, options = {}) {
  if (options.confirmOrphaned !== true) throw new Error('Recovery can mark live work as failed. Confirm that the provider process is no longer running with confirmOrphaned: true.');
  const rootDir = options.rootDir ?? defaultWorkflowRoot;
  const eventPath = options.eventPath ?? defaultWorkflowEventPath;
  let recovered = [];
  let stillRunning = [];
  const result = mutateWorkflowWithRetry(id, rootDir, eventPath, workflow => {
    const interrupted = [];
    const activeProcesses = [];
    for (const step of workflow.steps) {
      if (step.status !== 'running') continue;
      const attempt = step.executionAttempts?.at(-1);
      if (attempt?.processId && processIsAlive(attempt.processId)) {
        activeProcesses.push(step.id);
        continue;
      }
      if (attempt?.status === 'running') {
        attempt.status = 'interrupted';
        attempt.completedAt = new Date().toISOString();
        attempt.interruptionReason = 'No completion record was present and the attached provider process is no longer running.';
      }
      step.status = 'failed';
      step.interruptionReason = 'Execution was interrupted; inspect the workspace before retrying.';
      interrupted.push(step.id);
    }
    recovered = interrupted;
    stillRunning = activeProcesses;
    if (!interrupted.length) return null;
    return { type: 'execution-recovery', details: { interruptedStepIds: interrupted, stillRunningStepIds: activeProcesses } };
  });
  return { workflow: result, recovered, stillRunning };
}

export function recordWorkflowStepExecution(id, stepId, execution, options = {}) {
  const rootDir = options.rootDir ?? defaultWorkflowRoot;
  const eventPath = options.eventPath ?? defaultWorkflowEventPath;
  if (!execution || !Number.isInteger(execution.exitCode) || !Number.isFinite(execution.durationMs) || execution.durationMs < 0) {
    throw new TypeError('Execution result needs an integer exitCode and non-negative durationMs.');
  }
  if (typeof execution.provider !== 'string' || !execution.provider.trim()) throw new TypeError('Execution provider is required.');
  if (typeof execution.outputSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(execution.outputSha256)) {
    throw new TypeError('Execution outputSha256 must be a SHA-256 hex digest.');
  }
  if (!Number.isInteger(execution.outputBytes) || execution.outputBytes < 0) throw new TypeError('Execution outputBytes must be a non-negative integer.');
  if (execution.timedOut !== undefined && typeof execution.timedOut !== 'boolean') throw new TypeError('Execution timedOut must be a boolean.');
  if (execution.outputTruncated !== undefined && typeof execution.outputTruncated !== 'boolean') throw new TypeError('Execution outputTruncated must be a boolean.');

  return mutateWorkflowWithRetry(id, rootDir, eventPath, workflow => {
    if (workflow.status !== 'active') throw new Error('Only active workflows can run agent steps.');
    const step = workflow.steps.find(item => item.id === stepId);
    if (!step) throw new Error(`Workflow step not found: ${stepId}`);
    if (!['pending', 'running'].includes(step.status)) throw new Error(`Workflow step ${stepId} is not pending or running.`);
    if (step.approvalRequired && step.approvalStatus !== 'approved') throw new Error(`Workflow step ${stepId} requires separate approval before recording execution.`);
    if (step.provider && step.provider !== execution.provider) throw new Error(`Workflow step ${stepId} is assigned to provider ${step.provider}, not ${execution.provider}.`);
    const incompleteDependencies = (step.dependsOn ?? []).filter(dep => workflow.steps.find(item => item.id === dep)?.status !== 'completed');
    if (incompleteDependencies.length) throw new Error(`Workflow step ${stepId} is waiting for dependencies: ${incompleteDependencies.join(', ')}.`);
    step.execution = {
      provider: execution.provider,
      exitCode: execution.exitCode,
      durationMs: execution.durationMs,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      outputSha256: execution.outputSha256,
      outputBytes: execution.outputBytes,
      timedOut: execution.timedOut === true,
      outputTruncated: execution.outputTruncated === true
    };
    step.status = execution.exitCode === 0 ? 'executed' : 'failed';
    step.executionAttempts ??= [];
    const latestAttempt = step.executionAttempts.at(-1);
    if (latestAttempt && latestAttempt.status === 'running') {
      latestAttempt.status = step.status;
      latestAttempt.completedAt = execution.completedAt ?? new Date().toISOString();
      latestAttempt.exitCode = execution.exitCode;
      latestAttempt.outputSha256 = execution.outputSha256;
    } else {
      step.executionAttempts.push({ attempt: step.executionAttempts.length + 1, provider: execution.provider, status: step.status, startedAt: execution.startedAt ?? null, completedAt: execution.completedAt ?? new Date().toISOString(), exitCode: execution.exitCode, outputSha256: execution.outputSha256 });
    }
    step.interruptionReason = null;
    return {
      type: step.status === 'executed' ? 'step-executed' : 'step-execution-failed',
      details: { stepId, provider: execution.provider, exitCode: execution.exitCode,
        outputSha256: execution.outputSha256, outputBytes: execution.outputBytes,
        timedOut: execution.timedOut === true, outputTruncated: execution.outputTruncated === true }
    };
  });
}

export function retryWorkflowStep(id, stepId, options = {}) {
  const rootDir = options.rootDir ?? defaultWorkflowRoot;
  const eventPath = options.eventPath ?? defaultWorkflowEventPath;
  return mutateWorkflowWithRetry(id, rootDir, eventPath, workflow => {
    if (workflow.status !== 'active') throw new Error('Only active workflows can retry steps.');
    const step = workflow.steps.find(item => item.id === stepId);
    if (!step) throw new Error(`Workflow step not found: ${stepId}`);
    if (step.status !== 'failed') throw new Error(`Workflow step ${stepId} is not failed.`);
    step.status = 'pending';
    step.execution = null;
    step.interruptionReason = null;
    if (step.approvalRequired) {
      step.approvalStatus = 'pending';
      step.approvedAt = null;
    }
    return { type: 'step-retry-authorized', details: { stepId } };
  });
}

export function auditWorkflowStore({
  rootDir = defaultWorkflowRoot,
  eventPath = defaultWorkflowEventPath
} = {}) {
  return withLocks([path.join(rootDir, '.index') + '.lock', eventPath + '.lock'], () => {
  const issues = [];
  const warnings = [];
  let indexedIds = [];
  try {
    indexedIds = readFileSync(path.join(rootDir, '.index'), 'utf8').split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if (error.code !== 'ENOENT') issues.push('Unable to read workflow index: ' + error.message);
  }
  const uniqueIds = new Set(indexedIds);
  if (uniqueIds.size !== indexedIds.length) issues.push('Workflow index contains duplicate IDs.');
  for (const id of uniqueIds) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) issues.push('Workflow index contains an invalid ID: ' + id);
  }

  let events = [];
  try { events = readWorkflowEvents({ eventPath }); }
  catch (error) { issues.push('Workflow event ledger is invalid: ' + error.message); }

  const latestEvents = new Map();
  for (const event of events) latestEvents.set(event.workflowId, event);
  const workflows = [];
  for (const id of uniqueIds) {
    try {
      const workflow = load(id, rootDir);
      workflows.push(workflow);
      const latest = latestEvents.get(id);
      if (!latest) issues.push('Workflow ' + id + ' has no audit events.');
      else if (latest.stateHash && latest.stateHash !== workflow._baseStateHash) {
        issues.push('Workflow ' + id + ' state snapshot does not match its latest audit checkpoint.');
      }
      const verifiedSnapshots = new Set();
      for (const event of events) {
        if (event.workflowId !== id || !event.stateHash || verifiedSnapshots.has(event.stateHash)) continue;
        verifiedSnapshots.add(event.stateHash);
        try {
          const checkpoint = decodeWorkflowStored(readJson(workflowSnapshotFile(id, event.stateHash, rootDir)), id);
          if (checkpoint._baseStateHash !== event.stateHash) issues.push('Workflow ' + id + ' immutable snapshot hash does not match its audit checkpoint.');
        } catch (error) {
          issues.push('Workflow ' + id + ' immutable snapshot is unavailable or invalid: ' + error.message);
        }
      }
      if (workflow.status === 'completed' && workflow.steps.some(step => step.status !== 'completed')) {
        issues.push('Workflow ' + id + ' is marked completed but has unfinished steps.');
      }
      for (const step of workflow.steps) {
        if (step.status !== 'running') continue;
        const attempt = step.executionAttempts?.at(-1);
        if (attempt?.processId && processIsAlive(attempt.processId)) {
          warnings.push('Workflow ' + id + ' step ' + step.id + ' provider PID ' + attempt.processId + ' still appears alive; recovery will skip it.');
        } else {
          warnings.push('Workflow ' + id + ' step ' + step.id + ' has a running attempt; verify the provider process before recovery.');
        }
      }
      if (latest && !latest.stateHash) warnings.push('Workflow ' + id + ' uses a legacy audit event without state checkpoints.');
    } catch (error) {
      issues.push('Workflow ' + id + ' could not be loaded: ' + error.message);
    }
  }
  for (const id of latestEvents.keys()) {
    if (!uniqueIds.has(id)) issues.push('Audit history references a workflow missing from the index: ' + id);
  }

  let snapshotIds = [];
  try {
    snapshotIds = readdirSync(rootDir).filter(name => /^[0-9a-f-]{36}\.json$/i.test(name)).map(name => name.slice(0, -5));
  } catch (error) {
    if (error.code !== 'ENOENT') issues.push('Unable to inspect workflow snapshots: ' + error.message);
  }
  for (const id of snapshotIds) if (!uniqueIds.has(id)) warnings.push('Workflow snapshot ' + id + ' is not listed in the index.');

  return {
    healthy: issues.length === 0,
    workflowCount: workflows.length,
    eventCount: events.length,
    statuses: workflows.reduce((result, workflow) => {
      result[workflow.status] = (result[workflow.status] ?? 0) + 1;
      return result;
    }, {}),
    issues,
    warnings,
    auditedAt: new Date().toISOString()
  };
  });
}

export function migrateWorkflowCheckpoint(id, options = {}) {
  const rootDir = options.rootDir ?? defaultWorkflowRoot;
  const eventPath = options.eventPath ?? defaultWorkflowEventPath;
  const file = workflowFile(id, rootDir);
  return withLocks([file + '.lock', eventPath + '.lock'], () => {
    const workflow = load(id, rootDir);
    const events = readWorkflowEvents({ eventPath });
    const workflowEvents = events.filter(event => event.workflowId === id);
    const latest = workflowEvents.at(-1);
    if (!latest) throw new Error('Cannot migrate a workflow without an existing audit event.');
    if (latest.stateHash) {
      if (latest.stateHash !== workflow._baseStateHash) throw new Error('Workflow state and latest audit checkpoint do not match.');
      const snapshotFile = workflowSnapshotFile(id, latest.stateHash, rootDir);
      const snapshotCreated = !readJson(snapshotFile);
      if (snapshotCreated) writeWorkflowAtomic(file, workflow);
      return { workflow, migrated: false, snapshotCreated };
    }
    if (workflowEvents.some(event => event.stateHash)) {
      throw new Error('Mixed legacy/checkpoint history requires manual audit before migration.');
    }
    const snapshotHash = writeWorkflowAtomic(file, workflow);
    if (snapshotHash !== workflow._baseStateHash) throw new Error('Legacy workflow snapshot changed during checkpoint migration.');
    appendEvent({
      schemaVersion: 1,
      workflowId: id,
      type: 'state-checkpoint-migrated',
      status: workflow.status,
      details: { legacyEventCount: workflowEvents.length },
      timestamp: new Date().toISOString(),
      stateHash: workflow._baseStateHash
    }, eventPath, { expectedPreviousStateHash: null });
    return { workflow, migrated: true };
  });
}

export function attachWorkflowExecutionProcess(id, stepId, { provider, processId } = {}, options = {}) {
  const rootDir = options.rootDir ?? defaultWorkflowRoot;
  const eventPath = options.eventPath ?? defaultWorkflowEventPath;
  if (typeof provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(provider)) throw new TypeError('A valid execution provider is required.');
  if (!Number.isInteger(processId) || processId < 1) throw new TypeError('A valid provider process ID is required.');
  return mutateWorkflowWithRetry(id, rootDir, eventPath, workflow => {
    if (workflow.status !== 'active') throw new Error('Only active workflows can attach provider processes.');
    const step = workflow.steps.find(item => item.id === stepId);
    if (!step || step.status !== 'running') throw new Error('A running workflow step is required to attach a provider process.');
    const attempt = step.executionAttempts?.at(-1);
    if (!attempt || attempt.status !== 'running' || attempt.provider !== provider) {
      throw new Error('The latest running execution attempt does not match the provider.');
    }
    if (attempt.processId && attempt.processId !== processId) throw new Error('A different provider process is already attached to this attempt.');
    attempt.processId = processId;
    attempt.processAttachedAt = new Date().toISOString();
    return { type: 'step-process-attached', details: { stepId, provider, processId } };
  });
}

export function superviseWorkflowExecutions(id, options = {}) {
  const rootDir = options.rootDir ?? defaultWorkflowRoot;
  const eventPath = options.eventPath ?? defaultWorkflowEventPath;
  let interrupted = [];
  let stillRunning = [];
  let untracked = [];
  const workflow = mutateWorkflowWithRetry(id, rootDir, eventPath, current => {
    const recovered = [];
    const alive = [];
    const unknown = [];
    for (const step of current.steps) {
      if (step.status !== 'running') continue;
      const attempt = step.executionAttempts?.at(-1);
      if (!attempt?.processId) {
        unknown.push(step.id);
        continue;
      }
      if (processIsAlive(attempt.processId)) {
        alive.push(step.id);
        continue;
      }
      if (attempt.status === 'running') {
        attempt.status = 'interrupted';
        attempt.completedAt = new Date().toISOString();
        attempt.interruptionReason = 'The attached provider process is no longer running.';
      }
      step.status = 'failed';
      step.interruptionReason = 'Provider process exited before a completion record was persisted.';
      recovered.push(step.id);
    }
    interrupted = recovered;
    stillRunning = alive;
    untracked = unknown;
    if (!recovered.length) return null;
    return { type: 'process-supervision', details: { interruptedStepIds: recovered, stillRunningStepIds: alive, untrackedStepIds: unknown } };
  });
  return { workflow, interrupted, stillRunning, untracked };
}

export function restoreWorkflowSnapshot(id, options = {}) {
  const rootDir = options.rootDir ?? defaultWorkflowRoot;
  const eventPath = options.eventPath ?? defaultWorkflowEventPath;
  const file = workflowFile(id, rootDir);
  return withLocks([file + '.lock', eventPath + '.lock'], () => {
    const events = readWorkflowEvents({ eventPath });
    const workflowEvents = events.filter(event => event.workflowId === id);
    const latest = workflowEvents.at(-1);
    if (!latest?.stateHash) throw new Error('A verified state checkpoint is required before snapshot restoration.');
    const snapshot = decodeWorkflowStored(readJson(workflowSnapshotFile(id, latest.stateHash, rootDir)), id);
    if (snapshot._baseStateHash !== latest.stateHash) throw new Error('Immutable workflow snapshot does not match the latest audit checkpoint.');

    let currentMatches = false;
    try { currentMatches = load(id, rootDir)._baseStateHash === latest.stateHash; }
    catch { currentMatches = false; }
    if (currentMatches) return { workflow: snapshot, restored: false };

    const restoredHash = writeWorkflowAtomic(file, snapshot);
    if (restoredHash !== latest.stateHash) throw new Error('Restored workflow snapshot hash does not match the latest audit checkpoint.');
    appendEvent({
      schemaVersion: 1,
      workflowId: id,
      type: 'snapshot-restored',
      status: snapshot.status,
      details: { stateHash: restoredHash },
      timestamp: new Date().toISOString(),
      stateHash: restoredHash
    }, eventPath, { expectedPreviousStateHash: latest.stateHash });
    return { workflow: snapshot, restored: true };
  });
}

export function replayWorkflowHistory(id, options = {}) {
  const rootDir = options.rootDir ?? defaultWorkflowRoot;
  const eventPath = options.eventPath ?? defaultWorkflowEventPath;
  const events = readWorkflowEvents({ eventPath }).filter(event => event.workflowId === id);
  if (!events.length) throw new Error('No workflow history exists for: ' + id);
  return events.map((event, index) => {
    if (!event.stateHash) {
      return { sequence: index + 1, timestamp: event.timestamp, type: event.type, status: event.status, details: event.details, legacy: true, snapshot: null };
    }
    const snapshot = decodeWorkflowStored(readJson(workflowSnapshotFile(id, event.stateHash, rootDir)), id);
    if (snapshot._baseStateHash !== event.stateHash || snapshot.status !== event.status) {
      throw new Error('Workflow replay snapshot does not match event ' + (index + 1) + ' for ' + id + '.');
    }
    return {
      sequence: index + 1,
      timestamp: event.timestamp,
      type: event.type,
      status: event.status,
      details: event.details,
      legacy: false,
      snapshot
    };
  });
}

export function approveWorkflowStep(id, stepId, options = {}) {
  const rootDir = options.rootDir ?? defaultWorkflowRoot;
  const eventPath = options.eventPath ?? defaultWorkflowEventPath;
  return mutateWorkflowWithRetry(id, rootDir, eventPath, workflow => {
    if (workflow.status !== 'active') throw new Error('Workflow must be active before approving a sensitive step.');
    const step = workflow.steps.find(item => item.id === stepId);
    if (!step) throw new Error('Workflow step not found: ' + stepId);
    if (!step.approvalRequired) throw new Error('This workflow step does not require separate approval.');
    if (step.status !== 'pending') throw new Error('Only pending workflow steps can receive approval.');
    const incompleteDependencies = step.dependsOn.filter(dep => workflow.steps.find(item => item.id === dep)?.status !== 'completed');
    if (incompleteDependencies.length) throw new Error('Approve dependencies first: ' + incompleteDependencies.join(', ') + '.');
    if (step.approvalStatus === 'approved') throw new Error('Workflow step is already approved.');
    step.approvalStatus = 'approved';
    step.approvedAt = new Date().toISOString();
    return { type: 'step-approved', details: { stepId, permissions: step.permissions } };
  });
}
