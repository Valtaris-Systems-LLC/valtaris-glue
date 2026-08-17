// src/orchestration/job-claim.ts
// Valtaris Glue — Job Claiming System
//
// Provides:
// - claim(jobId) — assigns a worker to a job
// - release(jobId) — frees the job
// - isClaimed(jobId)
// - getWorker(jobId)
//
// This is used by workflow-runner to simulate worker assignment.
// Later, real workers (Supabase Functions, Edge Workers, etc.) plug in here.

export class JobClaim {
  private claims: Record<string, string> = {};

  claim(jobId: string): string {
    if (this.claims[jobId]) {
      return this.claims[jobId];
    }

    const workerId = crypto.randomUUID();
    this.claims[jobId] = workerId;
    return workerId;
  }

  release(jobId: string) {
    delete this.claims[jobId];
  }

  isClaimed(jobId: string): boolean {
    return jobId in this.claims;
  }

  getWorker(jobId: string): string | null {
    return this.claims[jobId] ?? null;
  }
}
