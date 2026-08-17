// src/orchestration/state-store.ts
// Valtaris Glue — Workflow State Store
//
// Stores workflow state machine values:
// - current state
// - step history
// - timestamps
// - failure reasons
//
// This is the persistent memory for the state machine.

import { WorkflowState } from "./state-machine";

export interface WorkflowStateRecord {
  runId: string;
  workflowId: string;
  state: WorkflowState;
  steps: Record<
    string,
    {
      timestamp: string;
      payload: Record<string, unknown>;
    }
  >;
  failureReason?: string;
}

export class StateStore {
  private store: Record<string, WorkflowStateRecord> = {};

  init(runId: string, workflowId: string) {
    this.store[runId] = {
      runId,
      workflowId,
      state: "idle",
      steps: {},
    };
  }

  get(runId: string): WorkflowStateRecord | null {
    return this.store[runId] ?? null;
  }

  setState(runId: string, state: WorkflowState) {
    const record = this.get(runId);
    if (!record) return;
    record.state = state;
  }

  addStep(
    runId: string,
    stepId: string,
    payload: Record<string, unknown>
  ) {
    const record = this.get(runId);
    if (!record) return;

    record.steps[stepId] = {
      timestamp: new Date().toISOString(),
      payload,
    };
  }

  setFailure(runId: string, reason: string) {
    const record = this.get(runId);
    if (!record) return;
    record.failureReason = reason;
  }
}
