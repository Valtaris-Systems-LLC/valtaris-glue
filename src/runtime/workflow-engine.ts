// src/runtime/workflow-engine.ts
// Valtaris Glue — Core Workflow Engine
//
// This module is responsible for:
// - DAG traversal
// - Step progression
// - Parallel branch execution
// - Approval gates
// - Compensation routing
// - Workflow completion logic
//
// The worker calls into this engine to determine what happens next.

export interface WorkflowStep {
  id: string;
  name: string;
  connectorKey: string;
  type?: "task" | "approval" | "branch";
  next?: string | null;
  branches?: Array<{ id: string; condition: string }>;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  version: number;
  steps: WorkflowStep[];
}

export interface WorkflowRunState {
  workflowRunId: string;
  currentStepId: string | null;
  status: "pending" | "running" | "completed" | "failed";
}

export interface StepResult {
  success: boolean;
  output?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

export class WorkflowEngine {
  constructor(private definition: WorkflowDefinition) {}

  getFirstStep(): WorkflowStep {
    return this.definition.steps[0];
  }

  getStep(stepId: string): WorkflowStep | null {
    return this.definition.steps.find((s) => s.id === stepId) ?? null;
  }

  /**
   * Determine the next step after a successful execution.
   */
  getNextStep(currentStepId: string, output: Record<string, unknown>): WorkflowStep | null {
    const step = this.getStep(currentStepId);
    if (!step) return null;

    // Approval gate
    if (step.type === "approval") {
      const approved = output?.approved === true;
      if (!approved) return null;
      return this.getStep(step.next ?? "");
    }

    // Branching logic
    if (step.type === "branch" && step.branches) {
      for (const branch of step.branches) {
        const conditionValue = output?.[branch.condition];
        if (conditionValue === true) {
          return this.getStep(branch.id);
        }
      }
      return null;
    }

    // Standard next step
    if (step.next) {
      return this.getStep(step.next);
    }

    return null;
  }

  /**
   * Determine if the workflow is complete.
   */
  isWorkflowComplete(nextStep: WorkflowStep | null): boolean {
    return nextStep === null;
  }

  /**
   * Determine if the workflow should fail.
   */
  shouldFail(result: StepResult): boolean {
    return !result.success;
  }
}
