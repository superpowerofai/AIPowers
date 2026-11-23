# AIPowers Architecture

AIPowers is an independent coding-agent development system. It is being built as modular developer tooling and methodology—not as a claim that a fully autonomous coding runtime already exists.

## Implemented foundation

### Skills Engine

- Discovers `.json` skill definitions from the repository's `skills/` directory.
- Validates required fields, unique IDs, priority ranges, and conflict references.
- Matches task descriptions against explicit trigger phrases.
- Applies exclusion triggers and deterministic conflict resolution.
- Returns activated and skipped candidates with transparent explanations.

The matcher is deterministic keyword/phrase matching. It is not semantic model-based routing.

### Agent Context Adapter

The provider-neutral adapter creates `.aipowers/agent-context.md` and `.aipowers/agent-context.json` with task instructions, selected skills, relevant active project memories, and skipped decisions. Memory retrieval is deterministic and capped at 10 entries (5 by default). It does not launch or inject into a live agent session.

### Project Memory & Context

`src/memory.js` stores explicit project-scoped notes in `.aipowers/project-memory.json` and records mutations in a hash-linked `.aipowers/project-memory-events.jsonl` ledger. Entries have a lowercase key, category, tags, content, and explicit retention: 1–3650 days or permanent until explicitly removed. Expired entries are excluded from retrieval but are not deleted automatically; `memory prune --confirm` requires explicit confirmation. Removal also requires confirmation. Credential-like content is rejected, and state/ledger integrity plus cross-process writes are checked. Search is deterministic keyword scoring, not semantic model retrieval.

CLI entry points: `aipowers memory list`, `set`, `get`, `search`, `remove`, `prune`, `audit`, and `events`. `agent prepare` injects only the top relevant unexpired memories into the generated context package; memory is treated as user-authored context, not higher-priority instructions.

### Codex Native Skills Exporter

The Codex adapter converts each validated AIPowers JSON skill into a native skill directory:

`<project>/.agents/skills/aipowers-<skill-id>/SKILL.md`

Each generated file contains Codex skill frontmatter (`name` and `description`), trigger phrases, priority metadata, original workflow instructions, and an AIPowers ownership marker.

CLI entry point: `aipowers codex install [project-path]`.

The exporter preflights all destination files before writing. It updates only files carrying the AIPowers marker and refuses to overwrite an existing unowned skill. It writes an integration manifest to `.aipowers/codex-integration.json`.

This uses Codex's documented project skill discovery convention. The exporter does not launch Codex, invoke a model, guarantee skill selection, or prove that the host loaded the files. Codex CLI 0.171.0 is installed and launches, but live AIPowers skill recognition is intentionally unverified.

### Approval-gated Workflow Engine

`src/workflow.js` creates persisted workflows with validated dependency graphs, enforces explicit approval before start, tracks pending/running/executed/failed/completed steps with optional per-step provider assignment, supports retry and blocked/resumed/cancelled states, and maintains a hash-linked workflow event ledger. Its scheduler reports ready, waiting, and dependency-blocked steps; execution and human completion both reject steps whose dependencies are unfinished. Execution attempts are persisted before the provider process starts; the Codex adapter attaches the spawned child PID to the running attempt. Mutations use cross-process lock files for workflow state and the shared event/index files, plus optimistic state-hash checks to reject stale concurrent updates rather than overwrite them. `workflow supervise <id>` marks attempts failed when an attached provider PID no longer appears alive, leaves live processes unchanged, and reports untracked attempts. `workflow recover <id> --confirm-orphaned` is reserved for untracked attempts and requires explicit operator confirmation before converting running attempts into interrupted failures while preserving attempt history, allowing inspection and explicit retry instead of silently losing state. The CLI exposes `workflow next <id>`, `workflow status <id>`, and `workflow supervise <id>` to inspect this schedule, plus `workflow events <id> [limit]` to inspect the verified event history for one workflow and `workflow audit` to check index/snapshot consistency, event checkpoints, and running attempts. `workflow migrate-checkpoint <id>` adds a verifiable state checkpoint to a valid legacy audit history. Each transition also persists an immutable state snapshot; `workflow replay <id>` reconstructs the historical state sequence from event-linked snapshots, while `workflow restore <id>` restores a damaged current snapshot from the latest event-verified checkpoint and records the restoration. `workflow providers` lists the currently registered adapters and their concurrency limits. The CLI exposes `workflow create`, `list`, `show`, `next`, `status`, `approve`, `start`, provider-neutral `run`, bounded `run-ready`, the `run-codex` shortcut, confirmed `recover`, `step done`, `retry`, `block`, `resume`, and `cancel`. Workflow state is local and project-scoped. The provider-neutral registry in `src/adapters/registry.js` dispatches workflow steps through explicitly registered adapters; Codex is the only built-in provider. A step may declare its own provider ID, and the orchestrator routes independent steps to the corresponding adapters, coordinating concurrency separately against each provider's declared capacity. Host integrations can register additional adapters. `src/orchestrator.js` runs currently ready independent steps in bounded batches, constrained by each registered provider's declared `maxConcurrency` capability and a per-pass step limit. It waits for all steps in a batch, stops subsequent batches on provider failure, and waits for human review before dependent steps become runnable. Codex currently declares `maxConcurrency: 1`. CLI entry point: `workflow run-ready <provider> <id>`. The Codex execution adapter in `src/adapters/codex.js` can consume one dependency-ready pending step from an active (therefore explicitly approved and started) workflow and launch `codex exec` with an ephemeral session and the `workspace-write` sandbox. It records a successful process as `executed`, not `completed`; human review is required before `step done`. The adapter has simulated-process unit coverage, but live authentication and host skill recognition remain unverified. The workflow engine does not silently mark agent output as reviewed.

