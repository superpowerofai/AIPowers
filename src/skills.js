import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultSkillsDir = path.join(projectRoot, 'skills');
export const defaultLedgerPath = path.join(projectRoot, '.aipowers', 'activation-ledger.jsonl');
const validIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validateSkill(skill, file) {
  const validConflicts = value => value === undefined || (
    Array.isArray(value) && value.every(item => typeof item === 'string' && validIdPattern.test(item))
  );
  const validExclusions = value => value === undefined || (
    Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim())
  );
  const valid = skill && typeof skill === 'object'
    && typeof skill.id === 'string' && validIdPattern.test(skill.id)
    && typeof skill.name === 'string' && skill.name.trim()
    && typeof skill.description === 'string' && skill.description.trim()
    && Array.isArray(skill.triggers) && skill.triggers.length > 0
    && skill.triggers.every(trigger => typeof trigger === 'string' && trigger.trim())
    && typeof skill.instructions === 'string' && skill.instructions.trim()
    && (skill.priority === undefined || (Number.isInteger(skill.priority) && skill.priority >= -1000 && skill.priority <= 1000))
    && validConflicts(skill.conflicts) && validExclusions(skill.excludeTriggers);
  if (!valid) throw new Error(`Invalid skill definition in ${file}: check id, name, description, triggers, instructions, priority, conflicts, and excludeTriggers.`);
  return {
    ...skill,
    priority: skill.priority ?? 0,
    conflicts: [...new Set(skill.conflicts ?? [])],
    excludeTriggers: [...new Set((skill.excludeTriggers ?? []).map(value => value.trim()))],
    triggers: [...new Set(skill.triggers.map(value => value.trim()))]
  };
}

export function discoverSkills(skillsDir = defaultSkillsDir) {
  let files;
  try {
    files = readdirSync(skillsDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const skills = files.map(file => {
    let parsed;
    try { parsed = JSON.parse(readFileSync(path.join(skillsDir, file), 'utf8')); }
    catch (error) { throw new Error(`Unable to load skill definition ${file}: ${error.message}`); }
    return validateSkill(parsed, file);
  });
  const ids = new Set();
  for (const skill of skills) {
    if (ids.has(skill.id)) throw new Error(`Duplicate skill id: ${skill.id}`);
    ids.add(skill.id);
  }
  for (const skill of skills) {
    const unknown = skill.conflicts.filter(id => !ids.has(id));
    if (unknown.length) throw new Error(`Invalid skill definition ${skill.id}: unknown conflict skill(s): ${unknown.join(', ')}`);
  }
  return skills;
}

function normalize(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}
function triggerMatches(taskTokens, trigger) {
  const words = normalize(trigger);
  return words.length > 0 && words.every(word => taskTokens.has(word));
}

export function resolveSkills(task, { skillsDir = defaultSkillsDir, maxSkills = 5 } = {}) {
  if (typeof task !== 'string' || !task.trim()) throw new TypeError('A non-empty task description is required.');
  if (!Number.isInteger(maxSkills) || maxSkills < 0) throw new TypeError('maxSkills must be a non-negative integer.');
  const taskTokens = new Set(normalize(task));
  const matched = discoverSkills(skillsDir).map(skill => {
    const matchedTriggers = skill.triggers.filter(trigger => triggerMatches(taskTokens, trigger));
    const blockedBy = skill.excludeTriggers.filter(trigger => triggerMatches(taskTokens, trigger));
    return { ...skill, matchedTriggers, score: matchedTriggers.length, blockedBy,
      reason: matchedTriggers.length ? `Matched trigger(s): ${matchedTriggers.join(', ')}` : '' };
  }).filter(skill => skill.score > 0);
  const activated = [];
  const skipped = [];
  for (const candidate of matched.filter(skill => skill.blockedBy.length)) {
    skipped.push({ id: candidate.id, name: candidate.name, reason: 'Blocked by exclusion trigger', matchedTriggers: candidate.blockedBy });
  }
  const eligible = matched.filter(skill => skill.score > 0 && skill.blockedBy.length === 0)
    .sort((a, b) => b.priority - a.priority || b.score - a.score || a.id.localeCompare(b.id));
  for (const candidate of eligible) {
    const conflict = activated.find(selected =>
      candidate.conflicts.includes(selected.id) || selected.conflicts.includes(candidate.id));
    if (conflict) {
      skipped.push({ id: candidate.id, name: candidate.name,
        reason: `Conflict with higher-ranked skill: ${conflict.id}`,
        conflictWith: conflict.id, matchedTriggers: candidate.matchedTriggers });
      continue;
    }
    if (activated.length >= maxSkills) {
      skipped.push({ id: candidate.id, name: candidate.name,
        reason: 'Maximum skill limit reached', matchedTriggers: candidate.matchedTriggers });
      continue;
    }
    activated.push({ ...candidate, reason: `${candidate.reason}; priority ${candidate.priority}` });
  }
  return { task, activated, skipped };
}

export function activateSkills(task, options = {}) {
  return resolveSkills(task, options).activated;
}

export function recordActivation(result, { ledgerPath = defaultLedgerPath, task = result.task } = {}) {
  if (!result || !Array.isArray(result.activated) || !Array.isArray(result.skipped)) {
    throw new TypeError('A resolved skill activation result is required.');
  }
  const entry = {
    timestamp: new Date().toISOString(), task,
    activated: result.activated.map(skill => ({
      id: skill.id, priority: skill.priority, matchedTriggers: skill.matchedTriggers, reason: skill.reason
    })),
    skipped: result.skipped.map(skill => ({
      id: skill.id, reason: skill.reason, conflictWith: skill.conflictWith ?? null
    }))
  };
  mkdirSync(path.dirname(path.resolve(ledgerPath)), { recursive: true });
  appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' });
  return entry;
}

export function readActivationLedger({ ledgerPath = defaultLedgerPath, limit = 20 } = {}) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer.');
  let content;
  try { content = readFileSync(ledgerPath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return content.split(/\r?\n/).filter(Boolean).slice(-limit).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`Invalid activation ledger entry near recent row ${index + 1}.`); }
  });
}

export function getSkill(id, { skillsDir = defaultSkillsDir } = {}) {
  return discoverSkills(skillsDir).find(skill => skill.id === id) ?? null;
}
