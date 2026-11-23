import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recordVerification, readExecutionLedger } from '../src/evidence.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'aipowers-evidence-'));
  return { root, ledgerPath: path.join(root, '.aipowers', 'execution-ledger.jsonl') };
}
const baseEvent = {
  command: 'npm test',
  exitCode: 0,
  durationMs: 1250,
  startedAt: '2026-11-23T00:00:00.000Z',
  completedAt: '2026-11-23T00:00:01.250Z',
  stdout: 'all tests passed',
  stderr: ''
};

test('records a successful verification with output fingerprints, not raw output', () => {
  const f = fixture();
  try {
    const entry = recordVerification(baseEvent, { ledgerPath: f.ledgerPath });
    assert.equal(entry.status, 'passed');
    assert.equal(entry.exitCode, 0);
    assert.equal(entry.timedOut, false);
    assert.equal(entry.outputTruncated, false);
    assert.equal(entry.stdout.bytes, Buffer.byteLength(baseEvent.stdout));
    assert.equal(typeof entry.stdout.sha256, 'string');
    assert.equal(readFileSync(f.ledgerPath, 'utf8').includes(baseEvent.stdout), false);
    assert.equal(readExecutionLedger({ ledgerPath: f.ledgerPath })[0].hash, entry.hash);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('records failed commands as failed evidence', () => {
  const f = fixture();
  try {
    const entry = recordVerification({ ...baseEvent, exitCode: 2, stderr: 'test failed' }, { ledgerPath: f.ledgerPath });
    assert.equal(entry.status, 'failed');
    assert.equal(entry.exitCode, 2);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('chains multiple records and supports recent-entry limits', () => {
  const f = fixture();
  try {
    const first = recordVerification(baseEvent, { ledgerPath: f.ledgerPath });
    const second = recordVerification({ ...baseEvent, command: 'npm run check' }, { ledgerPath: f.ledgerPath });
    const all = readExecutionLedger({ ledgerPath: f.ledgerPath });
    assert.equal(all.length, 2);
    assert.equal(second.previousHash, first.hash);
    assert.equal(readExecutionLedger({ ledgerPath: f.ledgerPath, limit: 1 })[0].command, 'npm run check');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('detects modified ledger entries', () => {
  const f = fixture();
  try {
    recordVerification(baseEvent, { ledgerPath: f.ledgerPath });
    const entry = JSON.parse(readFileSync(f.ledgerPath, 'utf8'));
    entry.command = 'tampered command';
    writeFileSync(f.ledgerPath, JSON.stringify(entry) + '\n');
    assert.throws(() => readExecutionLedger({ ledgerPath: f.ledgerPath }), /integrity check failed/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects incomplete or malformed verification results', () => {
  const f = fixture();
  try {
    assert.throws(() => recordVerification({ ...baseEvent, command: ' ' }, { ledgerPath: f.ledgerPath }), /command/);
    assert.throws(() => recordVerification({ ...baseEvent, exitCode: 0.5 }, { ledgerPath: f.ledgerPath }), /exitCode/);
    assert.throws(() => recordVerification({ ...baseEvent, durationMs: -1 }, { ledgerPath: f.ledgerPath }), /durationMs/);
    assert.throws(() => recordVerification({ ...baseEvent, startedAt: 'not-a-date' }, { ledgerPath: f.ledgerPath }), /startedAt/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('returns an empty list when no execution ledger exists', () => {
  const f = fixture();
  try { assert.deepEqual(readExecutionLedger({ ledgerPath: f.ledgerPath }), []); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
});