### Completion Quality Gate

`src/quality.js` evaluates a workflow against its persisted state, integrity-checked workflow events, and the target project's verification evidence. Completion is blocked unless every step is complete and the latest verification passed without timeout or output truncation after the final workflow update. CLI entry point: `aipowers quality check <workflow-id>`. This is a deterministic evidence gate, not a semantic code review or a guarantee of software correctness.

### Execution Evidence Ledger

`src/evidence.js` exposes `recordVerification()` and `readExecutionLedger()` for host adapters. A verification record stores the command, exit code, duration, timestamps, output fingerprints, and a SHA-256 hash linked to the previous record. The reader validates the complete chain before returning recent entries. Raw stdout/stderr are not persisted.

`src/runner.js` adds a constrained process adapter with two fixed profiles (`npm test` and `npm run check`), a maximum runtime, bounded output capture, timeout/truncation flags, and automatic recording into the target project's `.aipowers/execution-ledger.jsonl`. It does not accept arbitrary command strings. Because npm profiles execute project-defined scripts, callers must trust the target project's package scripts. The ledger still cannot independently prove that a caller-supplied result is truthful. CLI entry points: `aipowers verify <test|check> [project-path]` and `aipowers evidence list [limit]`.

### Activation ledger

Skill routing decisions are appended to `.aipowers/activation-ledger.jsonl`. It records routing decisions only, not agent execution, outputs, tool actions, or compliance evidence.

## Planned modules

- **Live Agent Adapters:** host-specific context injection and lifecycle hooks beyond native skill discovery.
- **Development Workflow:** intent discovery, design proposals, and richer implementation plans beyond the initial approval-gated workflow state machine.
- **Orchestration:** multi-agent delegation and dynamic provider discovery beyond per-step multi-provider routing and provider-capability-bounded run-ready batches; core workflow writes now use cross-process locks and stale-state rejection.
- **Engineering Workflows:** TDD, systematic debugging, code review, and verification as connected execution stages.
- **Workflow Recovery:** background heartbeat supervision and provider-exit event hooks beyond on-demand PID supervision, explicit orphan recovery, and snapshot-backed history replay.
- **Advanced Evaluation & Safety:** semantic code review, behavioral evaluations, broader permission gates, and audit events beyond the initial deterministic completion gate.

## Design constraints

1. No hidden tool execution: capabilities declare inputs, outputs, and permissions.
2. Human approval for consequential external actions.
3. Provider-neutral interfaces; provider-specific behavior stays in adapters.
4. Reproducible tests and explicit runtime requirements.
5. Roadmap items are not described as implemented capabilities.
6. Completion claims require fresh verification evidence.

## Next engineering milestone

Dependency-aware scheduling, durable execution-attempt recovery, and a provider-neutral adapter registry are implemented and unit-tested with simulated processes. Live Codex authentication and native skill recognition remain intentionally untested at the user's direction. Bounded provider-capability concurrency and concurrency-safe workflow writes are implemented. The next engineering milestone is background heartbeat supervision and additional built-in provider adapters; project memory is currently local, explicit, and keyword-retrieved.

### Sensitive step permissions

Workflow steps declare a bounded list of lowercase permission identifiers. The initial sensitive set (`network-access`, `external-side-effect`, `database-write`, `deployment`, `destructive`, and `secrets-access`) requires separate approval after dependencies are complete. Approval is persisted in the workflow snapshot and audit event chain, and is reset when a failed step is retried. The adapter registry rejects a step when the selected provider does not declare all requested capabilities; the built-in Codex adapter is limited to workspace read/write. These are orchestration-level controls, not a claim that the provider sandbox grants or enforces operating-system permissions.
