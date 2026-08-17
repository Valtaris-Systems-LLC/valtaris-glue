// src/orchestration/job-queue.ts
// Valtaris Glue — Job Queue
//
// Provides:
// - FIFO job queue
// - priority queue support
// - draining
// - pausing/resuming
//
// This is the foundation for workflow-level job orchestration.

export interface Job {
  id: string;
  priority: number;
  run: () => Promise<void>;
}

export class JobQueue {
  private queue: Job[] = [];
  private paused = false;

  enqueue(job: Job) {
    this.queue.push(job);
    this.sortByPriority();
  }

  private sortByPriority() {
    this.queue.sort((a, b) => b.priority - a.priority);
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.drain();
  }

  async drain() {
    if (this.paused) return;

    while (this.queue.length > 0 && !this.paused) {
      const job = this.queue.shift();
      if (!job) continue;

      try {
        await job.run();
      } catch (err) {
        console.error(`job-queue.error: job '${job.id}' failed`, err);
      }
    }
  }

  getStatus() {
    return {
      queued: this.queue.length,
      paused: this.paused,
    };
  }
}
