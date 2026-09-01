// src/runtime/event-emitter.ts
// Valtaris Glue — Unified Event Emitter
//
// This module is responsible for:
// - Emitting workflow lifecycle events
// - Emitting job-level events
// - Emitting connector events
// - Emitting scheduler events
// - Normalizing event payloads
//
// Supabase functions persist these events into workflow_events.

export type EventKind =
  | "workflow_started"
  | "workflow_completed"
  | "workflow_failed"
  | "workflow_replay_started"
  | "workflow_replay_completed"
  | "workflow_rollback_started"
  | "workflow_rollback_completed"
  | "job_queued"
  | "job_claimed"
  | "job_started"
  | "job_completed"
  | "job_failed"
  | "connector_tick"
  | "scheduler_triggered";

export interface EventContext {
  workflowRunId: string;
  workflowJobId?: string | null;
  stepId?: string | null;
  kind: EventKind;
  payload?: Record<string, unknown> | null;
}

export interface EventRecord {
  id: string;
  workflowRunId: string;
  workflowJobId: string | null;
  stepId: string | null;
  kind: EventKind;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export class EventEmitter {
  /**
   * Create an event record object.
   * (Supabase functions persist it.)
   */
  emit(ctx: EventContext): EventRecord {
    return {
      id: crypto.randomUUID(),
      workflowRunId: ctx.workflowRunId,
      workflowJobId: ctx.workflowJobId ?? null,
      stepId: ctx.stepId ?? null,
      kind: ctx.kind,
      payload: ctx.payload ?? null,
      createdAt: new Date().toISOString(),
    };
  }

  //
  // Convenience helpers for common event types
  //

  workflowStarted(runId: string, definitionId: string) {
    return this.emit({
      workflowRunId: runId,
      kind: "workflow_started",
      payload: { definitionId },
    });
  }

  workflowCompleted(runId: string) {
    return this.emit({
      workflowRunId: runId,
      kind: "workflow_completed",
    });
  }

  workflowFailed(runId: string, reason: string) {
    return this.emit({
      workflowRunId: runId,
      kind: "workflow_failed",
      payload: { reason },
    });
  }

  jobQueued(runId: string, jobId: string, stepId: string) {
    return this.emit({
      workflowRunId: runId,
      workflowJobId: jobId,
      stepId,
      kind: "job_queued",
    });
  }

  jobClaimed(runId: string, jobId: string, stepId: string, workerId: string) {
    return this.emit({
      workflowRunId: runId,
      workflowJobId: jobId,
      stepId,
      kind: "job_claimed",
      payload: { workerId },
    });
  }

  jobStarted(runId: string, jobId: string, stepId: string) {
    return this.emit({
      workflowRunId: runId,
      workflowJobId: jobId,
      stepId,
      kind: "job_started",
    });
  }

  jobCompleted(runId: string, jobId: string, stepId: string, output: Record<string, unknown>) {
    return this.emit({
      workflowRunId: runId,
      workflowJobId: jobId,
      stepId,
      kind: "job_completed",
      payload: { output },
    });
  }

  jobFailed(runId: string, jobId: string, stepId: string, errorCode: string, errorMessage: string) {
    return this.emit({
      workflowRunId: runId,
      workflowJobId: jobId,
      stepId,
      kind: "job_failed",
      payload: { errorCode, errorMessage },
    });
  }

  connectorTick(runId: string | null, scheduleId: string, connectorKey: string, payload: Record<string, unknown>) {
    return this.emit({
      workflowRunId: runId ?? "connector_tick",
      kind: "connector_tick",
      payload: { scheduleId, connectorKey, payload },
    });
  }

  schedulerTriggered(runId: string, scheduleId: string) {
    return this.emit({
      workflowRunId: runId,
      kind: "scheduler_triggered",
      payload: { scheduleId },
    });
  }
}
