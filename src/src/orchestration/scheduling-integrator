// src/orchestration/scheduling-integrator.ts
// Valtaris Glue — Scheduling Integrator
//
// Connects:
// - Scheduler
// - ConcurrencyManager
// - JobQueue
// - ParallelExecutor
// - WorkflowRunner
//
// This is the orchestration layer that binds all scheduling + concurrency
// components into the workflow runtime.

import { Scheduler, ScheduleConfig } from "./scheduler";
import { ConcurrencyManager } from "./concurrency-manager";
import { JobQueue, Job } from "./job-queue";
import { ParallelExecutor, ParallelTask } from "./parallel-executor";
import { WorkflowRunner } from "./workflow-runner";

export class SchedulingIntegrator {
  constructor(
    private scheduler: Scheduler,
    private concurrency: ConcurrencyManager,
    private queue: JobQueue,
    private parallel: ParallelExecutor
  ) {}

  attachToRunner(runner: WorkflowRunner, workflowId: string) {
    const emitter = (runner as any).events;

    // Schedule workflow start
    emitter.on("workflow.schedule", ({ runId, config }: { runId: string; config: ScheduleConfig }) => {
      this.scheduler.schedule(runId, config, () => {
        emitter.emit("workflow.start_scheduled", { runId });
      });
    });

    // Queue jobs
    emitter.on("job.enqueue", ({ runId, stepId, run }: { runId: string; stepId: string; run: () => Promise<void> }) => {
      const job: Job = {
        id: `${runId}:${stepId}`,
        priority: 1,
        run,
      };
      this.queue.enqueue(job);
    });

    // Parallel execution
    emitter.on("job.parallel", async ({ runId, tasks }: { runId: string; tasks: ParallelTask[] }) => {
      const results = await this.parallel.execute(tasks);
      const aggregated = await this.parallel.fanIn(results);

      emitter.emit("job.parallel.completed", {
        runId,
        results,
        aggregated,
      });
    });

    // Concurrency-managed execution
    emitter.on("job.concurrent", async ({ runId, stepId, run }: { runId: string; stepId: string; run: () => Promise<void> }) => {
      await this.concurrency.enqueue(run);
    });
  }
}
