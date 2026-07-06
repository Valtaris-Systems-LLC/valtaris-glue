import { describe, expect, it } from "vitest";
import {
  buildDownstreamJobInserts,
  createDeadLetterPlan,
  deriveRunFinalization,
} from "../../../supabase/functions/run-worker/logic.ts";
import { failingWorkflow, happyPathWorkflow } from "../fixtures/runtimeWorkflows";

describe("run-worker logic", () => {
  it("enqueues downstream work only when dependencies are completed", () => {
    const jobs = buildDownstreamJobInserts({
      graph: happyPathWorkflow,
      jobs: [{ dag_node_id: "ingest", state: "completed" }],
      runId: "run-happy",
      completedNodeId: "ingest",
      runContext: { correlation_id: "corr-happy", tenant_id: "tenant-1", workflow_version_id: "wv-1" },
    });

    expect(jobs).toEqual([
      {
        run_id: "run-happy",
        tenant_id: "tenant-1",
        workflow_version_id: "wv-1",
        dag_node_id: "charge",
        state: "queued",
        max_retries: 4,
        idempotency_key: "run-happy:charge",
        payload: { correlation_id: "corr-happy" },
      },
    ]);
  });

  it("finalizes a completed run once all nodes are completed", () => {
    const finalization = deriveRunFinalization({
      graph: happyPathWorkflow,
      jobs: [
        { dag_node_id: "ingest", state: "completed" },
        { dag_node_id: "charge", state: "completed" },
        { dag_node_id: "notify", state: "completed" },
      ],
      startedAt: "2026-01-01T00:00:00.000Z",
      now: new Date("2026-01-01T00:00:05.000Z"),
    });

    expect(finalization?.update).toMatchObject({
      state: "completed",
      status: "completed",
      duration_ms: 5000,
      result: { nodes: 3 },
    });
    expect(finalization?.event.type).toBe("run.completed");
  });

  it("produces dead-letter state for a failing workflow after retries are exhausted", () => {
    const plan = createDeadLetterPlan({
      jobId: "job-2",
      runId: "run-fail",
      nodeId: failingWorkflow.nodes[1].id,
      nodeName: failingWorkflow.nodes[1].name,
      connector: failingWorkflow.nodes[1].connector,
      nextAttempt: 3,
      tenantId: "tenant-1",
      payload: { order_id: "ord-1" },
      latencyMs: 180,
      error: { kind: "upstream_5xx", retryable: true, message: "carrier outage" },
      now: new Date("2026-01-01T00:00:05.000Z"),
    });

    expect(plan.jobUpdate.state).toBe("dead_letter");
    expect(plan.deadLetterInsert).toMatchObject({
      tenant_id: "tenant-1",
      run_id: "run-fail",
      dag_node_id: "ship",
      attempts: 3,
      last_error: "carrier outage",
    });
    expect(plan.incidentInsert.summary).toContain("dead-lettered");
  });
});
