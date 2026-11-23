#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import {
  discoverSkills, getSkill, resolveSkills,
  recordActivation, readActivationLedger
} from './skills.js';
import { prepareAgentContext } from './agent.js';
import { installCodexSkills } from './codex.js';
import { readExecutionLedger } from './evidence.js';
import { setMemoryEntry, getMemoryEntry, listMemoryEntries, searchProjectMemory, removeMemoryEntry, pruneExpiredMemory, readMemoryEvents, auditProjectMemory } from './memory.js';
import { runVerification } from './runner.js';
import {
  createWorkflow, getWorkflow, listWorkflows, auditWorkflowStore, approveWorkflow, startWorkflow,
  completeWorkflowStep, approveWorkflowStep, blockWorkflow, resumeWorkflow, cancelWorkflow, retryWorkflowStep, getWorkflowSchedule, recoverWorkflowExecutions, readWorkflowEvents, migrateWorkflowCheckpoint, superviseWorkflowExecutions, restoreWorkflowSnapshot, replayWorkflowHistory
} from './workflow.js';
import { evaluateWorkflowCompletion } from './quality.js';
import { executeWorkflowStep, listExecutionAdapters } from './adapters/registry.js';
import { runReadyWorkflowSteps } from './orchestrator.js';

const [command = 'help', ...args] = process.argv.slice(2);
const version = '0.1.0';
const help = `AIPowers ${version}
Original AI Coding Agent Development System

Usage:
  aipowers help                         Show this help
  aipowers version                      Show version
  aipowers doctor                       Check the local runtime
  aipowers agents                       Show implemented and planned modules
  aipowers agent prepare "<task>"       Prepare an agent context package
  aipowers memory list                  List active project memories
  aipowers memory set <key> <category> <retention|permanent> "<content>" Store explicit project memory
  aipowers memory get <key>              Read one project memory entry
  aipowers memory search "<query>"      Find relevant project memories
  aipowers memory remove <key> --confirm Remove a memory entry
  aipowers memory prune --confirm       Remove expired entries
  aipowers memory audit                 Verify project memory integrity
  aipowers memory events [limit]        Inspect project memory change history
  aipowers codex install [project-path]  Install native Codex skills in a project
  aipowers skills list                  Discover available skills
  aipowers skills activate "<task>"     Resolve and record task workflows
  aipowers skills show <skill-id>       Show a skill's instructions
  aipowers skills ledger [limit]        Inspect recent activation decisions
  aipowers workflow <action>           Manage approval-gated development workflows
  aipowers workflow next <id>          Show dependency-ready steps
  aipowers workflow status <id>        Show workflow execution status
  aipowers workflow step approve <id> <step> Approve sensitive permissions for one step
  aipowers workflow events <id> [limit] Inspect integrity-checked workflow history
  aipowers workflow audit               Audit workflow index, snapshots and checkpoints
  aipowers workflow migrate-checkpoint <id> Upgrade a legacy workflow audit checkpoint
  aipowers workflow restore <id>         Restore the latest verified immutable snapshot
  aipowers workflow replay <id>          Replay event history from immutable snapshots
  aipowers workflow providers            List registered execution providers
  aipowers workflow supervise <id>      Recover steps whose attached provider process has exited
  aipowers workflow recover <id> --confirm-orphaned  Recover untracked attempts after operator confirmation
  aipowers workflow run <provider> <id> <step> Run one ready step through an adapter
  aipowers workflow run-ready <provider> <id> [concurrency] Run ready steps with provider-supported parallelism
  aipowers workflow run-codex <id> <step> Execute an approved step with Codex
  aipowers quality check <workflow-id> Evaluate completion evidence
  aipowers verify <test|check> [path]   Run an approved verification profile
  aipowers evidence list [limit]        Inspect execution evidence
`;

