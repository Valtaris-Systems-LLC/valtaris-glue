// src/orchestration/execution-context.ts
// Valtaris Glue — Execution Context
//
// Provides a unified context object passed into:
// - TaskRunner
// - WorkflowRunner
// - Connectors
//
// This keeps metadata consistent across the entire runtime.

export interface ExecutionContext {
  runId: string;
  workflowId: string;
  stepId: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export function createExecutionContext(
  workflowId: string,
  runId: string,
  stepId: string,
  payload: Record<string, unknown>
): ExecutionContext {
  return {
    runId,
    workflowId,
    stepId,
    payload,
    timestamp: new Date().toISOString(),
  };
}
