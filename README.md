# AIPowers

**The Original AI Coding Agent Development System.**

AIPowers is an independent, modular system being built to help AI coding agents understand developer intent, design solutions, plan implementation, build software, test changes, review code, debug failures, and verify delivery.

## Development principles

- Understand the task before changing code.
- Design and agree on the approach before substantial implementation.
- Use small, testable implementation steps.
- Prefer test-first development for behavior changes.
- Investigate root causes instead of guessing.
- Verify results before claiming completion.
- Keep capabilities inspectable, modular, and under developer control.

## Current implementation

Implemented in version `0.1.0`:

- Node.js CLI with help, version, and runtime diagnostics.
- Skills Engine with deterministic matching, priorities, conflict resolution, and exclusion triggers.
- Append-only JSONL activation ledger.
- Agent Context Adapter that generates a Markdown handoff and machine-readable JSON manifest, including the most relevant active project memories.
- Project Memory Store with categories, tags, deterministic retrieval, 1–3650 day or permanent retention, and explicit removal/pruning.
- Hash-linked project memory change ledger, integrity audit, credential-like material rejection, and cross-process write locking.
- **Codex native skills exporter** that converts AIPowers JSON skills into Codex-compatible project skills under `.agents/skills/`.
- Safe reinstallation: updates only skill files marked as AIPowers-managed and refuses to overwrite unowned skill files.
- Six core workflow skills: brainstorming, implementation planning, TDD, systematic debugging, verification, and code review.
- Automated unit and CLI tests.
- Approval-gated Workflow Engine with proposed, approved, active, blocked, completed, and cancelled states, persisted steps, and an integrity-checked event chain.
- Provider-neutral Execution Adapter Registry with Codex as the first provider; approved, dependency-ready steps run in an ephemeral Codex CLI session with the workspace-write sandbox, and human review remains required.
- Dependency-aware Workflow Scheduler with validated DAGs, ready/waiting/blocked step reporting, per-step provider assignments, and dependency/provider enforcement at execution and completion.
- Multi-provider Run-ready Orchestrator that routes each ready step to its assigned adapter (or a default provider), coordinates bounded concurrency independently per provider, respects the human-review gate before dependent steps, and stops on failures.
- Durable execution-attempt history, attached provider process IDs, automatic supervision of exited processes, live-process-aware recovery, and explicit confirmation before recovering untracked/orphaned attempts.
- `workflow events <id>` to inspect the integrity-checked audit history for a workflow.
- `workflow audit` to check index consistency, state snapshots, audit checkpoints, and potentially orphaned running attempts.
- `workflow migrate-checkpoint <id>` to explicitly add a state checkpoint to a valid legacy workflow audit chain.
- Immutable state snapshots per workflow transition, with `workflow replay <id>` to reconstruct the recorded state sequence and `workflow restore <id>` to recover a corrupted current snapshot from the latest verified checkpoint.
- `workflow providers` to list registered execution adapters and their concurrency limits.
- Cross-process workflow/index/event-ledger locks and optimistic state-hash conflict detection to prevent silent lost updates.
- Verification Runner with fixed `test` and `check` profiles, timeouts, bounded output capture, and automatic evidence recording.
- Execution Evidence Ledger with SHA-256 output fingerprints and a hash-linked append-only record chain.
- `aipowers verify test` / `aipowers verify check` to run fixed verification profiles and automatically record results.
- `aipowers evidence list` to inspect recorded verification outcomes.
- `aipowers memory set/list/get/search/remove/prune/audit/events` to manage explicit project memory.
- `aipowers quality check <workflow-id>` to gate completion on finished steps and fresh, passing verification evidence.

The Codex exporter writes native skill files for Codex to discover in a new session. The separate Codex execution adapter can run an approved workflow step using `codex exec`, an ephemeral session, and the `workspace-write` sandbox. Successful CLI execution records the step as `executed`, not `completed`; a human must review it and explicitly mark it complete. The adapter is unit-tested with a simulated host process, but live Codex authentication and skill recognition remain unverified and are intentionally deferred.

The verification runner supports two fixed profiles: `test` runs `npm test`, and `check` runs `npm run check`. It does not accept arbitrary shell commands. These profiles execute the target project's npm scripts, so only run them in projects whose package scripts you trust. Execution is bounded by a timeout and output-capture limit. Results are automatically written to that project's `.aipowers/execution-ledger.jsonl`.

The workflow engine turns a task into steps based on matched AIPowers skills. Workflows begin in `proposed`; an explicit `workflow approve <id>` is required before `workflow start <id>`. Steps may declare `dependsOn` relationships; cycles and invalid dependencies are rejected. Use `workflow next <id>` to see ready, waiting, and dependency-blocked steps. Each workflow step may optionally declare a provider ID; the orchestrator routes it to that registered adapter, while unassigned steps use the selected default provider. Independent steps assigned to different providers can run concurrently, each constrained by its adapter's declared capacity. The provider registry currently ships with Codex as its only built-in provider; host integrations can register additional adapters. Agent-run steps are recorded as `executed` or `failed`; successful output remains pending human review until `workflow step done`. Failed steps can be reset with `workflow retry`. Running attempts are persisted before launch, and supported adapters attach the spawned provider PID. After an interruption, `workflow supervise <id>` marks attempts failed only when their attached provider PID no longer appears alive, leaves live processes unchanged, and reports untracked attempts. `workflow recover <id> --confirm-orphaned` is reserved for untracked attempts and requires explicit operator confirmation. Workflows can be blocked/resumed/cancelled, and state is persisted under `.aipowers/workflows/` with an integrity-checked append-only event ledger.

