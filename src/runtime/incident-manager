// src/runtime/incident-manager.ts
// Valtaris Glue — Incident Manager
//
// This module is responsible for:
// - Creating workflow incidents
// - Classifying severity
// - Tracking lineage (workflow, job, step)
// - Normalizing incident payloads
// - Providing a unified incident contract for the operator console

export type IncidentSeverity = "info" | "warning" | "error";

export interface IncidentContext {
  workflowRunId: string;
  workflowJobId?: string | null;
  stepId?: string | null;
  code: string;
  message: string;
  severity?: IncidentSeverity;
  metadata?: Record<string, unknown>;
}

export interface IncidentRecord {
  id: string;
  workflowRunId: string;
  workflowJobId: string | null;
  stepId: string | null;
  severity: IncidentSeverity;
  code: string;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export class IncidentManager {
  /**
   * Normalize severity based on error code.
   */
  private classifySeverity(code: string, provided?: IncidentSeverity): IncidentSeverity {
    if (provided) return provided;

    if (code.startsWith("workflow.") || code.startsWith("connector.")) {
      return "error";
    }

    if (code.startsWith("retry.") || code.startsWith("compensation.")) {
      return "warning";
    }

    return "info";
  }

  /**
   * Create an incident record object.
   * (Worker or Supabase function will persist it.)
   */
  createIncident(ctx: IncidentContext): IncidentRecord {
    const severity = this.classifySeverity(ctx.code, ctx.severity);

    return {
      id: crypto.randomUUID(),
      workflowRunId: ctx.workflowRunId,
      workflowJobId: ctx.workflowJobId ?? null,
      stepId: ctx.stepId ?? null,
      severity,
      code: ctx.code,
      message: ctx.message,
      metadata: ctx.metadata ?? null,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Convenience helpers for common incident types.
   */

  workflowError(runId: string, message: string, metadata?: Record<string, unknown>) {
    return this.createIncident({
      workflowRunId: runId,
      code: "workflow.error",
      message,
      severity: "error",
      metadata,
    });
  }

  jobFailure(runId: string, jobId: string, stepId: string, message: string, metadata?: Record<string, unknown>) {
    return this.createIncident({
      workflowRunId: runId,
      workflowJobId: jobId,
      stepId,
      code: "workflow.job.failed",
      message,
      severity: "error",
      metadata,
    });
  }

  retryScheduled(runId: string, jobId: string, stepId: string, attempts: number, nextRunAt: string) {
    return this.createIncident({
      workflowRunId: runId,
      workflowJobId: jobId,
      stepId,
      code: "retry.scheduled",
      message: `Retry scheduled (attempt ${attempts})`,
      severity: "warning",
      metadata: { attempts, nextRunAt },
    });
  }

  deadLetter(runId: string, jobId: string, stepId: string, message: string, metadata?: Record<string, unknown>) {
    return this.createIncident({
      workflowRunId: runId,
      workflowJobId: jobId,
      stepId,
      code: "workflow.job.dead_letter",
      message,
      severity: "error",
      metadata,
    });
  }
}
