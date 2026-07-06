import { describe, expect, it } from "vitest";
import { buildRootWorkflowJobs, normalizeExecuteWorkflowRequest } from "../../../supabase/functions/execute-workflow/logic.ts";
import { approvalWorkflow, happyPathWorkflow } from "../fixtures/runtimeWorkflows";

describe("execute-workflow logic", () => {
  it("normalizes workflow execution requests with safe defaults", () => {
    const normalized = normalizeExecuteWorkflowRequest({}, () => "corr-123");

    expect(normalized).toEqual({
      dag_id: "demo.live",
      workflow_name: "Live demo workflow",
      correlation_id: "corr-123",
      payload: {},
      tenant_id: undefined,
    });
  });

  it("enqueues only root DAG nodes for a happy-path workflow", () => {
    const jobs = buildRootWorkflowJobs(happyPathWorkflow, "run-1", "corr-1", "tenant-a", { tenant: "acme" }, "wv-1");

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      run_id: "run-1",
      tenant_id: "tenant-a",
      workflow_version_id: "wv-1",
      dag_node_id: "ingest",
      state: "queued",
      max_retries: 3,
      idempotency_key: "run-1:ingest",
      payload: { correlation_id: "corr-1", tenant: "acme" },
    });
  });

  it("supports approval-gated workflows by still queuing the root step", () => {
    const jobs = buildRootWorkflowJobs(approvalWorkflow, "run-approval", "corr-approval", "tenant-a", {});

    expect(jobs.map((job) => job.dag_node_id)).toEqual(["review"]);
  });
});