switch (command) {
  case 'help': case '--help': case '-h': process.stdout.write(help); break;
  case 'version': case '--version': case '-v': process.stdout.write(`${version}\n`); break;
  case 'doctor': {
    const major = Number(process.versions.node.split('.')[0]);
    const ok = major >= 20;
    process.stdout.write(`AIPowers Doctor\nNode.js: ${process.versions.node} ${ok ? 'OK' : 'NEEDS Node 20+'}\n`);
    if (!ok) process.exitCode = 1;
    break;
  }
  case 'agents':
    process.stdout.write('AIPowers modules\n- Agent Context Adapter (local package generation)\n- Skills Engine (initial implementation)\n- Codex Native Skills Export (implemented; host recognition pending)\n- Provider-neutral Execution Adapter Registry (implemented; Codex registered)\n- Codex Workflow Execution Adapter (implemented; live authentication pending)\n- Approval-gated Workflow Engine (implemented; proposal through completion)\n- Verification Runner (implemented; fixed test/check profiles)\n- Execution Evidence Ledger (implemented; hash-linked verification records)\n- Completion Quality Gate (implemented; deterministic evidence checks)\n- Dependency-aware Workflow Orchestrator (implemented)\n- Durable Execution Recovery (implemented; explicit orphan recovery)\n- Project Memory & Context (implemented; explicit retention and audited retrieval)\n- Evaluation & Safety (planned)\n- Live agent execution and runtime hooks (planned)\n');
    break;
  case 'codex': {
    const [action, ...values] = args;
    if (action !== 'install') {
      process.stderr.write('Usage: aipowers codex install [project-path]\n');
      process.exitCode = 2;
      break;
    }
    try {
      const result = installCodexSkills({ targetDir: values[0] ?? process.cwd() });
      process.stdout.write(`Installed ${result.installed.length} AIPowers skill(s) for Codex.\n`);
      for (const skill of result.installed) process.stdout.write(`- ${skill.id}: ${skill.file}\n`);
      process.stdout.write(`\nCodex project skills: ${result.skillRoot}\nStart a new Codex session to discover them.\n`);
    } catch (error) {
      process.stderr.write(`Codex integration failed: ${error.message}\n`);
      process.exitCode = 1;
    }
    break;
  }
  case 'agent': {
    const [action, ...values] = args;
    if (action !== 'prepare') {
      process.stderr.write('Usage: aipowers agent prepare "<task description>"\n');
      process.exitCode = 2;
      break;
    }
    const task = values.join(' ').trim();
    if (!task) {
      process.stderr.write('Usage: aipowers agent prepare "<task description>"\n');
      process.exitCode = 2;
      break;
    }
    const result = prepareAgentContext(task);
    process.stdout.write(`Prepared agent context for task: ${task}\n`);
    process.stdout.write(`Activated skills: ${result.activated.length}\n`);
    for (const skill of result.activated) process.stdout.write(`- ${skill.id} (priority ${skill.priority})\n`);
    for (const skipped of result.skipped) process.stdout.write(`Skipped: ${skipped.id} — ${skipped.reason}\n`);
    process.stdout.write(`\nMarkdown: ${result.markdownPath}\nManifest: ${result.manifestPath}\nActivation ledger: .aipowers/activation-ledger.jsonl\n`);
    process.stdout.write('\nReady for an external coding agent to consume. No agent was launched or automatically injected.\n');
    break;
  }
  case 'quality': {
    const [action, workflowId] = args;
    if (action !== 'check' || !workflowId) {
      process.stderr.write('Usage: aipowers quality check <workflow-id>\n');
      process.exitCode = 2;
      break;
    }
    try {
      const result = evaluateWorkflowCompletion(workflowId, {
        rootDir: path.join(process.cwd(), '.aipowers', 'workflows'),
        eventPath: path.join(process.cwd(), '.aipowers', 'workflow-events.jsonl'),
        evidencePath: path.join(process.cwd(), '.aipowers', 'execution-ledger.jsonl')
      });
      process.stdout.write('Completion readiness: ' + (result.ready ? 'READY' : 'BLOCKED') + '\n');
      process.stdout.write('Workflow: ' + result.workflowId + ' [' + result.workflowStatus + ']\n');
      process.stdout.write('Steps: ' + result.completedSteps + '/' + result.totalSteps + '\n');
      process.stdout.write('Latest verification: ' + result.latestEvidenceStatus + '\n');
      for (const blocker of result.blockers) process.stdout.write('- BLOCKER: ' + blocker + '\n');
      if (!result.ready) process.exitCode = 1;
    } catch (error) {
      process.stderr.write('Quality evaluation failed: ' + error.message + '\n');
      process.exitCode = 1;
    }
    break;
  }
  case 'memory': {
    const [action, ...values] = args;
    const memoryOptions = {
      memoryPath: path.join(process.cwd(), '.aipowers', 'project-memory.json'),
      eventPath: path.join(process.cwd(), '.aipowers', 'project-memory-events.jsonl')
    };
    try {
      if (action === 'list') {
        const entries = listMemoryEntries(memoryOptions);
        if (!entries.length) process.stdout.write('No active project memories.\n');
        for (const entry of entries) process.stdout.write(entry.key + ' [' + entry.category + '] retention=' + (entry.retentionDays === null ? 'permanent' : entry.retentionDays + 'd') + '\n');
      } else if (action === 'set') {
        if (values.length < 4) throw new Error('Usage: aipowers memory set <key> <category> <retention-days|permanent> "<content>"');
        const [key, category, retentionValue, ...contentParts] = values;
        const retentionDays = retentionValue === 'permanent' ? null : Number(retentionValue);
        const result = setMemoryEntry(key, contentParts.join(' '), { ...memoryOptions, category, retentionDays });
        process.stdout.write('Saved project memory: ' + result.entry.key + '\n');
        process.stdout.write('Retention: ' + (result.entry.retentionDays === null ? 'permanent until explicitly removed' : result.entry.retentionDays + ' days') + '\n');
      } else if (action === 'get') {
        const entry = getMemoryEntry(values[0], memoryOptions);
        if (!entry) throw new Error('Project memory entry not found: ' + values[0]);
        process.stdout.write(entry.key + ' [' + entry.category + ']' + (entry.expired ? ' [EXPIRED]' : '') + '\n');
        process.stdout.write(entry.content + '\n');
        process.stdout.write('Tags: ' + (entry.tags.join(', ') || 'none') + '\n');
        process.stdout.write('Expires: ' + (entry.expiresAt ?? 'never') + '\n');
      } else if (action === 'search') {
        const results = searchProjectMemory(values.join(' '), memoryOptions);
        if (!results.length) process.stdout.write('No relevant project memories found.\n');
        for (const entry of results) process.stdout.write(entry.key + ' [' + entry.category + '] score=' + entry.score + ': ' + entry.content + '\n');
      } else if (action === 'remove') {
        if (!values[0] || values[1] !== '--confirm') throw new Error('Usage: aipowers memory remove <key> --confirm');
        const result = removeMemoryEntry(values[0], { ...memoryOptions, confirm: true });
        process.stdout.write(result.removed ? 'Removed project memory: ' + values[0] + '\n' : 'Memory key not found: ' + values[0] + '\n');
      } else if (action === 'prune') {
        if (values[0] !== '--confirm') throw new Error('Usage: aipowers memory prune --confirm');
        const result = pruneExpiredMemory({ ...memoryOptions, confirm: true });
        process.stdout.write('Expired memories removed: ' + result.removed.length + '\n');
      } else if (action === 'events') {
        const limit = values[0] === undefined ? 20 : Number(values[0]);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Memory event limit must be from 1 to 100.');
        const events = readMemoryEvents(memoryOptions).slice(-limit);
        for (const event of events) process.stdout.write(event.timestamp + ' ' + event.action + ' ' + JSON.stringify(event.details) + '\n');
        if (!events.length) process.stdout.write('No project memory events.\n');
      } else if (action === 'audit') {
        const audit = auditProjectMemory(memoryOptions);
        process.stdout.write('Project memory: ' + (audit.healthy ? 'HEALTHY' : 'ISSUES FOUND') + '\n');
        process.stdout.write('Entries: ' + audit.entries + ' | Expired: ' + audit.expired + ' | Events: ' + audit.eventCount + '\n');
        for (const issue of audit.issues) process.stdout.write('ISSUE: ' + issue + '\n');
        if (!audit.healthy) process.exitCode = 1;
      } else {
        throw new Error('Usage: aipowers memory <list|set|get|search|remove|prune|events|audit> ...');
      }
    } catch (error) {
      process.stderr.write('Project memory operation failed: ' + error.message + '\n');
      process.exitCode = 1;
    }
    break;
  }
  case 'workflow': {
    const [action, ...values] = args;
    const workflowOptions = {
      rootDir: path.join(process.cwd(), '.aipowers', 'workflows'),
      eventPath: path.join(process.cwd(), '.aipowers', 'workflow-events.jsonl')
    };
    try {
      if (action === 'create') {
        const task = values.join(' ').trim();
        if (!task) throw new Error('Usage: aipowers workflow create "<task description>"');
        const selected = resolveSkills(task).activated;
        const steps = selected.length
          ? selected.map((skill, index) => ({
              id: skill.id, title: skill.name, skillId: skill.id,
              priority: skill.priority, reason: skill.reason, instructions: skill.instructions,
              dependsOn: index > 0 ? [selected[index - 1].id] : []
            }))
          : [{ id: 'implementation', title: 'Implement the requested task', reason: 'No specialized workflow skill matched.' }];
        const workflow = createWorkflow({ task, steps }, workflowOptions);
        process.stdout.write('Created proposed workflow: ' + workflow.id + '\n');
        process.stdout.write('Status: proposed (explicit approval required before start)\n');
        for (const step of workflow.steps) process.stdout.write('- ' + step.id + ': ' + step.title + ' [pending]\n');
      } else if (action === 'list') {
        const workflows = listWorkflows({ rootDir: workflowOptions.rootDir });
        if (!workflows.length) process.stdout.write('No workflows found.\n');
        for (const workflow of workflows) process.stdout.write(workflow.id + ' [' + workflow.status + '] ' + workflow.task + '\n');
      } else if (action === 'replay') {
        if (!values[0]) throw new Error('Usage: aipowers workflow replay <workflow-id>');
        const history = replayWorkflowHistory(values[0], workflowOptions);
        process.stdout.write('Workflow replay: ' + values[0] + ' (' + history.length + ' events)\n');
        for (const event of history) process.stdout.write('[' + event.sequence + '] ' + event.timestamp + ' ' + event.type + ' [' + event.status + '] ' + (event.legacy ? '[legacy/no snapshot]' : '[snapshot verified]') + '\n');
      } else if (action === 'restore') {
        if (!values[0]) throw new Error('Usage: aipowers workflow restore <workflow-id>');
        const result = restoreWorkflowSnapshot(values[0], workflowOptions);
        process.stdout.write(result.restored ? 'Workflow restored from its latest verified snapshot.\n' : 'Workflow snapshot is already current.\n');
      } else if (action === 'migrate-checkpoint') {
        if (!values[0]) throw new Error('Usage: aipowers workflow migrate-checkpoint <workflow-id>');
        const result = migrateWorkflowCheckpoint(values[0], workflowOptions);
        process.stdout.write(result.migrated ? 'Legacy workflow checkpoint migrated.\n' : result.snapshotCreated ? 'Existing checkpoint retained; immutable snapshot created.\n' : 'Workflow already has a current state checkpoint.\n');
      } else if (action === 'providers') {
        const providers = listExecutionAdapters();
        if (!providers.length) process.stdout.write('No execution providers are registered.\n');
        for (const provider of providers) process.stdout.write(provider.id + ' (max concurrency: ' + provider.maxConcurrency + '; permissions: ' + provider.permissions.join(', ') + ')\n');
      } else if (action === 'audit') {
        const audit = auditWorkflowStore(workflowOptions);
        process.stdout.write('Workflow store: ' + (audit.healthy ? 'HEALTHY' : 'ISSUES FOUND') + '\n');
        process.stdout.write('Workflows: ' + audit.workflowCount + ' | Events: ' + audit.eventCount + '\n');
        for (const [status, count] of Object.entries(audit.statuses)) process.stdout.write('- ' + status + ': ' + count + '\n');
        for (const issue of audit.issues) process.stdout.write('ISSUE: ' + issue + '\n');
        for (const warning of audit.warnings) process.stdout.write('WARNING: ' + warning + '\n');
        if (!audit.healthy) process.exitCode = 1;
      } else if (action === 'events') {
        const limit = values[1] === undefined ? 20 : Number(values[1]);
        if (!values[0] || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Usage: aipowers workflow events <workflow-id> [limit 1-100]');
        const events = readWorkflowEvents({ eventPath: workflowOptions.eventPath }).filter(event => event.workflowId === values[0]).slice(-limit);
        if (!events.length) process.stdout.write('No events found for workflow ' + values[0] + '.\n');
        for (const event of events) process.stdout.write(event.timestamp + ' ' + event.type + ' [' + event.status + '] ' + JSON.stringify(event.details) + '\n');
      } else if (action === 'supervise') {
        if (!values[0]) throw new Error('Usage: aipowers workflow supervise <workflow-id>');
        const result = superviseWorkflowExecutions(values[0], workflowOptions);
        if (result.interrupted.length) process.stdout.write('Recovered exited provider steps: ' + result.interrupted.join(', ') + '\n');
        if (result.stillRunning.length) process.stdout.write('Still running: ' + result.stillRunning.join(', ') + '\n');
        if (result.untracked.length) process.stdout.write('No attached process ID; manual confirmation required: ' + result.untracked.join(', ') + '\n');
        if (!result.interrupted.length && !result.stillRunning.length && !result.untracked.length) process.stdout.write('No running workflow attempts.\n');
      } else if (action === 'recover') {
        if (!values[0] || values[1] !== '--confirm-orphaned') throw new Error('Usage: aipowers workflow recover <workflow-id> --confirm-orphaned (first confirm the provider process has stopped)');
        const result = recoverWorkflowExecutions(values[0], { ...workflowOptions, confirmOrphaned: true });
        if (result.recovered.length) process.stdout.write('Recovered interrupted steps: ' + result.recovered.join(', ') + '\n');
        if (result.stillRunning.length) process.stdout.write('Still running (left unchanged): ' + result.stillRunning.join(', ') + '\n');
        if (!result.recovered.length && !result.stillRunning.length) process.stdout.write('No interrupted executions found.\n');
        if (result.recovered.length) process.stdout.write('Recovered steps are marked failed; inspect the workspace before retrying.\n');
      } else if (action === 'next' || action === 'status') {
        const schedule = getWorkflowSchedule(values[0], workflowOptions);
        process.stdout.write('Workflow: ' + schedule.workflowId + ' [' + schedule.workflowStatus + ']\n');
        process.stdout.write('Ready steps:\n');
        for (const step of schedule.ready) process.stdout.write('- ' + step.id + ': ' + step.title + (step.provider ? ' [provider: ' + step.provider + ']' : '') + '\n');
        process.stdout.write('Approval pending steps (explicit step approval required):\n');
        for (const step of schedule.approvalPending) process.stdout.write('- ' + step.id + ': ' + step.title + ' [permissions: ' + step.permissions.join(', ') + ']\n');
        process.stdout.write('Waiting steps:\n');
        for (const step of schedule.waiting) process.stdout.write('- ' + step.id + ': ' + step.title + (step.provider ? ' [provider: ' + step.provider + ']' : '') + ' (dependencies incomplete)\n');
        process.stdout.write('Dependency-blocked steps:\n');
        for (const step of schedule.blocked) process.stdout.write('- ' + step.id + ': ' + step.title + (step.provider ? ' [provider: ' + step.provider + ']' : '') + ' (dependency failed or cancelled)\n');
        process.stdout.write('Running: ' + (schedule.running.map(step => step.id).join(', ') || 'none') + '\n');
        process.stdout.write('Awaiting human review: ' + (schedule.review.map(step => step.id).join(', ') || 'none') + '\n');
        process.stdout.write('Failed: ' + (schedule.failed.map(step => step.id).join(', ') || 'none') + '\n');
        if (!schedule.ready.length && !schedule.approvalPending.length && !schedule.waiting.length && !schedule.blocked.length && !schedule.running.length && !schedule.review.length && !schedule.failed.length) process.stdout.write('No unfinished steps.\n');
      } else if (action === 'show') {
        const workflow = getWorkflow(values[0], workflowOptions);
        process.stdout.write(workflow.task + '\nID: ' + workflow.id + '\nStatus: ' + workflow.status + '\n');
        process.stdout.write('Approval: ' + (workflow.approval.approvedAt ? 'approved' : 'pending') + '\n');
        for (const step of workflow.steps) process.stdout.write('- ' + step.id + ': ' + step.title + ' [' + step.status + ']' + (step.provider ? ' [provider: ' + step.provider + ']' : '') + (step.approvalRequired ? ' [step approval: ' + step.approvalStatus + '; permissions: ' + step.permissions.join(', ') + ']' : '') + '\n');
      } else if (action === 'run-ready') {
        const [provider, workflowId, concurrencyValue] = values;
        if (!provider || !workflowId) throw new Error('Usage: aipowers workflow run-ready <provider> <workflow-id> [concurrency]');
        const result = await runReadyWorkflowSteps(provider, workflowId, {
          cwd: process.cwd(), rootDir: workflowOptions.rootDir, eventPath: workflowOptions.eventPath
        }, { maxConcurrency: concurrencyValue === undefined ? undefined : Number(concurrencyValue) });
        process.stdout.write('Executed steps: ' + result.results.map(item => item.stepId + '[' + item.status + '] via ' + item.provider).join(', ') + '\n');
        for (const item of result.results) if (item.error) process.stderr.write(item.stepId + ' interrupted: ' + item.error + '\n');
        process.stdout.write('Still ready: ' + (result.readyStepIds.join(', ') || 'none') + '\n');
        process.stdout.write('Approval pending: ' + (result.approvalPendingStepIds.join(', ') || 'none') + '\n');
        process.stdout.write('Waiting for human review/dependencies: ' + (result.waitingStepIds.join(', ') || 'none') + '\n');
        process.stdout.write('Dependency blocked: ' + (result.blockedStepIds.join(', ') || 'none') + '\n');
        process.stdout.write('Running: ' + (result.runningStepIds.join(', ') || 'none') + '\n');
        process.stdout.write('Awaiting human review: ' + (result.reviewStepIds.join(', ') || 'none') + '\n');
        process.stdout.write('Failed: ' + (result.failedStepIds.join(', ') || 'none') + '\n');
        process.stdout.write('Completed: ' + (result.completedStepIds.join(', ') || 'none') + '\n');
        if (result.limitReached) process.stdout.write('Run limit reached; invoke run-ready again to continue.\n');
        if (result.results.some(item => item.error || item.result.execution?.exitCode !== 0 || item.status !== 'executed')) process.exitCode = 1;
      } else if (action === 'run-codex' || action === 'run') {
        const provider = action === 'run-codex' ? 'codex' : values[0];
        const workflowId = action === 'run-codex' ? values[0] : values[1];
        const stepId = action === 'run-codex' ? values[1] : values[2];
        if (!provider || !workflowId || !stepId) throw new Error('Usage: aipowers workflow run <provider> <workflow-id> <step-id>');
        const result = await executeWorkflowStep(provider, workflowId, stepId, {
          cwd: process.cwd(),
          rootDir: workflowOptions.rootDir,
          eventPath: workflowOptions.eventPath
        });
        process.stdout.write(provider + ' step execution: ' + result.step.status + '\n');
        process.stdout.write('Output SHA-256: ' + result.execution.outputSha256 + '\n');
        process.stdout.write('The step is awaiting human review; mark it complete only after reviewing the result.\n');
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
        if (result.execution.exitCode !== 0) process.exitCode = 1;
      } else if (action === 'approve') {
        const workflow = approveWorkflow(values[0], workflowOptions);
        process.stdout.write('Approved workflow ' + workflow.id + '. It has not been started.\n');
      } else if (action === 'start') {
        const workflow = startWorkflow(values[0], workflowOptions);
        process.stdout.write('Workflow started: ' + workflow.id + '\n');
      } else if (action === 'step' && values[0] === 'approve') {
        const workflow = approveWorkflowStep(values[1], values[2], workflowOptions);
        process.stdout.write('Sensitive step approved: ' + values[2] + '. Permissions: ' + workflow.steps.find(step => step.id === values[2]).permissions.join(', ') + '\n');
      } else if (action === 'step' && values[0] === 'done') {
        const workflow = completeWorkflowStep(values[1], values[2], workflowOptions);
        process.stdout.write('Step recorded. Workflow status: ' + workflow.status + '\n');
      } else if (action === 'block') {
        const workflow = blockWorkflow(values[0], values.slice(1).join(' '), workflowOptions);
        process.stdout.write('Workflow blocked: ' + workflow.id + '\n');
      } else if (action === 'retry') {
        const workflow = retryWorkflowStep(values[0], values[1], workflowOptions);
        process.stdout.write('Step reset to pending for retry: ' + workflow.id + '\n');
      } else if (action === 'resume') {
        const workflow = resumeWorkflow(values[0], workflowOptions);
        process.stdout.write('Workflow resumed: ' + workflow.id + '\n');
      } else if (action === 'cancel') {
        const workflow = cancelWorkflow(values[0], values.slice(1).join(' ') || 'Cancelled by user', workflowOptions);
        process.stdout.write('Workflow cancelled: ' + workflow.id + '\n');
      } else {
        process.stderr.write('Usage: aipowers workflow <create|list|show|approve|start|step done|run-codex|retry|block|resume|cancel> ...\n');
        process.exitCode = 2;
      }
    } catch (error) {
      process.stderr.write('Workflow operation failed: ' + error.message + '\n');
      process.exitCode = 1;
    }
    break;
  }
  case 'verify': {
    const [profile, projectPath] = args;
    if (!['test', 'check'].includes(profile)) {
      process.stderr.write('Usage: aipowers verify <test|check> [project-path]\n');
      process.exitCode = 2;
      break;
    }
    try {
      const result = await runVerification(profile, { cwd: projectPath ?? process.cwd() });
      process.stdout.write(`Verification ${result.status.toUpperCase()}: ${result.command}\n`);
      process.stdout.write(`Exit code: ${result.exitCode} | Duration: ${Math.round(result.durationMs)} ms\n`);
      process.stdout.write(`Evidence hash: ${result.evidence.hash}\n`);
      if (result.outputTruncated) process.stdout.write('Output was truncated at the configured capture limit.\n');
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.exitCode !== 0) process.exitCode = 1;
    } catch (error) {
      process.stderr.write(`Verification could not be completed: ${error.message}\n`);
      process.exitCode = 1;
    }
    break;
  }
  case 'evidence': {
    const [action, ...values] = args;
    if (action !== 'list') {
      process.stderr.write('Usage: aipowers evidence list [limit]\n');
      process.exitCode = 2;
      break;
    }
    const limit = values[0] === undefined ? 10 : Number(values[0]);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      process.stderr.write('Evidence limit must be an integer from 1 to 100.\n');
      process.exitCode = 2;
      break;
    }
    try {
      const entries = readExecutionLedger({ limit, ledgerPath: path.join(process.cwd(), '.aipowers', 'execution-ledger.jsonl') });
      if (!entries.length) process.stdout.write('Execution evidence ledger is empty. No verification results have been recorded.\n');
      for (const entry of entries) {
        process.stdout.write(`\n[${entry.status.toUpperCase()}] ${entry.command} (exit ${entry.exitCode}, ${entry.durationMs} ms)\n`);
        process.stdout.write(`  Completed: ${entry.completedAt}\n  Evidence hash: ${entry.hash}\n`);
      }
    } catch (error) {
      process.stderr.write(`Unable to read execution evidence: ${error.message}\n`);
      process.exitCode = 1;
    }
    break;
  }
  case 'skills': {
    const [action, ...values] = args;
    if (action === 'list') {
      const skills = discoverSkills();
      process.stdout.write(`Discovered ${skills.length} skill(s)\n`);
      for (const skill of skills) process.stdout.write(`- ${skill.id} [priority ${skill.priority}]: ${skill.name} — ${skill.description}\n`);
    } else if (action === 'activate') {
      const task = values.join(' ').trim();
      if (!task) {
        process.stderr.write('Usage: aipowers skills activate "<task description>"\n');
        process.exitCode = 2;
        break;
      }
      const result = resolveSkills(task);
      recordActivation(result);
      if (!result.activated.length) process.stdout.write('No matching skills activated. Decision recorded in the activation ledger.\n');
      else {
        process.stdout.write(`Activated ${result.activated.length} skill(s) for task: ${task}\n`);
        for (const skill of result.activated) process.stdout.write(`\n## ${skill.name} [priority ${skill.priority}]\nReason: ${skill.reason}\n\n${skill.instructions}\n`);
      }
      for (const skipped of result.skipped) process.stdout.write(`\nSkipped: ${skipped.id} — ${skipped.reason}\n`);
      process.stdout.write('\nDecision saved to .aipowers/activation-ledger.jsonl\n');
    } else if (action === 'ledger') {
      const requested = values[0] === undefined ? 10 : Number(values[0]);
      if (!Number.isInteger(requested) || requested < 1 || requested > 100) {
        process.stderr.write('Ledger limit must be an integer from 1 to 100.\n');
        process.exitCode = 2;
        break;
      }
      const entries = readActivationLedger({ limit: requested });
      if (!entries.length) { process.stdout.write('Activation ledger is empty.\n'); break; }
      for (const entry of entries) {
        process.stdout.write(`\n[${entry.timestamp}] ${entry.task}\n`);
        for (const skill of entry.activated) process.stdout.write(`  + ${skill.id} (priority ${skill.priority}) — ${skill.reason}\n`);
        for (const skill of entry.skipped) process.stdout.write(`  - ${skill.id} — ${skill.reason}\n`);
      }
    } else if (action === 'show') {
      const skill = getSkill(values[0]);
      if (!skill) {
        process.stderr.write(`Skill not found: ${values[0] ?? '(missing id)'}\n`);
        process.exitCode = 2;
        break;
      }
      process.stdout.write(`# ${skill.name}\n${skill.description}\n\nPriority: ${skill.priority}\nTriggers: ${skill.triggers.join(', ')}\n`);
      if (skill.conflicts.length) process.stdout.write(`Conflicts: ${skill.conflicts.join(', ')}\n`);
      if (skill.excludeTriggers.length) process.stdout.write(`Exclusions: ${skill.excludeTriggers.join(', ')}\n`);
      process.stdout.write(`\n${skill.instructions}\n`);
    } else {
      process.stderr.write('Usage: aipowers skills <list|activate|show|ledger>\n');
      process.exitCode = 2;
    }
    break;
  }
  default:
    process.stderr.write(`Unknown command: ${command}\nRun aipowers help.\n`);
    process.exitCode = 2;
}
