// src/orchestration/persistence-binding.ts
// Valtaris Glue — Persistence Binding Layer
//
// Connects the PersistenceManager to the RuntimeEngine + WorkflowRunner.
// Ensures all workflow operations automatically persist state, steps, and snapshots.

import { PersistenceManager } from "./persistence-manager";
import { WorkflowRunner } from "./workflow-runner";

export class PersistenceBinding {
  constructor(private manager: PersistenceManager) {}

  bind(runner: WorkflowRunner, workflowId: string) {
    const emitter = (runner as any).events;

    // Workflow started → persist initial run
    emitter.on("workflow.started", async ({ runId, payload }) => {
      await this.manager.saveRun(runId, workflowId, {
        startedAt: new Date().toISOString(),
        initialPayload: payload,
      });

      await this.manager.saveState(runId, "running");
      this.manager.saveSnapshot(runId, workflowId, "running", payload);
    });

    // Step completed → persist output
    emitter.on("job.completed", async ({ runId, stepId, output }) => {
      await this.manager.saveStep(runId, stepId, output);
      this.manager.saveSnapshot(runId, workflowId, "running", output);
    });

    // Workflow completed → persist final state
    emitter.on("workflow.completed", async ({ runId }) => {
      await this.manager.saveState(runId, "completed");
      this.manager.saveSnapshot(runId, workflowId, "completed", {});
    });

    // Workflow failed → persist failure state
    emitter.on("workflow.failed", async ({ runId, reason }) => {
      await this.manager.saveState(runId, "failed");
      this.manager.saveSnapshot(runId, workflowId, "failed", { reason });
    });

    // Workflow cancelled → persist cancellation state
    emitter.on("workflow.cancelled", async ({ runId }) => {
      await this.manager.saveState(runId, "cancelled");
      this.manager.saveSnapshot(runId, workflowId, "cancelled", {});
    });
  }
}
