// src/orchestration/state-integrator.ts
// Valtaris Glue — State Integrator
//
// Integrates:
// - StateController
// - StateEvents
// - WorkflowRunner
//
// Ensures workflow lifecycle transitions emit events and update state.

import { StateController } from "./state-controller";
import { StateEvents } from "./state-events";
import { EventEmitter } from "./event-emitter";
import { WorkflowRunner } from "./workflow-runner";

export class StateIntegrator {
  constructor(
    private controller: StateController,
    private events: StateEvents
  ) {}

  attachToRunner(runner: WorkflowRunner, workflowId: string) {
    const emitter = (runner as any).events as EventEmitter;

    emitter.on("workflow.started", ({ runId }) => {
      this.controller.init(runId, workflowId);
      this.controller.transition(runId, "running");
      this.events.emitState(runId, "running");
    });

    emitter.on("job.completed", ({ runId, stepId, output }) => {
      this.controller.recordStep(runId, stepId, output);
    });

    emitter.on("workflow.completed", ({ runId }) => {
      this.controller.complete(runId);
      this.events.emitState(runId, "completed");
    });

    emitter.on("workflow.failed", ({ runId, reason }) => {
      this.controller.fail(runId, reason);
      this.events.emitState(runId, "failed");
    });

    emitter.on("workflow.cancelled", ({ runId }) => {
      this.controller.cancel(runId);
      this.events.emitState(runId, "cancelled");
    });
  }
}
