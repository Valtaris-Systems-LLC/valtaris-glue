// src/orchestration/persistence-manager.ts
// Valtaris Glue — Persistence Manager
//
// High-level persistence orchestrator that combines:
// - PersistenceAdapter (backend)
// - SnapshotStore (resumability)
// - StateStore (in-memory state)
//
// Provides unified persistence operations for WorkflowRunner.

import { PersistenceAdapter } from "./persistence-adapter";
import { SnapshotStore } from "./persistence-snapshot";
import { StateStore } from "./state-store";

export class PersistenceManager {
  constructor(
    private adapter: PersistenceAdapter,
    private snapshots: SnapshotStore,
    private stateStore: StateStore
  ) {}

  async saveRun(
    runId: string,
    workflowId: string,
    data: Record<string, unknown>
  ) {
    await this.adapter.saveWorkflowRun(runId, workflowId, data);
  }

  async loadRun(runId: string) {
    return await this.adapter.loadWorkflowRun(runId);
  }

  async saveStep(runId: string, stepId: string, output: Record<string, unknown>) {
    await this.adapter.saveStepOutput(runId, stepId, output);
  }

  async loadStep(runId: string, stepId: string) {
    return await this.adapter.loadStepOutput(runId, stepId);
  }

  async listSteps(runId: string) {
    return await this.adapter.listSteps(runId);
  }

  async saveState(runId: string, state: string) {
    await this.adapter.saveState(runId, state);
    this.stateStore.setState(runId, state);
  }

  async loadState(runId: string) {
    return await this.adapter.loadState(runId);
  }

  saveSnapshot(
    runId: string,
    workflowId: string,
    state: string,
    payload: Record<string, unknown>
  ) {
    this.snapshots.saveSnapshot(runId, workflowId, state, payload);
  }

  loadSnapshot(runId: string) {
    return this.snapshots.loadSnapshot(runId);
  }

  listSnapshots(runId: string) {
    return this.snapshots.listSnapshots(runId);
  }

  deleteSnapshot(runId: string) {
    this.snapshots.deleteSnapshot(runId);
  }
}
