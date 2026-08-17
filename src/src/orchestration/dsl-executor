// src/orchestration/dsl-executor.ts
// Valtaris Glue — DSL Executor
//
// Executes compiled workflows by:
// - mapping compiled steps → WorkflowRunner jobs
// - injecting payloads
// - respecting dependencies
// - emitting execution events
//
// This is the bridge between the DSL compiler and the runtime engine.

import { CompiledWorkflow, CompiledStep } from "./dsl-compiler";
import { WorkflowRunner } from "./workflow-runner";

export class DSLExecutor {
  constructor(private runner: WorkflowRunner) {}

  async execute(workflow: CompiledWorkflow, initialPayload: Record<string, unknown> = {}) {
    const emitter = (this.runner as any).events;

    emitter.emit("workflow.dsl.start", {
      workflowId: workflow.id,
      payload: initialPayload,
    });

    for (const step of workflow.steps) {
      await this.executeStep(step, initialPayload);
    }

    emitter.emit("workflow.dsl.completed", {
      workflowId: workflow.id,
    });
  }

  private async executeStep(step: CompiledStep, payload: Record<string, unknown>) {
    const emitter = (this.runner as any).events;

    emitter.emit("workflow.dsl.step.start", {
      stepId: step.id,
      type: step.type,
      dependsOn: step.dependsOn,
    });

    if (step.type === "task") {
      await this.runner.runJob(step.run!, {
        ...payload,
        ...(step.payload ?? {}),
      });
    }

    emitter.emit("workflow.dsl.step.completed", {
      stepId: step.id,
    });
  }
}
