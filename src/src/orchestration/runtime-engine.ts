// src/orchestration/runtime-engine.ts
// Valtaris Glue — Runtime Engine
//
// Coordinates:
// - TaskRunner
// - ConnectorRegistry
// - WorkflowRunner
//
// This is the glue between orchestration and execution.

import { TaskRunner } from "./task-runner";
import { ConnectorRegistry } from "./connector-registry";
import { WorkflowRunner } from "./workflow-runner";
import { loadWorkflowDefinition } from "./workflow-definition";

export class RuntimeEngine {
  private registry = new ConnectorRegistry();
  private taskRunner = new TaskRunner({});

  registerConnector(stepId: string, fn: any) {
    this.registry.registerConnector(stepId, fn);
    this.taskRunner = new TaskRunner(this.registry["connectors"]);
  }

  loadWorkflow(id: string, rawDefinition: unknown) {
    return loadWorkflowDefinition(id, rawDefinition);
  }

  createRunner(definition: any) {
    return new WorkflowRunner(definition);
  }

  async runWorkflow(
    workflowId: string,
    rawDefinition: unknown,
    initialPayload: Record<string, unknown>
  ) {
    const def = this.loadWorkflow(workflowId, rawDefinition);
    const runner = this.createRunner(def);

    const runId = crypto.randomUUID();
    return runner.start(runId, initialPayload);
  }
}
