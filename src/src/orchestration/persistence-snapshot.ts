// src/orchestration/persistence-snapshot.ts
// Valtaris Glue — Workflow Snapshot Manager
//
// Provides snapshot storage for resumability:
// - saveSnapshot()
// - loadSnapshot()
// - deleteSnapshot()
// - listSnapshots()
//
// Snapshots allow workflows to resume after crashes or restarts.

export interface WorkflowSnapshot {
  runId: string;
  workflowId: string;
  state: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export class SnapshotStore {
  private snapshots: Record<string, WorkflowSnapshot[]> = {};

  saveSnapshot(
    runId: string,
    workflowId: string,
    state: string,
    payload: Record<string, unknown>
  ) {
    const snapshot: WorkflowSnapshot = {
      runId,
      workflowId,
      state,
      timestamp: new Date().toISOString(),
      payload,
    };

    if (!this.snapshots[runId]) {
      this.snapshots[runId] = [];
    }

    this.snapshots[runId].push(snapshot);
  }

  loadSnapshot(runId: string): WorkflowSnapshot | null {
    const list = this.snapshots[runId];
    if (!list || list.length === 0) return null;
    return list[list.length - 1]; // latest snapshot
  }

  listSnapshots(runId: string): WorkflowSnapshot[] {
    return this.snapshots[runId] ?? [];
  }

  deleteSnapshot(runId: string) {
    delete this.snapshots[runId];
  }
}
