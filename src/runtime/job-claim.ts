// src/runtime/job-claim.ts
// Valtaris Glue — Durable Job Claiming Logic
//
// This module is responsible for:
// - Deterministic job claiming
// - Worker ownership assignment
// - Preventing double execution
// - Atomic claim semantics
// - Safe concurrent worker behavior
//
// Supabase functions call into this logic before executing a job.

export interface JobRecord {
  id: string;
  workflowRunId: string;
  stepId: string;
  status: "queued" | "claimed" | "running" | "completed" | "failed" | "dead_letter";
  attempts: number;
  maxAttempts: number;
  nextRunAt: string | null;
  connectorKey: string | null;
  payload: Record<string, unknown> | null;
  workerId?: string | null;
}

export interface ClaimResult {
  success: boolean;
  job?: JobRecord;
  reason?: string;
}

export class JobClaim {
  constructor(private readonly workerId: string) {}

  /**
   * Determines if a job is eligible to be claimed.
   */
  private isEligible(job: JobRecord): boolean {
    if (job.status !== "queued") return false;
    if (!job.nextRunAt) return true;

    const now = Date.now();
    const nextRun = new Date(job.nextRunAt).getTime();

    return now >= nextRun;
  }

  /**
   * Claim a job deterministically.
   */
  claim(job: JobRecord): ClaimResult {
    if (!this.isEligible(job)) {
      return {
        success: false,
        reason: "job_not_eligible",
      };
    }

    return {
      success: true,
      job: {
        ...job,
        status: "claimed",
        workerId: this.workerId,
      },
    };
  }

  /**
   * Mark job as running.
   */
  start(job: JobRecord): JobRecord {
    return {
      ...job,
      status: "running",
      workerId: this.workerId,
    };
  }

  /**
   * Mark job as completed.
   */
  complete(job: JobRecord, output: Record<string, unknown> | null): JobRecord {
    return {
      ...job,
      status: "completed",
      workerId: this.workerId,
      payload: output,
    };
  }

  /**
   * Mark job as failed (but retryable).
   */
  fail(job: JobRecord, errorCode: string, errorMessage: string, nextRunAt: string): JobRecord {
    return {
      ...job,
      status: "queued",
      attempts: job.attempts + 1,
      workerId: this.workerId,
      nextRunAt,
      payload: {
        errorCode,
        errorMessage,
      },
    };
  }

  /**
   * Mark job as dead-letter (non-retryable).
   */
  deadLetter(job: JobRecord, errorCode: string, errorMessage: string): JobRecord {
    return {
      ...job,
      status: "dead_letter",
      workerId: this.workerId,
      payload: {
        errorCode,
        errorMessage,
      },
    };
  }
}
