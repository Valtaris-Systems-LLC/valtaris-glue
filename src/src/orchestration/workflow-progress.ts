// src/orchestration/workflow-progress.ts
// Valtaris Glue — Workflow Progress Tracker
//
// Tracks workflow execution state:
// - step outputs
// - merged payloads
// - progress snapshots
// - used by workflow-runner

export class WorkflowProgress {
  private store: Record<
    string,
    {
      steps: Record<string, Record<string, unknown>>;
      final?: Record<string, unknown>;
    }
  > = {};

  start(runId: string) {
    if (!this.store[runId]) {
      this.store[runId] = { steps: {} };
    }
  }

  update(runId: string, stepId: string, payload: Record<string, unknown>) {
    if (!this.store[runId]) {
      this.start(runId);
    }
    this.store[runId].steps[stepId] = payload;
  }

  complete(runId: string, finalPayload: Record<string, unknown>) {
    if (!this.store[runId]) {
      this.start(runId);
    }
    this.store[runId].final = finalPayload;
  }

  snapshot(runId: string) {
    return this.store[runId] ?? null;
  }
}
