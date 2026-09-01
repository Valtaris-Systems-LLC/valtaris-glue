// src/orchestration/state-machine.ts
// Valtaris Glue — Workflow State Machine
//
// Provides deterministic workflow state transitions:
// - idle → running
// - running → waiting
// - running → failed
// - running → completed
// - running → cancelled
// - waiting → running
//
// This is the backbone of workflow lifecycle control.

export type WorkflowState =
  | "idle"
  | "running"
  | "waiting"
  | "failed"
  | "completed"
  | "cancelled";

export interface StateTransition {
  from: WorkflowState;
  to: WorkflowState;
}

const VALID_TRANSITIONS: StateTransition[] = [
  { from: "idle", to: "running" },
  { from: "running", to: "waiting" },
  { from: "waiting", to: "running" },
  { from: "running", to: "failed" },
  { from: "running", to: "completed" },
  { from: "running", to: "cancelled" },
];

export class StateMachine {
  private state: WorkflowState = "idle";

  getState(): WorkflowState {
    return this.state;
  }

  canTransition(to: WorkflowState): boolean {
    return VALID_TRANSITIONS.some(
      (t) => t.from === this.state && t.to === to
    );
  }

  transition(to: WorkflowState) {
    if (!this.canTransition(to)) {
      throw new Error(
        `state-machine.invalid_transition: cannot transition from '${this.state}' to '${to}'`
      );
    }
    this.state = to;
  }
}