The completion quality gate requires all workflow steps to be complete and the latest verification record to be passing, non-truncated, and newer than the final workflow update. It is a deterministic gate, not a substitute for human review or proof that the software is defect-free.

The evidence module can also record verification results supplied by an external agent/host adapter. It does not independently prove that a caller's claims are true. Raw stdout/stderr are not stored; only their SHA-256 fingerprints and byte counts are retained.

## Requirements

Node.js 20 or newer.

## Quick start

From the AIPowers repository:

```bash
npm install
npm run check
node src/cli.js help
node src/cli.js skills list
node src/cli.js codex install
node src/cli.js memory set project-direction project 365 "AIPowers is an independent, modular coding-agent development system."
node src/cli.js memory search "coding agent system"
node src/cli.js agent prepare "write tests first for a new feature"
node src/cli.js workflow create "write tests first for a new feature"
node src/cli.js workflow list
node src/cli.js workflow approve <workflow-id>
node src/cli.js workflow start <workflow-id>
node src/cli.js workflow next <workflow-id>
node src/cli.js workflow events <workflow-id>
node src/cli.js workflow audit
node src/cli.js workflow migrate-checkpoint <workflow-id>
node src/cli.js workflow restore <workflow-id>
node src/cli.js workflow replay <workflow-id>
node src/cli.js workflow providers
node src/cli.js workflow run codex <workflow-id> <step-id>
# Orchestrate ready steps in provider-supported bounded batches:
node src/cli.js workflow run-ready codex <workflow-id>
# Codex currently declares a concurrency limit of 1; parallel providers can opt in via their adapter capability.
# or use the compatibility shortcut:
node src/cli.js workflow run-codex <workflow-id> <step-id>
# after an interrupted provider process:
node src/cli.js workflow supervise <workflow-id>
node src/cli.js workflow recover <workflow-id> --confirm-orphaned
# Only after confirming the provider process has actually stopped.
node src/cli.js workflow step done <workflow-id> <step-id>
node src/cli.js workflow retry <workflow-id> <step-id>
node src/cli.js verify check
node src/cli.js quality check <workflow-id>
node src/cli.js evidence list
```

To install AIPowers skills into another project:

```bash
node /path/to/AIPowers-Original/src/cli.js codex install "C:\path\to\your-project"
```

This creates:

- `.agents/skills/aipowers-<skill-id>/SKILL.md` — native Codex-discoverable skill files.
- `.aipowers/codex-integration.json` — integration manifest.

Start a **new Codex session** in the target project so it can discover the installed skills. Codex's own skill selection determines when to use them; AIPowers' deterministic task router is a separate local feature.

To prepare a task-specific handoff:

```bash
node src/cli.js agent prepare "debug this bug and add a regression test"
```

This creates:

- `.aipowers/agent-context.md` — human-readable task and workflow handoff.
- `.aipowers/agent-context.json` — structured manifest.
- `.aipowers/activation-ledger.jsonl` — append-only skill-selection history.

## Skill definition format

Add a `.json` file to the `skills/` directory:

```json
{
  "id": "example-skill",
  "name": "Example Skill",
  "description": "What this workflow helps an agent do.",
  "triggers": ["example task", "another trigger"],
  "priority": 50,
  "conflicts": ["another-skill"],
  "excludeTriggers": ["do not use example workflow"],
  "instructions": "Clear, actionable instructions for the coding agent."
}
```

Required fields are `id`, `name`, `description`, `triggers`, and `instructions`. IDs must be unique lowercase slugs. Priority is an integer from -1000 to 1000 (default 0). Conflict entries must reference existing skill IDs. Exclusion triggers suppress a skill even when a positive trigger matches.

## Roadmap

1. Validate live Codex authentication and native skill discovery when explicitly resumed; live host testing remains deferred at the user's direction.
2. Add additional provider adapters to the new provider-neutral registry.
3. Add background heartbeat supervision and provider-exit event hooks beyond on-demand PID supervision and snapshot-backed history replay.
4. Build semantic evaluation, safety, and permission gates beyond the deterministic completion check.
5. Add cross-project memory portability and richer semantic retrieval beyond the current project-local deterministic memory store.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the [Execution Adapter Contract](docs/ADAPTERS.md) for registering additional trusted providers.

## License

MIT. See [LICENSE](LICENSE).

## Sensitive execution permissions

Workflow steps default to `workspace-read` and `workspace-write`. Steps that request consequential permissions such as `network-access`, `external-side-effect`, `database-write`, `deployment`, `destructive`, or `secrets-access` require separate step-level approval after their dependencies are complete. Use `workflow step approve <workflow-id> <step-id>` to authorize that step. The selected execution adapter must also declare every requested capability; the built-in Codex adapter currently supports only workspace read/write. Approval is an explicit workflow control, not a substitute for the provider's actual sandbox or operating-system security.
