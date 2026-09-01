// src/orchestration/scheduler.ts
// Valtaris Glue — Workflow Scheduler
//
// Provides:
// - delayed execution
// - scheduled workflows
// - interval-based workflows
// - cron-like scheduling (minimal)
//
// This is the foundation for time-based orchestration.

export type ScheduleType = "delay" | "interval" | "cron";

export interface ScheduleConfig {
  type: ScheduleType;
  value: number | string; // ms for delay/interval, cron string for cron
}

export class Scheduler {
  private timers: Record<string, NodeJS.Timeout> = {};

  schedule(
    runId: string,
    config: ScheduleConfig,
    callback: () => void
  ) {
    switch (config.type) {
      case "delay":
        this.timers[runId] = setTimeout(callback, config.value as number);
        break;

      case "interval":
        this.timers[runId] = setInterval(callback, config.value as number);
        break;

      case "cron":
        // Minimal cron: run every minute if "* * * * *"
        if (config.value === "* * * * *") {
          this.timers[runId] = setInterval(callback, 60_000);
        } else {
          throw new Error(
            `scheduler.unsupported_cron: '${config.value}'`
          );
        }
        break;

      default:
        throw new Error(
          `scheduler.invalid_type: '${config.type}'`
        );
    }
  }

  cancel(runId: string) {
    const timer = this.timers[runId];
    if (timer) {
      clearTimeout(timer);
      clearInterval(timer);
      delete this.timers[runId];
    }
  }
}
