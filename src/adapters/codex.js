import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { getWorkflow, beginWorkflowStepExecution, attachWorkflowExecutionProcess, recordWorkflowStepExecution } from '../workflow.js';

const MAX_CAPTURE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function buildCodexStepPrompt(workflow, step) {
  const sections = [
    'You are executing one approved AIPowers workflow step.',
    'Workflow task: ' + workflow.task,
    'Step: ' + step.title,
    step.skillId ? 'AIPowers skill: ' + step.skillId : '',
    step.reason ? 'Selection reason: ' + step.reason : '',
    step.instructions ? 'Workflow instructions:\n' + step.instructions : '',
    'Work only within the supplied project directory and the configured sandbox.',
    'Do not claim tests passed unless you actually ran them and observed a successful result.',
    'Do not make external purchases, send messages, publish content, or perform destructive actions.',
    'At the end, summarize files changed, commands run, and any remaining blockers.'
  ];
  return sections.filter(Boolean).join('\n\n');
}

export async function runCodexWorkflowStep(workflowId, stepId, {
  cwd = process.cwd(),
  codexPath = process.platform === 'win32' ? 'codex.exe' : 'codex',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  rootDir = path.join(cwd, '.aipowers', 'workflows'),
  eventPath = path.join(cwd, '.aipowers', 'workflow-events.jsonl'),
  spawnImpl = spawn
} = {}) {
  if (typeof cwd !== 'string' || !cwd.trim()) throw new TypeError('A project working directory is required.');
  if (typeof codexPath !== 'string' || !codexPath.trim()) throw new TypeError('A Codex executable path is required.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 900_000) throw new TypeError('timeoutMs must be between 1 and 900000 ms.');

  const workflow = getWorkflow(workflowId, { rootDir });
  if (workflow.status !== 'active') throw new Error('The workflow must be approved and started before Codex can execute a step.');
  const step = workflow.steps.find(item => item.id === stepId);
  if (!step) throw new Error('Workflow step not found: ' + stepId);
  const unsupportedPermissions = (step.permissions ?? ['workspace-read', 'workspace-write']).filter(permission => !['workspace-read', 'workspace-write'].includes(permission));
  if (unsupportedPermissions.length) throw new Error('Codex workspace-write sandbox does not grant: ' + unsupportedPermissions.join(', ') + '.');
  if (step.provider && step.provider !== 'codex') throw new Error(`Workflow step ${stepId} is assigned to provider ${step.provider}, not codex.`);
  if (step.status !== 'pending') throw new Error('Only pending workflow steps can be sent to Codex.');
  const incompleteDependencies = (step.dependsOn ?? []).filter(dep => workflow.steps.find(item => item.id === dep)?.status !== 'completed');
  if (incompleteDependencies.length) throw new Error(`Workflow step ${stepId} is not ready; waiting for: ${incompleteDependencies.join(', ')}.`);

  const prompt = buildCodexStepPrompt(workflow, step);
  const args = ['exec', '--ephemeral', '--sandbox', 'workspace-write', '--cd', path.resolve(cwd), '--json', '-'];
  beginWorkflowStepExecution(workflowId, stepId, { provider: 'codex' }, { rootDir, eventPath });
  const startedAt = new Date().toISOString();
  const start = process.hrtime.bigint();

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;
    const persistLaunchFailure = error => {
      const completedAt = new Date().toISOString();
      const message = 'Unable to launch Codex CLI: ' + error.message;
      const execution = {
        provider: 'codex', exitCode: 127,
        durationMs: Number(process.hrtime.bigint() - start) / 1e6,
        startedAt, completedAt,
        outputSha256: createHash('sha256').update(message, 'utf8').digest('hex'),
        outputBytes: Buffer.byteLength(message, 'utf8'),
        timedOut: false, outputTruncated: false
      };
      try {
        recordWorkflowStepExecution(workflowId, stepId, execution, { rootDir, eventPath });
        reject(new Error(message, { cause: error }));
      } catch (recordError) {
        reject(new Error(message + '; additionally failed to persist execution failure: ' + recordError.message, { cause: recordError }));
      }
    };
    let child;
    try {
      child = spawnImpl(codexPath, args, { cwd: path.resolve(cwd), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      settled = true;
      persistLaunchFailure(error);
      return;
    }
    if (Number.isInteger(child.pid) && child.pid > 0) {
      try {
        attachWorkflowExecutionProcess(workflowId, stepId, { provider: 'codex', processId: child.pid }, { rootDir, eventPath });
      } catch (error) {
        try { child.kill(); } catch {}
        settled = true;
        reject(new Error('Codex process launched but could not be attached to its workflow attempt: ' + error.message, { cause: error }));
        return;
      }
    }

    const append = (current, chunk) => {
      const remaining = MAX_CAPTURE_BYTES - Buffer.byteLength(current, 'utf8');
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (buffer.length > remaining) outputTruncated = true;
      return remaining > 0 ? current + buffer.subarray(0, remaining).toString('utf8') : current;
    };
    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk); });
    let timer;
    child.once('error', error => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      persistLaunchFailure(error);
    });
    timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const completedAt = new Date().toISOString();
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const exitCode = timedOut ? 124 : (Number.isInteger(code) ? code : 1);
      const combined = stdout + stderr;
      const execution = {
        provider: 'codex',
        exitCode,
        durationMs,
        startedAt,
        completedAt,
        outputSha256: createHash('sha256').update(combined, 'utf8').digest('hex'),
        outputBytes: Buffer.byteLength(combined, 'utf8'),
        timedOut,
        outputTruncated,
        signal: signal ?? null
      };
      try {
        const updatedWorkflow = recordWorkflowStepExecution(workflowId, stepId, execution, { rootDir, eventPath });
        resolve({ workflow: updatedWorkflow, step: updatedWorkflow.steps.find(item => item.id === stepId), execution, stdout, stderr });
      } catch (error) {
        reject(new Error('Codex finished, but its workflow execution result could not be recorded: ' + error.message, { cause: error }));
      }
    });
    child.stdin?.end(prompt);
  });
}
