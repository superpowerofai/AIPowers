# Execution Adapter Contract

AIPowers separates workflow orchestration from provider-specific execution. The registry currently ships with the Codex adapter; additional providers are supplied by a trusted host integration.

## Registering a provider

A provider is registered in-process:

```js
import { registerExecutionAdapter } from '../src/adapters/registry.js';

registerExecutionAdapter({
  id: 'my-provider',
  maxConcurrency: 2,
  async runStep(workflowId, stepId, options) {
    // Delegate to a provider-specific implementation.
    return runMyProviderStep(workflowId, stepId, options);
  }
});
```

The provider ID must be a lowercase slug. `maxConcurrency` is an integer from 1 to 32 and defaults to 1. Registration is explicit; AIPowers does not automatically import arbitrary project files or discover and execute untrusted adapter code.

## Workflow routing

A workflow step may include a provider assignment:

```js
const workflow = createWorkflow({
  task: 'Deliver a feature across multiple providers',
  steps: [
    { id: 'research', title: 'Research', provider: 'my-provider' },
    { id: 'implementation', title: 'Implement', provider: 'codex', dependsOn: ['research'] }
  ]
});
```

An unassigned step uses the provider passed to `runReadyWorkflowSteps()` or the CLI. Ready steps assigned to different providers can execute in the same batch. The orchestrator enforces each adapter's declared concurrency and stops scheduling new batches after a failure. Dependent steps remain blocked until their dependencies are explicitly reviewed and marked complete.

## Execution lifecycle

An adapter should:

1. Confirm the workflow is active and the step is pending and dependency-ready.
2. Call `beginWorkflowStepExecution()` before handing work to the provider.
3. Launch the provider, then immediately attach its child PID with `attachWorkflowExecutionProcess()` when the host exposes one.
4. Run it with an explicit working directory, bounded runtime, bounded output capture, and the narrowest available permissions.
5. Record success or failure with `recordWorkflowStepExecution()`, including an output digest and byte count.
6. Return the updated workflow, the resulting step, and the execution exit code.

The adapter must not mark work as human-reviewed. A successful provider exit records `executed`; a person must inspect the workspace and call `completeWorkflowStep()` before dependent steps can run.

If a process fails to launch, the adapter must persist a failed execution result rather than leave the step indefinitely marked running. If the host itself exits before recording a result, the step remains running. `workflow supervise <id>` marks an attempt failed only when its attached PID no longer appears alive and leaves live processes unchanged. Attempts without a PID require explicit operator confirmation through `workflow recover <id> --confirm-orphaned`.

## Result shape

`runStep(workflowId, stepId, options)` returns:

```js
{
  workflow, // persisted workflow after recording the attempt
  step,     // the updated step; status is executed or failed
  execution: {
    exitCode: 0,
    provider: 'my-provider'
  }
}
```

The orchestrator requires a persisted transition to `executed` and a zero exit code before it treats a batch as successful. A provider that merely returns a success-shaped object without persisting the step is rejected.

## Built-in provider status

- **Codex:** implemented with an ephemeral CLI session and `workspace-write` sandbox. Simulated process tests pass. Live authentication and native skill recognition are deliberately unverified.
- **Other providers:** the registry and orchestration contract support additional host-registered adapters, but no other provider is currently shipped or claimed as live-integrated.
