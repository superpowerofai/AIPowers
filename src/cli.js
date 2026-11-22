#!/usr/bin/env node
import process from 'node:process';

const [command = 'help', ...args] = process.argv.slice(2);
const version = '0.1.0';
const help = `AIPowers ${version}\nOriginal AI Agent Ecosystem\n\nUsage:\n  aipowers help       Show this help\n  aipowers version    Show version\n  aipowers doctor     Check the local runtime\n  aipowers agents     Show the agent platform roadmap\n`;

switch (command) {
  case 'help': case '--help': case '-h': process.stdout.write(help); break;
  case 'version': case '--version': case '-v': process.stdout.write(`${version}\n`); break;
  case 'doctor': {
    const major = Number(process.versions.node.split('.')[0]);
    const ok = major >= 20;
    process.stdout.write(`AIPowers Doctor\nNode.js: ${process.versions.node} ${ok ? 'OK' : 'NEEDS Node 20+'}\n`);
    if (!ok) process.exitCode = 1;
    break;
  }
  case 'agents':
    process.stdout.write('AIPowers agent platform roadmap\n- Agent Runtime\n- Skills & Tools Registry\n- Workflow Orchestrator\n- Memory & Context\n- Evaluation & Safety\n- Integrations\n');
    break;
  default:
    process.stderr.write(`Unknown command: ${args[0] ?? command}\nRun aipowers help.\n`);
    process.exitCode = 2;
}
