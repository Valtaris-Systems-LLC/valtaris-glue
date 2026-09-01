// src/orchestration/state-events.ts
// Valtaris Glue — Workflow State Events
//
// Emits lifecycle events when workflow state changes:
// - running
// - waiting
// - failed
// - completed
// - cancelled
//
// This integrates the state machine with the event emitter.

import { EventEmitter } from "./event-emitter";
import { WorkflowState } from "./state-machine";

export class StateEvents {
  constructor(private events: EventEmitter) {}

  emitState(runId: string, state: WorkflowState) {
    switch (state) {
      case "running":
        this.events.emit("workflow.running", { runId });
        break;

      case "waiting":
        this.events.emit("workflow.waiting", { runId });
        break;

      case "failed":
        this.events.emit("workflow.failed", { runId });
        break;

      case "completed":
        this.events.emit("workflow.completed", { runId });
        break;

      case "cancelled":
        this.events.emit("workflow.cancelled", { runId });
        break;

      default:
        // idle state doesn't emit anything
        break;
    }
  }
}
