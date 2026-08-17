// src/orchestration/task-runner.ts
// Valtaris Glue — Task Runner
//
// Executes individual workflow tasks:
// - loads connector
// - runs connector logic
// - wraps output
// - handles errors
// - integrates with safeTry()

import { safeTry } from "../runtime/utils/safe-try";
import { pretty } from "../runtime/utils/pretty";

export interface TaskContext {
  stepId: string;
  payload: Record<string, unknown>;
}

export interface TaskOutput {
  success: boolean;
  data: Record<string, unknown>;
  error?: string;
}

export class TaskRunner {
  constructor(
    private connectors: Record<
      string,
      (payload: Record<string, unknown>) => Promise<Record<string, unknown>>
    >
  ) {}

  async run(context: TaskContext): Promise<TaskOutput> {
    const connector = this.connectors[context.stepId];

    if (!connector) {
      return {
        success: false,
        data: {},
        error: `task-runner.connector_missing: '${context.stepId}'`,
      };
    }

    const result = await safeTry(() => connector(context.payload));

    if (!result.success) {
      return {
        success: false,
        data: {},
        error: `task-runner.error: ${result.errorMessage}`,
      };
    }

    return {
      success: true,
      data: result.value,
    };
  }
}
