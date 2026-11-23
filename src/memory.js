import {
  appendFileSync, closeSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, unlinkSync, writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultMemoryPath = path.join(projectRoot, '.aipowers', 'project-memory.json');
export const defaultMemoryEventPath = path.join(projectRoot, '.aipowers', 'project-memory-events.jsonl');
const categories = new Set(['project', 'architecture', 'decision', 'constraint', 'convention', 'known-issue', 'goal']);
const keyPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const tagPattern = /^[a-z0-9][a-z0-9-]{0,31}$/;

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
function acquireLock(lockPath, timeoutMs = 5000, staleMs = 300000) {
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
      if (Date.now() >= deadline) throw new Error('Timed out waiting for project memory lock: ' + lockPath);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
function withLocks(paths, callback) {
  const releases = [];
  try {
    for (const lockPath of [...new Set(paths)].sort()) releases.push(acquireLock(lockPath));
    return callback();
  } finally {
    for (const release of releases.reverse()) release();
  }
}
function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('Unable to read project memory: ' + error.message, { cause: error });
  }
}
function readEventsUnsafe(eventPath) {
  let content;
  try { content = readFileSync(eventPath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const lines = content.split(/\r?\n/).filter(Boolean);
  const events = [];
  let previousHash = null;
  let previousStateHash = null;
  for (const [index, line] of lines.entries()) {
    let entry;
    try { entry = JSON.parse(line); }
    catch { throw new Error('Invalid project memory event JSON at row ' + (index + 1) + '.'); }
    const { hash: storedHash, ...payload } = entry;
    if (payload.previousHash !== previousHash || payload.previousStateHash !== previousStateHash ||
        typeof payload.stateHash !== 'string' || !/^[a-f0-9]{64}$/.test(payload.stateHash) ||
        storedHash !== hash(JSON.stringify(payload))) {
      throw new Error('Project memory event integrity check failed at row ' + (index + 1) + '.');
    }
    events.push(entry);
    previousHash = storedHash;
    previousStateHash = payload.stateHash;
  }
  return events;
}
function emptyState() {
  return { schemaVersion: 1, revision: 0, createdAt: null, updatedAt: null, entries: [] };
}
function readStoreUnsafe(memoryPath, eventPath) {
  const stored = readJson(memoryPath);
  const events = readEventsUnsafe(eventPath);
  if (!stored && !events.length) return { state: emptyState(), stateHash: null, events };
  if (!stored || !events.length) throw new Error('Project memory state and audit ledger are incomplete.');
  const { stateHash, ...state } = stored;
  if (typeof stateHash !== 'string' || stateHash !== hash(JSON.stringify(state))) {
    throw new Error('Project memory state integrity check failed.');
  }
  if (events.at(-1).stateHash !== stateHash) throw new Error('Project memory state and audit ledger are out of sync.');
  if (!Array.isArray(state.entries) || state.schemaVersion !== 1 || !Number.isInteger(state.revision)) {
    throw new Error('Project memory schema is invalid.');
  }
  return { state, stateHash, events };
}
function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(temporary, file);
}
function validateEntry(key, content, { category = 'project', tags = [], retentionDays = 365 } = {}) {
  if (typeof key !== 'string' || !keyPattern.test(key)) throw new TypeError('Memory key must be a lowercase slug of up to 64 characters.');
  if (typeof content !== 'string' || !content.trim() || content.length > 4000) throw new TypeError('Memory content must contain 1 to 4000 characters.');
  if (!categories.has(category)) throw new TypeError('Memory category must be one of: ' + [...categories].join(', ') + '.');
  if (!Array.isArray(tags) || tags.length > 10 || tags.some(tag => typeof tag !== 'string' || !tagPattern.test(tag))) {
    throw new TypeError('Memory tags must be up to 10 lowercase slugs.');
  }
  if (retentionDays !== null && (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650)) {
    throw new TypeError('retentionDays must be null (permanent) or an integer from 1 to 3650.');
  }
  const secretLike = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{10,}|\b(?:api[_ -]?key|password|secret|access[_ -]?token)\s*[:=]/i;
  if (secretLike.test(content)) throw new Error('Project memory cannot store credential-like material. Store a reference to a secret manager instead.');
  return { key, content: content.trim(), category, tags: [...new Set(tags)], retentionDays };
}
function persistMutation(memoryPath, eventPath, action, details, mutate) {
  const lockPaths = [memoryPath + '.lock', eventPath + '.lock'];
  return withLocks(lockPaths, () => {
    const current = readStoreUnsafe(memoryPath, eventPath);
    const state = current.state;
    const outcome = mutate(state);
    if (!outcome?.changed) return { state, ...outcome };
    const now = new Date().toISOString();
    state.revision += 1;
    state.updatedAt = now;
    state.createdAt ??= now;
    const stateHash = hash(JSON.stringify(state));
    writeJsonAtomic(memoryPath, { ...state, stateHash });
    const previousHash = current.events.at(-1)?.hash ?? null;
    const payload = {
      schemaVersion: 1,
      action,
      details,
      revision: state.revision,
      timestamp: now,
      previousHash,
      previousStateHash: current.stateHash,
      stateHash
    };
    const entry = { ...payload, hash: hash(JSON.stringify(payload)) };
    mkdirSync(path.dirname(eventPath), { recursive: true });
    appendFileSync(eventPath, JSON.stringify(entry) + '\n', { encoding: 'utf8', flag: 'a' });
    return { state, stateHash, event: entry, ...outcome };
  });
}
function paths(options = {}) {
  return {
    memoryPath: options.memoryPath ?? defaultMemoryPath,
    eventPath: options.eventPath ?? defaultMemoryEventPath
  };
}

export function readProjectMemory(options = {}) {
  const { memoryPath, eventPath } = paths(options);
  return withLocks([memoryPath + '.lock', eventPath + '.lock'], () => {
    const { state, stateHash, events } = readStoreUnsafe(memoryPath, eventPath);
    return { ...state, stateHash, eventCount: events.length };
  });
}
export function listMemoryEntries(options = {}) {
  const state = readProjectMemory(options);
  const now = Date.now();
  return state.entries
    .map(entry => ({ ...entry, expired: entry.expiresAt !== null && Date.parse(entry.expiresAt) <= now }))
    .filter(entry => options.includeExpired === true || !entry.expired)
    .sort((a, b) => a.key.localeCompare(b.key));
}
export function getMemoryEntry(key, options = {}) {
  return listMemoryEntries({ ...options, includeExpired: true }).find(entry => entry.key === key) ?? null;
}
export function searchProjectMemory(query, options = {}) {
  if (typeof query !== 'string' || !query.trim()) throw new TypeError('A non-empty memory search query is required.');
  const limit = options.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new TypeError('Memory search limit must be an integer from 1 to 20.');
  const tokens = [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])];
  if (!tokens.length) return [];
  return listMemoryEntries(options).map(entry => {
    const keyText = entry.key.toLowerCase();
    const categoryText = entry.category.toLowerCase();
    const tagsText = entry.tags.join(' ').toLowerCase();
    const contentText = entry.content.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (keyText.includes(token)) score += 4;
      if (categoryText.includes(token)) score += 2;
      if (tagsText.includes(token)) score += 3;
      if (contentText.includes(token)) score += 1;
    }
    return { ...entry, score };
  }).filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key))
    .slice(0, limit);
}
export function setMemoryEntry(key, content, options = {}) {
  const validated = validateEntry(key, content, options);
  const { memoryPath, eventPath } = paths(options);
  return persistMutation(memoryPath, eventPath, 'set', { key, category: validated.category }, state => {
    const index = state.entries.findIndex(entry => entry.key === key);
    if (index < 0 && state.entries.length >= 200) throw new Error('Project memory is limited to 200 active/archive entries; prune or remove entries first.');
    const now = new Date().toISOString();
    const previous = index >= 0 ? state.entries[index] : null;
    const expiresAt = validated.retentionDays === null ? null
      : new Date(Date.now() + validated.retentionDays * 86400000).toISOString();
    const entry = {
      key, content: validated.content, category: validated.category, tags: validated.tags,
      retentionDays: validated.retentionDays,
      createdAt: previous?.createdAt ?? now, updatedAt: now, expiresAt
    };
    if (index >= 0) state.entries[index] = entry;
    else state.entries.push(entry);
    return { changed: true, entry };
  });
}
export function removeMemoryEntry(key, { confirm = false, ...options } = {}) {
  if (confirm !== true) throw new Error('Removing project memory requires confirm: true.');
  if (typeof key !== 'string' || !keyPattern.test(key)) throw new TypeError('A valid memory key is required.');
  const { memoryPath, eventPath } = paths(options);
  return persistMutation(memoryPath, eventPath, 'remove', { key }, state => {
    const index = state.entries.findIndex(entry => entry.key === key);
    if (index < 0) return { changed: false, removed: false };
    state.entries.splice(index, 1);
    return { changed: true, removed: true };
  });
}
export function pruneExpiredMemory({ confirm = false, now = Date.now(), ...options } = {}) {
  if (confirm !== true) throw new Error('Pruning expired project memory requires confirm: true.');
  if (!Number.isFinite(now)) throw new TypeError('now must be a valid timestamp.');
  const { memoryPath, eventPath } = paths(options);
  return persistMutation(memoryPath, eventPath, 'prune-expired', {}, state => {
    const expiredKeys = state.entries.filter(entry => entry.expiresAt !== null && Date.parse(entry.expiresAt) <= now).map(entry => entry.key);
    if (!expiredKeys.length) return { changed: false, removed: [] };
    state.entries = state.entries.filter(entry => !expiredKeys.includes(entry.key));
    return { changed: true, removed: expiredKeys };
  });
}
export function readMemoryEvents(options = {}) {
  const { eventPath, memoryPath } = paths(options);
  return withLocks([memoryPath + '.lock', eventPath + '.lock'], () => readEventsUnsafe(eventPath));
}
export function auditProjectMemory(options = {}) {
  try {
    const state = readProjectMemory(options);
    const expired = state.entries.filter(entry => entry.expiresAt !== null && Date.parse(entry.expiresAt) <= Date.now()).length;
    return { healthy: true, revision: state.revision, entries: state.entries.length, expired, eventCount: state.eventCount, issues: [] };
  } catch (error) {
    return { healthy: false, revision: null, entries: null, expired: null, eventCount: null, issues: [error.message] };
  }
}
