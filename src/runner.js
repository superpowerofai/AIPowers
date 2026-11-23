import { spawn } from 'node:child_process';
import { recordVerification } from './evidence.js';
import path from 'node:path';

export const verificationProfiles = Object.freeze({
  test: Object.freeze({ executable: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['test'] }),
  check: Object.freeze({ executable: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['run', 'check'] })
});

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export function runVerification(profile, {
  cwd = process.cwd(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ledgerPath,
  env = process.env
} = {}) {
  const selected = verificationProfiles[profile];
  if (!selected) throw new TypeError(`Unknown verification profile "${profile}". Allowed profiles: ${Object.keys(verificationProfiles).join(', ')}.`);
  if (typeof cwd !== 'string' || !cwd.trim()) throw new TypeError('cwd must be a non-empty directory path.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new TypeError('timeoutMs must be an integer between 1 and 600000.');
  }

  const startedAt = new Date().toISOString();
  const start = process.hrtime.bigint();
  const executable = selected.executable;
  const args = [...selected.args];
  const workingDirectory = path.resolve(cwd);

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputTruncated = false;
    let settled = false;
    const windowsCommand = process.platform === 'win32' ? [executable, ...args].join(' ') : null;
    const child = process.platform === 'win32'
      ? spawn(windowsCommand, { cwd: workingDirectory, env, windowsHide: true, shell: true })
      : spawn(executable, args, { cwd: workingDirectory, env, windowsHide: true, shell: false });

    const appendBounded = (current, chunk) => {
      const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current, 'utf8');
      if (remaining <= 0) {
        outputTruncated = true;
        return current;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (buffer.length > remaining) outputTruncated = true;
      return current + buffer.subarray(0, remaining).toString('utf8');
    };

    child.stdout?.on('data', chunk => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on('data', chunk => { stderr = appendBounded(stderr, chunk); });
    let timer;
    child.once('error', error => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });

    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const completedAt = new Date().toISOString();
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const exitCode = timedOut ? 124 : (Number.isInteger(code) ? code : 1);
      const command = [executable, ...args].join(' ');
      const result = {
        profile,
        command,
        cwd: workingDirectory,
        exitCode,
        status: exitCode === 0 ? 'passed' : 'failed',
        timedOut,
        signal: signal ?? null,
        durationMs,
        startedAt,
        completedAt,
        outputTruncated,
        stdout,
        stderr
      };
      try {
        result.evidence = recordVerification({
          command: `${command} (cwd: ${workingDirectory})`,
          exitCode,
          durationMs,
          startedAt,
          completedAt,
          stdout,
          stderr,
          timedOut,
          outputTruncated
        }, { ledgerPath: ledgerPath ?? path.join(workingDirectory, '.aipowers', 'execution-ledger.jsonl') });
      } catch (error) {
        reject(new Error(`Verification finished, but evidence could not be recorded: ${error.message}`, { cause: error }));
        return;
      }
      resolve(result);
    });
  });
}
