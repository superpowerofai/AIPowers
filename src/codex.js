import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { discoverSkills, defaultSkillsDir } from './skills.js';

const managedMarker = '<!-- AIPOWERS:MANAGED -->';

function renderCodexSkill(skill) {
  const name = `aipowers-${skill.id}`;
  const description = `${skill.description} Use when task matches these triggers: ${skill.triggers.join(', ')}.`;
  return `---
name: ${name}
description: ${JSON.stringify(description)}
---

${managedMarker}

# ${skill.name}

This skill is maintained by AIPowers. Follow the workflow below when this skill applies.

## Activation details

- AIPowers skill ID: ${skill.id}
- Priority: ${skill.priority}
- Triggers: ${skill.triggers.join(', ')}

## Instructions

${skill.instructions}
`;
}

export function installCodexSkills({
  targetDir = process.cwd(),
  skillsDir = defaultSkillsDir,
  installedAt = new Date().toISOString()
} = {}) {
  const projectDir = path.resolve(targetDir);
  const skills = discoverSkills(skillsDir);
  const codexSkillsDir = path.join(projectDir, '.agents', 'skills');

  // Preflight every destination before writing anything. Never replace user-owned skills.
  const destinations = skills.map(skill => {
    const folder = `aipowers-${skill.id}`;
    const directory = path.join(codexSkillsDir, folder);
    const file = path.join(directory, 'SKILL.md');
    let existing = null;
    try { existing = readFileSync(file, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if ((existing !== null && !existing.includes(managedMarker)) || (existing === null && existsSync(directory))) {
      throw new Error(`Codex skill "${folder}" already exists and is not managed by AIPowers. It was left unchanged.`);
    }
    return { skill, folder, directory, file };
  });

  for (const item of destinations) {
    mkdirSync(item.directory, { recursive: true });
    writeFileSync(item.file, renderCodexSkill(item.skill), 'utf8');
  }

  const manifest = {
    schemaVersion: 1,
    host: 'codex',
    installedAt,
    projectDir,
    skillRoot: path.relative(projectDir, codexSkillsDir).replaceAll(path.sep, '/'),
    skills: destinations.map(item => item.folder)
  };
  const stateDir = path.join(projectDir, '.aipowers');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, 'codex-integration.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  return { ...manifest, installed: destinations.map(item => ({
    id: item.skill.id, name: item.skill.name, directory: item.directory, file: item.file
  })) };
}
