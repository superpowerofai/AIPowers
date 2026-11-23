import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runVerification } from '../src/runner.js';
import { readExecutionLedger } from '../src/evidence.js';

function project(script) {
  const root = mkdtempSync(path.join(tmpdir(), 'aipowers-runner-'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'runner-fixture', private: true,
    scripts: { test: script, check: script }
  }));
  return root;
}

test('runs a successful approved profile and automatically records evidence', async () => {
  const root = project('node -e "process.stdout.write(\'fixture passed\')"');
  try {
    const result = await runVerification('test', { cwd: root });
    assert.equal(result.status, 'passed');
    assert.equal(result.exitCode, 0);
    assert.equal(result.evidence.timedOut, false);
    assert.equal(result.evidence.outputTruncated, false);
    assert.match(result.stdout, /fixture passed/);
    const entries = readExecutionLedger({ ledgerPath: path.join(root, '.aipowers', 'execution-ledger.jsonl') });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, 'passed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('records a non-zero verification exit as failed evidence', async () => {
  const root = project('node -e "process.exit(7)"');
  try {
    const result = await runVerification('test', { cwd: root });
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 7);
    assert.equal(readExecutionLedger({ ledgerPath: path.join(root, '.aipowers', 'execution-ledger.jsonl') })[0].status, 'failed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects unknown profiles instead of accepting arbitrary commands', () => {
  assert.throws(() => runVerification('arbitrary-command'), /Unknown verification profile/);
});

test('validates timeout bounds before starting a process', () => {
  assert.throws(() => runVerification('test', { timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => runVerification('test', { timeoutMs: 600001 }), /timeoutMs/);
});
