// src/orchestration/workflow-definition.ts
// Valtaris Glue — Workflow Definition Loader
//
// Provides:
// - WorkflowDefinition type
// - loadWorkflowDefinition(id)
// - validates structure
// - ensures steps exist and are well-formed

export interface WorkflowStep {
  type: "task" | "branch" | "end";
  next?: string;
  branches?: Record<string, string>;
}

export interface WorkflowDefinition {
  id: string;
  steps: Record<string, WorkflowStep>;
}

export function loadWorkflowDefinition(
  id: string,
  raw: unknown
): WorkflowDefinition {
  if (!raw || typeof raw !== "object") {
    throw new Error(`workflow.definition.invalid: '${id}' is not an object`);
  }

  const def = raw as WorkflowDefinition;

  if (!def.id || typeof def.id !== "string") {
    throw new Error(`workflow.definition.invalid: missing 'id'`);
  }

  if (!def.steps || typeof def.steps !== "object") {
    throw new Error(`workflow.definition.invalid: missing 'steps'`);
  }

  for (const [stepId, step] of Object.entries(def.steps)) {
    if (!step.type) {
      throw new Error(
        `workflow.definition.invalid: step '${stepId}' missing 'type'`
      );
    }

    if (step.type === "task" && !step.next) {
      throw new Error(
        `workflow.definition.invalid: task step '${stepId}' missing 'next'`
      );
    }

    if (step.type === "branch" && !step.branches) {
      throw new Error(
        `workflow.definition.invalid: branch step '${stepId}' missing 'branches'`
      );
    }
  }

  return def;
}
