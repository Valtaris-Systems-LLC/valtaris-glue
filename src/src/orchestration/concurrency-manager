// src/orchestration/concurrency-manager.ts
// Valtaris Glue — Concurrency Manager
//
// Provides:
// - parallel step execution
// - concurrency limits
// - job queueing
// - cooperative multitasking
//
// This is the foundation for parallel workflow execution.

export interface ConcurrencyConfig {
  maxParallel: number; // maximum number of concurrent jobs
}

export class ConcurrencyManager {
  private queue: Array<() => Promise<void>> = [];
  private running = 0;
  private maxParallel: number;

  constructor(config: ConcurrencyConfig) {
    this.maxParallel = config.maxParallel;
  }

  async enqueue(job: () => Promise<void>) {
    this.queue.push(job);
    this.processQueue();
  }

  private async processQueue() {
    if (this.running >= this.maxParallel) return;
    const next = this.queue.shift();
    if (!next) return;

    this.running++;

    try {
      await next();
    } finally {
      this.running--;
      this.processQueue();
    }
  }

  getStatus() {
    return {
      running: this.running,
      queued: this.queue.length,
      maxParallel: this.maxParallel,
    };
  }
}
