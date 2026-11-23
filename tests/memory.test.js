import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import {
  setMemoryEntry, getMemoryEntry, listMemoryEntries, searchProjectMemory,
  removeMemoryEntry, pruneExpiredMemory, readProjectMemory, readMemoryEvents,
  auditProjectMemory
} from '../src/memory.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'aipowers-memory-'));
  return {
    root,
    memoryPath: path.join(root, '.aipowers', 'project-memory.json'),
    eventPath: path.join(root, '.aipowers', 'project-memory-events.jsonl')
  };
}
function options(f) { return { memoryPath: f.memoryPath, eventPath: f.eventPath }; }

test('stores project memory with categories, tags and explicit retention', () => {
  const f = fixture();
  try {
    const result = setMemoryEntry('api-architecture', 'The API uses versioned REST endpoints and idempotent writes.', {
      ...options(f), category: 'architecture', tags: ['api', 'rest'], retentionDays: 180
    });
    assert.equal(result.entry.category, 'architecture');
    assert.deepEqual(result.entry.tags, ['api', 'rest']);
    assert.equal(result.entry.retentionDays, 180);
    assert.ok(result.entry.expiresAt);
    assert.equal(getMemoryEntry('api-architecture', options(f)).content, 'The API uses versioned REST endpoints and idempotent writes.');
    assert.equal(auditProjectMemory(options(f)).healthy, true);
    assert.equal(readMemoryEvents(options(f)).length, 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('updates entries without duplicating keys and supports permanent retention', () => {
  const f = fixture();
  try {
    setMemoryEntry('release-policy', 'Use semantic versioning.', { ...options(f), category: 'convention' });
    const updated = setMemoryEntry('release-policy', 'Use semantic versioning and changelog entries.', {
      ...options(f), category: 'convention', retentionDays: null, tags: ['release']
    });
    assert.equal(readProjectMemory(options(f)).entries.length, 1);
    assert.equal(updated.entry.retentionDays, null);
    assert.equal(updated.entry.expiresAt, null);
    assert.equal(readMemoryEvents(options(f)).length, 2);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('searches relevant non-expired memories deterministically', () => {
  const f = fixture();
  try {
    setMemoryEntry('database-choice', 'Use PostgreSQL for transactional application data.', {
      ...options(f), category: 'decision', tags: ['database', 'postgres']
    });
    setMemoryEntry('brand-tone', 'Use concise, direct product language.', {
      ...options(f), category: 'convention', tags: ['brand', 'copy']
    });
    const results = searchProjectMemory('PostgreSQL database', options(f));
    assert.equal(results[0].key, 'database-choice');
    assert.ok(results[0].score > 0);
    assert.equal(searchProjectMemory('unrelated quantum topic', options(f)).length, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('requires explicit confirmation to remove or prune retained memory', () => {
  const f = fixture();
  try {
    setMemoryEntry('old-decision', 'Keep the previous migration strategy.', { ...options(f), retentionDays: 1 });
    assert.throws(() => removeMemoryEntry('old-decision', options(f)), /confirm: true/);
    assert.throws(() => pruneExpiredMemory(options(f)), /confirm: true/);
    assert.equal(getMemoryEntry('old-decision', options(f)).key, 'old-decision');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('prunes expired memories only after explicit confirmation', () => {
  const f = fixture();
  try {
    setMemoryEntry('temporary-note', 'Temporary implementation note.', { ...options(f), retentionDays: 1 });
    const now = Date.now() + 2 * 86400000;
    assert.equal(listMemoryEntries({ ...options(f), includeExpired: true })[0].expired, false);
    const pruned = pruneExpiredMemory({ ...options(f), confirm: true, now });
    assert.deepEqual(pruned.removed, ['temporary-note']);
    assert.equal(listMemoryEntries(options(f)).length, 0);
    assert.equal(auditProjectMemory(options(f)).healthy, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects credential-like material and invalid memory metadata', () => {
  const f = fixture();
  try {
    assert.throws(() => setMemoryEntry('api-secret', 'api_key: sk_live_abcdefghijklmnop', options(f)), /credential-like material/);
    assert.throws(() => setMemoryEntry('bad-category', 'A note.', { ...options(f), category: 'misc' }), /category/);
    assert.throws(() => setMemoryEntry('bad-retention', 'A note.', { ...options(f), retentionDays: 4000 }), /retentionDays/);
    assert.throws(() => setMemoryEntry('Bad Key', 'A note.', options(f)), /lowercase slug/);
    assert.equal(readProjectMemory(options(f)).entries.length, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('detects memory state and event-ledger tampering', () => {
  const f = fixture();
  try {
    setMemoryEntry('architecture-note', 'Keep adapters provider-neutral.', options(f));
    const stored = JSON.parse(readFileSync(f.memoryPath, 'utf8'));
    stored.entries[0].content = 'Tampered content';
    writeFileSync(f.memoryPath, JSON.stringify(stored));
    assert.equal(auditProjectMemory(options(f)).healthy, false);
    assert.throws(() => readProjectMemory(options(f)), /state integrity check failed/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('serializes concurrent memory writes and preserves all entries', async () => {
  const f = fixture();
  const moduleUrl = pathToFileURL(path.resolve('src/memory.js')).href;
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.moduleUrl).then(module => {
      try {
        const result = module.setMemoryEntry(workerData.key, 'Shared concurrent note ' + workerData.key, workerData.options);
        parentPort.postMessage({ ok: true, key: result.entry.key });
      } catch (error) { parentPort.postMessage({ ok: false, error: error.message }); }
    });
  `;
  const run = key => new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true, workerData: { moduleUrl, key, options: options(f) } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error('Worker exited with code ' + code)); });
  });
  try {
    const results = await Promise.all(['alpha-note', 'beta-note', 'gamma-note', 'delta-note'].map(run));
    assert.equal(results.filter(result => result.ok).length, 4, JSON.stringify(results));
    assert.equal(readProjectMemory(options(f)).entries.length, 4);
    assert.equal(readMemoryEvents(options(f)).length, 4);
    assert.equal(auditProjectMemory(options(f)).healthy, true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('validates search result limits', () => {
  const f = fixture();
  try {
    assert.throws(() => searchProjectMemory('project', { ...options(f), limit: 21 }), /limit must be an integer/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
