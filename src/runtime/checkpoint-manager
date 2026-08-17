// src/runtime/checkpoint-manager.ts
// Valtaris Glue — Durable Checkpoint Manager
//
// This module is responsible for:
// - Creating workflow checkpoints
// - Restoring checkpoints for replay
// - Providing rollback-safe state snapshots
// - Ensuring deterministic workflow recovery
//
// Supabase functions (worker, replay, rollback) call into this
// to persist and restore workflow state.

export interface CheckpointContext {
  workflowRunId: string;
  stepId: string;
  payload: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  status: "completed" | "failed";
}

export interface CheckpointRecord {
  id: string;
  workflowRunId: string;
  stepId: string;
  payload: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  status: "completed" | "failed";
  createdAt: string;
}

export class CheckpointManager {
  /**
   * Create a checkpoint record object.
   * (Supabase functions persist it.)
   */
  createCheckpoint(ctx: CheckpointContext): CheckpointRecord {
    return {
      id: crypto.randomUUID(),
      workflowRunId: ctx.workflowRunId,
      stepId: ctx.stepId,
      payload: ctx.payload ?? null,
      output: ctx.output ?? null,
      status: ctx.status,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Restore a checkpoint for replay.
   */
  restoreCheckpoint(records: CheckpointRecord[]): CheckpointRecord | null {
    if (!records || records.length === 0) return null;

    // Return the most recent checkpoint
    const sorted = [...records].sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return sorted[0];
  }

  /**
   * Determine if a workflow can be replayed from checkpoints.
   */
  canReplay(records: CheckpointRecord[]): boolean {
    return records.length > 0;
  }

  /**
   * Determine if rollback is possible.
   */
  canRollback(records: CheckpointRecord[]): boolean {
    return records.some((r) => r.status === "completed");
  }

  /**
   * Get all completed checkpoints.
   */
  getCompleted(records: CheckpointRecord[]): CheckpointRecord[] {
    return records.filter((r) => r.status === "completed");
  }

  /**
   * Get all failed checkpoints.
   */
  getFailed(records: CheckpointRecord[]): CheckpointRecord[] {
    return records.filter((r) => r.status === "failed");
  }
}
