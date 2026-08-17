// src/orchestration/step-executor.ts
// Valtaris Glue — Step Executor
//
// Executes a single workflow step using:
// - ExecutionContext
// - TaskRunner
// - ConnectorRegistry
//
// This isolates step execution logic from WorkflowRunner.

import { ExecutionContext, createExecutionContext } from "./execution-context";
import { TaskRunner } from "./task-runner";
import { ConnectorRegistry } from "./connector-registry";

export class StepExecutor {
  constructor(
    private registry: ConnectorRegistry,
    private taskRunner: TaskRunner
  ) {}

  async execute(
    workflowId: string,
    runId: string,
    stepId: string,
    payload: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const context: ExecutionContext = createExecutionContext(
      workflowId,
      runId,
      stepId,
      payload
    );

    const connector = this.registry.getConnector(stepId);

    if (!connector) {
      throw new Error(
        `step-executor.connector_missing: no connector registered for '${stepId}'`
      );
    }

    const output = await this.taskRunner.run({
      stepId,
      payload: context.payload,
    });

    if (!output.success) {
      throw new Error(
        `step-executor.error: step '${stepId}' failed — ${output.error}`
      );
    }

    return output.data;
  }
}
