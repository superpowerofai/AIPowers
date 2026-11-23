import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareAgentContext } from '../src/agent.js';
import { setMemoryEntry } from '../src/memory.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'aipowers-agent-'));
  const skillsDir = path.join(root, 'skills');
  mkdirSync(skillsDir);
  writeFileSync(path.join(skillsDir, 'tdd.json'), JSON.stringify({
    id: 'test-driven-development', name: 'Test-Driven Development',
    description: 'Use tests to guide implementation.', triggers: ['write tests'],
    priority: 80, instructions: 'RED, GREEN, REFACTOR.'
  }));
  return { root, skillsDir, outputDir: path.join(root, '.aipowers') };
}

test('prepares a portable agent context with selected skill instructions', () => {
  const f = fixture();
  try {
    const result = prepareAgentContext('write tests for the parser', {
      skillsDir: f.skillsDir, outputDir: f.outputDir,
      generatedAt: '2026-11-23T00:00:00.000Z'
    });
    assert.equal(result.activated.length, 1);
    assert.match(result.markdown, /AIPowers Agent Context/);
    assert.match(result.markdown, /RED, GREEN, REFACTOR/);
    assert.match(result.markdown, /write tests for the parser/);
    assert.equal(result.manifest.task, 'write tests for the parser');
    assert.equal(result.manifest.activated[0].id, 'test-driven-development');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('writes both context artifacts to the requested output directory', () => {
  const f = fixture();
  try {
    prepareAgentContext('write tests', { skillsDir: f.skillsDir, outputDir: f.outputDir });
    assert.match(readFileSync(path.join(f.outputDir, 'agent-context.md'), 'utf8'), /AIPowers Agent Context/);
    const manifest = JSON.parse(readFileSync(path.join(f.outputDir, 'agent-context.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 1);
    assert.ok(manifest.generatedAt);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('does not invent skills when no trigger matches', () => {
  const f = fixture();
  try {
    const result = prepareAgentContext('rename a variable', { skillsDir: f.skillsDir, outputDir: f.outputDir });
    assert.equal(result.activated.length, 0);
    assert.match(result.markdown, /No workflow skills were activated/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rejects empty tasks before creating output', () => {
  const f = fixture();
  try {
    assert.throws(() => prepareAgentContext('  ', { skillsDir: f.skillsDir, outputDir: f.outputDir }), /task/i);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});


test('injects only relevant, unexpired project memory into the agent context package', () => {
  const f = fixture();
  try {
    setMemoryEntry('database-architecture', 'The project uses PostgreSQL and Prisma migrations for relational data.', {
      memoryPath: path.join(f.outputDir, 'project-memory.json'),
      eventPath: path.join(f.outputDir, 'project-memory-events.jsonl'),
      category: 'architecture', tags: ['database', 'postgres']
    });
    setMemoryEntry('brand-language', 'Use concise and direct product copy.', {
      memoryPath: path.join(f.outputDir, 'project-memory.json'),
      eventPath: path.join(f.outputDir, 'project-memory-events.jsonl'),
      category: 'convention', tags: ['copy']
    });
    const result = prepareAgentContext('implement PostgreSQL database migrations', {
      skillsDir: f.skillsDir, outputDir: f.outputDir
    });
    assert.equal(result.manifest.memory.length, 1);
    assert.equal(result.manifest.memory[0].key, 'database-architecture');
    assert.match(result.markdown, /The project uses PostgreSQL and Prisma migrations/);
    assert.match(result.markdown, /user-authored context/);

    const withoutMemory = prepareAgentContext('implement PostgreSQL database migrations', {
      skillsDir: f.skillsDir, outputDir: f.outputDir, maxMemoryEntries: 0
    });
    assert.equal(withoutMemory.manifest.memory.length, 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
