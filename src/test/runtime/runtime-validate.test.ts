import { describe, expect, it } from "vitest";
import { buildRuntimeValidationReport } from "../../../supabase/functions/runtime-validate/logic.ts";
import { createRuntimeValidationGateway } from "../support/supabaseEdgeStubs";

describe("runtime validation endpoint logic", () => {
  it("summarizes anomalies from the runtime health checks", async () => {
    const gateway = createRuntimeValidationGateway({
      listOrphanedRuns: async () => [{ id: "run-1" }],
      listRecentCompletedRuns: async () => [{ id: "run-2", workflow_name: "Happy path" }],
      listCheckpointsForRuns: async () => [],
      countActiveRuns: async () => 2,
      countRecentEvents: async () => 0,
    });

    const report = await buildRuntimeValidationReport(gateway, new Date("2026-01-01T00:00:00.000Z"));

    expect(report.summary.error).toBe(2);
    expect(report.summary.warn).toBe(1);
    expect(report.checks.find((check) => check.id === "orphaned_runs")?.count).toBe(1);
    expect(report.checks.find((check) => check.id === "runs_without_checkpoints")?.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "telemetry_gap")?.count).toBe(2);
  });

  it("marks a check as failed when its gateway query throws", async () => {
    const gateway = createRuntimeValidationGateway({
      listQueuePressureJobs: async () => {
        throw new Error("queue lookup failed");
      },
    });

    const report = await buildRuntimeValidationReport(gateway, new Date("2026-01-01T00:00:00.000Z"));
    const queuePressure = report.checks.find((check) => check.id === "queue_pressure");

    expect(queuePressure).toMatchObject({ ok: false, severity: "error", count: -1 });
    expect(queuePressure?.message).toContain("queue lookup failed");
  });
});
