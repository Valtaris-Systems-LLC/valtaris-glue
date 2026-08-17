// src/orchestration/parallel-executor.ts
// Valtaris Glue — Parallel Executor
//
// Provides:
// - parallel step execution
// - fan-out / fan-in patterns
// - aggregation of parallel results
// - error isolation per branch
//
// This is the foundation for multi-branch workflows.

export interface ParallelTask {
  id: string;
  run: () => Promise<Record<string, unknown>>;
}

export interface ParallelResult {
  id: string;
  success: boolean;
  output?: Record<string, unknown>;
  error?: unknown;
}

export class ParallelExecutor {
  async execute(tasks: ParallelTask[]): Promise<ParallelResult[]> {
    const executions = tasks.map(async (task) => {
      try {
        const output = await task.run();
        return {
          id: task.id,
          success: true,
          output,
        } as ParallelResult;
      } catch (err) {
        return {
          id: task.id,
          success: false,
          error: err,
        } as ParallelResult;
      }
    });

    return await Promise.all(executions);
  }

  async fanIn(results: ParallelResult[]): Promise<Record<string, unknown>> {
    const aggregated: Record<string, unknown> = {};

    for (const result of results) {
      aggregated[result.id] = result.success
        ? result.output
        : { error: result.error };
    }

    return aggregated;
  }
}
