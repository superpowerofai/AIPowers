import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultExecutionLedgerPath = path.join(projectRoot, '.aipowers', 'execution-ledger.jsonl');
const GENESIS = null;

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validTimestamp(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a valid timestamp string.`);
  }
}

function hashPayload(payload, previousHash) {
  return sha256(JSON.stringify({ ...payload, previousHash }));
}

/**
 * Record a verification process result supplied by the host adapter.
 * Output is hashed, not stored, to reduce accidental persistence of secrets.
 */
export function recordVerification({
  command,
  exitCode,
  durationMs,
  startedAt,
  completedAt = new Date().toISOString(),
  stdout = '',
  stderr = '',
  timedOut = false,
  outputTruncated = false
}, { ledgerPath = defaultExecutionLedgerPath } = {}) {
  if (typeof command !== 'string' || !command.trim()) throw new TypeError('A non-empty verification command is required.');
  if (!Number.isInteger(exitCode)) throw new TypeError('exitCode must be an integer.');
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new TypeError('durationMs must be a non-negative number.');
  if (typeof stdout !== 'string' || typeof stderr !== 'string') throw new TypeError('stdout and stderr must be strings.');
  if (typeof timedOut !== 'boolean' || typeof outputTruncated !== 'boolean') throw new TypeError('timedOut and outputTruncated must be booleans.');
  validTimestamp(startedAt, 'startedAt');
  validTimestamp(completedAt, 'completedAt');

  const previous = readExecutionLedger({ ledgerPath, limit: 1 });
  const previousHash = previous.length ? previous[0].hash : GENESIS;
  const payload = {
    schemaVersion: 1,
    type: 'verification',
    status: exitCode === 0 ? 'passed' : 'failed',
    command: command.trim(),
    exitCode,
    durationMs,
    timedOut,
    outputTruncated,
    startedAt,
    completedAt,
    stdout: { sha256: sha256(stdout), bytes: Buffer.byteLength(stdout, 'utf8') },
    stderr: { sha256: sha256(stderr), bytes: Buffer.byteLength(stderr, 'utf8') }
  };
  const entry = { ...payload, previousHash, hash: hashPayload(payload, previousHash) };
  mkdirSync(path.dirname(path.resolve(ledgerPath)), { recursive: true });
  appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' });
  return entry;
}

/** Read and integrity-check the complete append-only hash chain. */
export function readExecutionLedger({ ledgerPath = defaultExecutionLedgerPath, limit = 20 } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer.');
  let content;
  try { content = readFileSync(ledgerPath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }

  const entries = [];
  for (const [index, line] of content.split(/\r?\n/).filter(Boolean).entries()) {
    let entry;
    try { entry = JSON.parse(line); }
    catch { throw new Error(`Invalid execution ledger JSON at row ${index + 1}.`); }
    const { hash, previousHash, ...payload } = entry;
    const expectedPrevious = index === 0 ? GENESIS : entries[index - 1].hash;
    if (previousHash !== expectedPrevious) throw new Error(`Execution ledger chain is broken at row ${index + 1}.`);
    if (typeof hash !== 'string' || hash !== hashPayload(payload, previousHash)) {
      throw new Error(`Execution ledger integrity check failed at row ${index + 1}.`);
    }
    entries.push(entry);
  }
  return entries.slice(-limit);
}
