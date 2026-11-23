import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverSkills, activateSkills, getSkill, resolveSkills, recordActivation, readActivationLedger } from '../src/skills.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'aipowers-skills-'));
  const dir = path.join(root, 'skills');
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'tdd.json'), JSON.stringify({
    id: 'test-driven-development', name: 'Test-Driven Development',
    description: 'Write tests before implementation and verify behavior.',
    triggers: ['write tests', 'test driven development', 'failing test'],
    priority: 50, conflicts: ['systematic-debugging'],
    instructions: 'RED: write a failing test. GREEN: implement the smallest change. REFACTOR: improve safely.'
  }));
  writeFileSync(path.join(dir, 'debug.json'), JSON.stringify({
    id: 'systematic-debugging', name: 'Systematic Debugging',
    description: 'Find root causes before changing code.',
    triggers: ['debug', 'bug', 'root cause'], priority: 80,
    conflicts: ['test-driven-development'],
    instructions: 'Reproduce the issue, isolate the cause, then verify the fix.'
  }));
  writeFileSync(path.join(dir, 'review.json'), JSON.stringify({
    id: 'code-review', name: 'Code Review', description: 'Review changes for defects.',
    triggers: ['review code'], priority: 20,
    excludeTriggers: ['do not review code'], instructions: 'Review the diff.'
  }));
  return { root, dir };
}

test('discovers valid skills and applies metadata defaults', () => {
  const f = fixture();
  try {
    const skills = discoverSkills(f.dir);
    assert.equal(skills.length, 3);
    assert.ok(skills.some(skill => skill.id === 'test-driven-development'));
    assert.equal(skills.find(skill => skill.id === 'code-review').priority, 20);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('automatically activates matching skills and explains why', () => {
  const f = fixture();
  try {
    const result = activateSkills('Please write tests first and use test driven development', { skillsDir: f.dir });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'test-driven-development');
    assert.ok(result[0].matchedTriggers.length >= 1);
    assert.ok(result[0].reason.includes('Matched'));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('does not activate unrelated skills', () => {
  const f = fixture();
  try { assert.deepEqual(activateSkills('Design a landing page color palette', { skillsDir: f.dir }), []); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('retrieves a skill by id', () => {
  const f = fixture();
  try {
    assert.equal(getSkill('systematic-debugging', { skillsDir: f.dir }).name, 'Systematic Debugging');
    assert.equal(getSkill('missing', { skillsDir: f.dir }), null);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects malformed skill definitions with a useful error', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.dir, 'bad.json'), '{"id":"bad"}');
    assert.throws(() => discoverSkills(f.dir), /Invalid skill definition/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('resolves conflicts using priority and reports skipped skills', () => {
  const f = fixture();
  try {
    const result = resolveSkills('debug the bug and write tests for it', { skillsDir: f.dir });
    assert.deepEqual(result.activated.map(skill => skill.id), ['systematic-debugging']);
    assert.equal(result.skipped[0].id, 'test-driven-development');
    assert.match(result.skipped[0].reason, /[Cc]onflict/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('exclusion triggers prevent unwanted activation', () => {
  const f = fixture();
  try {
    const result = resolveSkills('review code; do not review code', { skillsDir: f.dir });
    assert.equal(result.activated.length, 0);
    assert.equal(result.skipped[0].reason, 'Blocked by exclusion trigger');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('activation ledger appends and reads auditable decisions', () => {
  const f = fixture();
  try {
    const result = resolveSkills('review code', { skillsDir: f.dir });
    const ledgerPath = path.join(f.root, 'ledger.jsonl');
    recordActivation(result, { ledgerPath, task: 'review code' });
    recordActivation(result, { ledgerPath, task: 'review code again' });
    const rows = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].activated[0].id, 'code-review');
    assert.equal(rows[0].task, 'review code');
    assert.ok(rows[0].timestamp);
    assert.equal(readActivationLedger({ ledgerPath, limit: 1 }).length, 1);
    assert.equal(readActivationLedger({ ledgerPath, limit: 1 })[0].task, 'review code again');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects invalid priority and conflict references', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.dir, 'invalid.json'), JSON.stringify({
      id: 'invalid', name: 'Invalid', description: 'Invalid skill',
      triggers: ['invalid'], priority: 'highest', conflicts: ['../unsafe'],
      instructions: 'Do not use.'
    }));
    assert.throws(() => discoverSkills(f.dir), /Invalid skill definition/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
