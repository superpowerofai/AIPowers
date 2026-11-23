import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installCodexSkills } from '../src/codex.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'aipowers-codex-'));
  const skillsDir = path.join(root, 'source-skills');
  const targetDir = path.join(root, 'target');
  mkdirSync(skillsDir);
  mkdirSync(targetDir);
  writeFileSync(path.join(skillsDir, 'tdd.json'), JSON.stringify({
    id: 'test-driven-development', name: 'Test-Driven Development',
    description: 'Write tests before implementation.', triggers: ['write tests', 'test driven development'],
    priority: 80, instructions: 'RED, GREEN, REFACTOR.'
  }));
  return { root, skillsDir, targetDir };
}

test('exports AIPowers definitions as native Codex project skills', () => {
  const f = fixture();
  try {
    const result = installCodexSkills({ skillsDir: f.skillsDir, targetDir: f.targetDir });
    assert.equal(result.installed.length, 1);
    const skillPath = path.join(f.targetDir, '.agents', 'skills', 'aipowers-test-driven-development', 'SKILL.md');
    const content = readFileSync(skillPath, 'utf8');
    assert.match(content, /^---\nname: aipowers-test-driven-development\ndescription:/);
    assert.match(content, /AIPOWERS:MANAGED/);
    assert.match(content, /Triggers: write tests, test driven development/);
    assert.match(content, /RED, GREEN, REFACTOR/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('writes a manifest and updates only AIPowers-managed skills on repeat install', () => {
  const f = fixture();
  try {
    installCodexSkills({ skillsDir: f.skillsDir, targetDir: f.targetDir });
    const result = installCodexSkills({ skillsDir: f.skillsDir, targetDir: f.targetDir });
    assert.equal(result.installed.length, 1);
    const manifest = JSON.parse(readFileSync(path.join(f.targetDir, '.aipowers', 'codex-integration.json'), 'utf8'));
    assert.equal(manifest.host, 'codex');
    assert.deepEqual(manifest.skills, ['aipowers-test-driven-development']);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('refuses to overwrite a skill directory not owned by AIPowers', () => {
  const f = fixture();
  try {
    const dir = path.join(f.targetDir, '.agents', 'skills', 'aipowers-test-driven-development');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), '# My existing skill\n');
    assert.throws(() => installCodexSkills({ skillsDir: f.skillsDir, targetDir: f.targetDir }), /not managed by AIPowers/);
    assert.equal(readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), '# My existing skill\n');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('refuses to take over an existing incomplete skill directory', () => {
  const f = fixture();
  try {
    const dir = path.join(f.targetDir, '.agents', 'skills', 'aipowers-test-driven-development');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'notes.txt'), 'User-owned content');
    assert.throws(() => installCodexSkills({ skillsDir: f.skillsDir, targetDir: f.targetDir }), /not managed by AIPowers/);
    assert.equal(readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'User-owned content');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
