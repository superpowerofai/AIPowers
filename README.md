# AIPowers

**AIPowers = Original AI Agent Ecosystem.**

AIPowers is an independent project to build a modular ecosystem for creating, extending, orchestrating, evaluating, and operating AI agents.

## Project principles

- Original implementation and architecture.
- Modular components with clear interfaces.
- Developer-first tooling and transparent diagnostics.
- Security, evaluation, and human control built into the lifecycle.
- No dependency on another project's identity or source code.

## Current status

This is the initial foundation release (`0.1.0`). The CLI currently provides help, version, runtime diagnostics, and a platform roadmap. The broader agent runtime and ecosystem modules are planned, not yet implemented.

## Quick start

Requires Node.js 20 or newer.

```bash
npm install
npm test
node src/cli.js help
node src/cli.js doctor
```

For local CLI use:

```bash
npm link
aipowers
```

## Roadmap

1. Agent Runtime — lifecycle, configuration, execution boundaries.
2. Skills & Tools Registry — discoverable, versioned capabilities.
3. Workflow Orchestrator — compose agents and tools into reliable flows.
4. Memory & Context — scoped, inspectable context management.
5. Evaluation & Safety — tests, policy checks, observability.
6. Integrations — adapters for model providers and developer environments.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

MIT. See [LICENSE](LICENSE).

