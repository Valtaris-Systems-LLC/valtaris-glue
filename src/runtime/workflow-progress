// src/runtime/workflow-progress.ts
// Valtaris Glue — Workflow Progress Engine
//
// This module is responsible for:
// - Determining the next step after a job completes
// - Handling branching logic
// - Handling approval gates
// - Detecting workflow completion
// - Producing a unified progression contract for the worker
//
// The worker calls this after executing a connector.

import { WorkflowEngine, WorkflowDefinition, WorkflowStep } from "./workflow-engine";

export interface ProgressContext {
  workflowRunId: string;
  currentStepId: string;
  output: Record<string, unknown>;
}

export interface ProgressResult {
  workflowRunId: string;
  currentStepId: string;
  nextStepId: string | null;
  isComplete: boolean;
  reason: string;
}

export class WorkflowProgress {
  private engine: WorkflowEngine;

  constructor(definition: WorkflowDefinition) {
    this.engine = new WorkflowEngine(definition);
  }

  /**
   * Determine the next step after a job completes.
   */
  advance(ctx: ProgressContext): ProgressResult {
    const { workflowRunId, currentStepId, output } = ctx;

    const nextStep = this.engine.getNextStep(currentStepId, output);

    if (!nextStep) {
      return {
        workflowRunId,
        currentStepId,
        nextStepId: null,
        isComplete: true,
        reason: "workflow_complete",
      };
    }

    return {
      workflowRunId,
      currentStepId,
      nextStepId: nextStep.id,
      isComplete: false,
      reason: "next_step_ready",
    };
  }

  /**
   * Convenience helper for determining next step directly.
   */
  getNextStep(currentStepId: string, output: Record<string, unknown>): WorkflowStep | null {
    return this.engine.getNextStep(currentStepId, output);
  }

  /**
   * Determine if workflow is complete.
   */
  isComplete(nextStep: WorkflowStep | null): boolean {
    return this.engine.isWorkflowComplete(nextStep);
  }
}
