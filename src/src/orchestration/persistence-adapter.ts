// src/orchestration/persistence-adapter.ts
// Valtaris Glue — Persistence Adapter
//
// Defines the interface for persistence backends:
// - in-memory
// - Supabase
// - Redis
// - filesystem
//
// WorkflowRunner + StateController will depend on this.

export interface PersistenceAdapter {
  saveWorkflowRun(
    runId: string,
    workflowId: string,
    data: Record<string, unknown>
  ): Promise<void>;

  loadWorkflowRun(
    runId: string
  ): Promise<Record<string, unknown> | null>;

  saveStepOutput(
    runId: string,
    stepId: string,
    output: Record<string, unknown>
  ): Promise<void>;

  loadStepOutput(
    runId: string,
    stepId: string
  ): Promise<Record<string, unknown> | null>;

  listSteps(runId: string): Promise<string[]>;

  saveState(
    runId: string,
    state: string
  ): Promise<void>;

  loadState(runId: string): Promise<string | null>;
}
