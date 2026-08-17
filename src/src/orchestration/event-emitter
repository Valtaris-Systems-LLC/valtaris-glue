// src/orchestration/event-emitter.ts
// Valtaris Glue — Event Emitter
//
// Provides:
// - workflowStarted()
// - workflowCompleted()
// - jobQueued()
// - jobClaimed()
// - jobStarted()
// - jobCompleted()
// - generic event dispatching

export class EventEmitter {
  private listeners: Record<string, Array<(data: any) => void>> = {};

  on(event: string, handler: (data: any) => void) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(handler);
  }

  emit(event: string, data: any) {
    const handlers = this.listeners[event];
    if (!handlers) return;
    for (const handler of handlers) {
      handler(data);
    }
  }

  workflowStarted(runId: string, workflowId: string) {
    this.emit("workflow.started", { runId, workflowId });
  }

  workflowCompleted(runId: string) {
    this.emit("workflow.completed", { runId });
  }

  jobQueued(runId: string, jobId: string, stepId: string) {
    this.emit("job.queued", { runId, jobId, stepId });
  }

  jobClaimed(runId: string, jobId: string, stepId: string, workerId: string) {
    this.emit("job.claimed", { runId, jobId, stepId, workerId });
  }

  jobStarted(runId: string, jobId: string, stepId: string) {
    this.emit("job.started", { runId, jobId, stepId });
  }

  jobCompleted(
    runId: string,
    jobId: string,
    stepId: string,
    output: Record<string, unknown>
  ) {
    this.emit("job.completed", { runId, jobId, stepId, output });
  }
}
