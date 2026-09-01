// src/orchestration/state-controller.ts
// Valtaris Glue — State Controller
//
// Bridges the StateMachine and StateStore:
// - applies transitions
// - records state changes
// - logs failures
// - ensures workflow lifecycle consistency

import { StateMachine, WorkflowState } from "./state-machine";
import { StateStore } from "./state-store";

export class StateController {
  private machines: Record<string, StateMachine> = {};

  constructor(private store: StateStore) {}

  init(runId: string, workflowId: string) {
    this.store.init(runId, workflowId);
    this.machines[runId] = new StateMachine();
  }

  getState(runId: string): WorkflowState {
    const machine = this.machines[runId];
    if (!machine) throw new Error(`state-controller.missing: '${runId}'`);
    return machine.getState();
  }

  transition(runId: string, to: WorkflowState) {
    const machine = this.machines[runId];
    if (!machine) {
      throw new Error(`state-controller.missing_machine: '${runId}'`);
    }

    machine.transition(to);
    this.store.setState(runId, to);
  }

  recordStep(
    runId: string,
    stepId: string,
    payload: Record<string, unknown>
  ) {
    this.store.addStep(runId, stepId, payload);
  }

  fail(runId: string, reason: string) {
    this.transition(runId, "failed");
    this.store.setFailure(runId, reason);
  }

  complete(runId: string) {
    this.transition(runId, "completed");
  }

  cancel(runId: string) {
    this.transition(runId, "cancelled");
  }
}
