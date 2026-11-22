# AIPowers Architecture — Initial Direction

AIPowers is designed as a modular AI-agent ecosystem. The initial repository intentionally starts with a small, independently implemented foundation rather than importing an existing codebase.

## Planned modules

- **Core Runtime:** agent lifecycle, configuration, execution context, cancellation.
- **Capability Registry:** typed tools, skills, permissions, versioning, discovery.
- **Orchestrator:** sequential and parallel workflows, retries, state transitions.
- **Memory & Context:** scoped memory, retrieval interfaces, user-visible controls.
- **Evaluation & Safety:** deterministic tests, model evaluations, permission gates, audit events.
- **Adapters:** model-provider and developer-environment integrations behind stable interfaces.

## Design constraints

1. No hidden tool execution: capabilities declare inputs, outputs, and permissions.
2. Human approval for consequential external actions.
3. Provider-neutral interfaces; provider-specific behavior stays in adapters.
4. Reproducible tests and explicit runtime requirements.
5. Modules ship only when implemented and verified; roadmap items are not advertised as existing features.

## First milestone

Establish package conventions, CLI entry point, automated tests, contribution workflow, and a documented module boundary before implementing the runtime.
