// src/orchestration/persistence-memory.ts
// Valtaris Glue — In-Memory Persistence Adapter
//
// Implements PersistenceAdapter using simple JS objects.
// This is the default fallback backend for local development.

import { PersistenceAdapter } from "./persistence-adapter";

export class MemoryPersistence implements PersistenceAdapter {
  private workflowRuns: Record<string, Record<string, unknown>> = {};
  private stepOutputs: Record<string, Record<string, Record<string, unknown>>> =
    {};
  private states: Record<string, string> = {};

  async saveWorkflowRun(
    runId: string,
    workflowId: string,
    data: Record<string, unknown>
  ): Promise<void> {
    this.workflowRuns[runId] = {
      workflowId,
      ...data,
    };
  }

  async loadWorkflowRun(
    runId: string
  ): Promise<Record<string, unknown> | null> {
    return this.workflowRuns[runId] ?? null;
  }

  async saveStepOutput(
    runId: string,
    stepId: string,
    output: Record<string, unknown>
  ): Promise<void> {
    if (!this.stepOutputs[runId]) {
      this.stepOutputs[runId] = {};
    }
    this.stepOutputs[runId][stepId] = output;
  }

  async loadStepOutput(
    runId: string,
    stepId: string
  ): Promise<Record<string, unknown> | null> {
    return this.stepOutputs[runId]?.[stepId] ?? null;
  }

  async listSteps(runId: string): Promise<string[]> {
    return Object.keys(this.stepOutputs[runId] ?? {});
  }

  async saveState(runId: string, state: string): Promise<void> {
    this.states[runId] = state;
  }

  async loadState(runId: string): Promise<string | null> {
    return this.states[runId] ?? null;
  }
}
