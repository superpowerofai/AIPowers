# Changelog

## 0.1.0 — Initial public release

- Introduces the AIPowers Node.js CLI and six bundled development workflow skills.
- Adds deterministic skill matching, activation history, and portable agent-context preparation.
- Adds project-scoped memory with explicit retention, integrity auditing, credential-like content rejection, and cross-process write coordination.
- Exports AIPowers skill definitions into native Codex project skill files with ownership-safe reinstallation.
- Adds approval-gated workflows, dependency scheduling, provider-neutral execution adapters, bounded multi-provider orchestration, and execution recovery.
- Adds sensitive-step permission declarations, separate approval for consequential permissions, and adapter capability checks.
- Adds bounded verification profiles, hash-linked execution evidence, and a deterministic completion quality gate.
- Includes automated unit and CLI coverage.

### Known limitations

- Live Codex authentication, native skill recognition, and real provider execution are not claimed as verified in this release.
- Codex remains the only built-in execution provider.
- Human review is required to mark agent-executed steps complete.
- Permission declarations and approval gates are workflow controls; they do not grant or prove operating-system sandbox capabilities.
- Completion readiness is an evidence gate, not a guarantee of defect-free software.
